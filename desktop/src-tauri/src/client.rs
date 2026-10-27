// 接口调用：变量替换、组装请求、访问白名单，对应 Node 版 src/clientRouter.js 的核心逻辑

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use url::Url;

use crate::client_store::{normalize_request_content, normalize_vars, RequestContent, Row};
use crate::js::Obj;
use crate::store::{ApiError, ApiResult};
use crate::template::{is_helper, render_text};

const NO_BODY_METHODS: [&str; 2] = ["GET", "HEAD"];
const DEFAULT_HEADERS: [(&str, &str); 3] = [("User-Agent", "RuiLink/1.0"), ("Accept", "*/*"), ("Accept-Encoding", "gzip, deflate, br")];

/// encodeURIComponent 不编码的字符：A-Z a-z 0-9 - _ . ! ~ * ' ( )
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');

fn encode_component(s: &str) -> String {
    utf8_percent_encode(s, URI_COMPONENT).to_string()
}

// ---------- 访问白名单 ----------

struct HostRule {
    host: Vec<HostPart>,
    port: Option<String>,
}

enum HostPart {
    /// *.example.com 开头的 *：匹配任意层级的子域名
    AnySubdomains,
    Label(String),
}

// 段内的 * 匹配这一段里的一个或多个字符，比如 192.168.1.*
fn glob(p: &[u8], s: &[u8]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(b'*') => (1..=s.len()).any(|i| glob(&p[1..], &s[i..])),
        Some(c) => !s.is_empty() && s[0].eq_ignore_ascii_case(c) && glob(&p[1..], &s[1..]),
    }
}

fn label_match(pattern: &str, label: &str) -> bool {
    glob(pattern.as_bytes(), label.as_bytes())
}

impl HostRule {
    fn matches(&self, host: &str, port: &str) -> bool {
        if let Some(p) = &self.port {
            if p != port {
                return false;
            }
        }
        let labels: Vec<&str> = if host.starts_with('[') { vec![host] } else { host.split('.').collect() };
        match self.host.first() {
            Some(HostPart::AnySubdomains) => {
                let rest: Vec<&String> = self.host[1..].iter().filter_map(|h| if let HostPart::Label(l) = h { Some(l) } else { None }).collect();
                if labels.len() <= rest.len() {
                    return false;
                }
                let tail = &labels[labels.len() - rest.len()..];
                tail.iter().zip(rest).all(|(l, p)| label_match(p, l))
            }
            _ => {
                let pats: Vec<&String> = self.host.iter().filter_map(|h| if let HostPart::Label(l) = h { Some(l) } else { None }).collect();
                labels.len() == pats.len() && labels.iter().zip(pats).all(|(l, p)| label_match(p, l))
            }
        }
    }
}

fn parse_allow_hosts(spec: &str) -> Result<Vec<HostRule>, String> {
    let mut out = Vec::new();
    for item in spec.split(|c: char| c == ',' || c == '，' || c.is_whitespace()).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
        // host、host:port，IPv6 地址写在方括号里：[::1]:8080
        let (host, port) = if item.starts_with('[') {
            match item.find(']') {
                Some(end) => (item[..=end].to_string(), item[end + 1..].strip_prefix(':').map(String::from)),
                None => return Err(format!("PROXY_ALLOW_HOSTS 中的「{}」格式不正确", item)),
            }
        } else {
            match item.split_once(':') {
                Some((h, p)) => (h.to_string(), Some(p.to_string())),
                None => (item.clone(), None),
            }
        };
        let bad_port = port.as_ref().is_some_and(|p| p.is_empty() || (p != "*" && !p.chars().all(|c| c.is_ascii_digit())));
        if bad_port || host.is_empty() {
            return Err(format!("PROXY_ALLOW_HOSTS 中的「{}」格式不正确", item));
        }
        let parts = if host.starts_with('[') {
            vec![HostPart::Label(host)]
        } else {
            let mut v = Vec::new();
            let mut rest = host.as_str();
            if let Some(r) = rest.strip_prefix("*.") {
                v.push(HostPart::AnySubdomains);
                rest = r;
            }
            v.extend(rest.split('.').map(|l| HostPart::Label(l.to_string())));
            v
        };
        out.push(HostRule { host: parts, port: port.filter(|p| p != "*") });
    }
    Ok(out)
}

pub fn validate_allow_hosts(spec: &str) -> Result<(), String> {
    parse_allow_hosts(spec).map(|_| ())
}

/// 返回检查函数：允许时 Ok，不允许时 Err(说明)
pub fn host_checker(spec: &str, self_origin: &str) -> impl Fn(&Url) -> Result<(), String> + Send + Sync + 'static {
    let rules = parse_allow_hosts(spec).unwrap_or_default();
    let self_origin = self_origin.to_string();
    move |url: &Url| {
        if url.origin().ascii_serialization() == self_origin || rules.is_empty() {
            return Ok(());
        }
        let host = url.host_str().unwrap_or("").to_lowercase();
        let port = url.port_or_known_default().map(|p| p.to_string()).unwrap_or_default();
        if rules.iter().any(|r| r.matches(&host, &port)) {
            return Ok(());
        }
        Err(format!("地址 {}:{} 不在允许访问的范围内（由 PROXY_ALLOW_HOSTS 设置）", host, port))
    }
}

// ---------- 变量替换与组装请求 ----------

pub struct Prepared {
    pub method: String,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub insecure: bool,
}

impl Prepared {
    pub fn sent_view(&self) -> Value {
        let mut h = Obj::new();
        for (k, v) in &self.headers {
            h.insert(k.clone(), Value::String(v.clone()));
        }
        json!({ "method": self.method, "url": self.url.to_string(), "headers": h, "body": self.body })
    }
}

fn variables_to_context(vars: Option<&Value>) -> Obj {
    let mut ctx = Obj::new();
    for v in normalize_vars(vars, false).unwrap_or_default() {
        if v.enabled {
            ctx.insert(v.key, Value::String(v.value));
        }
    }
    ctx
}

fn used_strings(req: &RequestContent) -> Vec<String> {
    let rows = |list: &[Row]| list.iter().filter(|r| r.enabled).flat_map(|r| [r.key.clone(), r.value.clone()]).collect::<Vec<_>>();
    let mut out = vec![req.url.clone()];
    out.extend(rows(&req.params));
    out.extend(rows(&req.headers));
    match req.body.mode.as_str() {
        "json" => out.push(req.body.json.clone()),
        "raw" => {
            out.push(req.body.raw.clone());
            out.push(req.body.raw_type.clone());
        }
        "form" => out.extend(rows(&req.body.form)),
        _ => {}
    }
    out
}

/// 找出 {{name}} 这种简单写法里没有定义的变量
fn find_missing_vars(req: &RequestContent, ctx: &Obj) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for s in used_strings(req) {
        let mut rest = s.as_str();
        while let Some(start) = rest.find("{{") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else { break };
            let name = after[..end].trim();
            let simple = !name.is_empty()
                && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
            if simple && !is_helper(name) && !ctx.contains_key(name) && !missing.iter().any(|m| m == name) {
                missing.push(name.to_string());
            }
            rest = &after[end + 2..];
        }
    }
    missing
}

fn resolve_url(raw: &str, self_origin: &str) -> ApiResult<Url> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(ApiError::new("请填写请求地址"));
    }
    let has_scheme = {
        let mut chars = s.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && s.find("://").is_some_and(|i| s[..i].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
    };
    let full = if s.starts_with('/') {
        format!("{}{}", self_origin, s)
    } else if has_scheme {
        s.to_string()
    } else {
        format!("http://{}", s)
    };
    let mut url = Url::parse(&full).map_err(|_| ApiError::new(format!("请求地址格式不正确：{}", s)))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ApiError::new(format!("只支持 http 和 https 地址：{}", s)));
    }
    url.set_fragment(None);
    Ok(url)
}

/// 把编辑器里的请求（含 {{变量}}）变成真正要发出去的请求。有问题时返回 400
pub fn prepare_request(input: Option<&Value>, variables: Option<&Value>, self_origin: &str, env_name: &str) -> ApiResult<Prepared> {
    let req = normalize_request_content(input);
    let ctx = variables_to_context(variables);
    let missing = find_missing_vars(&req, &ctx);
    if !missing.is_empty() {
        let env = if env_name.is_empty() { "当前没有选择环境".to_string() } else { format!("当前环境：{}", env_name) };
        return Err(ApiError::new(format!("变量未定义：{}（{}）", missing.join("、"), env)));
    }
    let render = |s: &str| render_text(s, &ctx).map_err(|e| ApiError::new(format!("变量替换出错：{}", e.0)));

    let mut url = resolve_url(&render(&req.url)?, self_origin)?;
    let params: Vec<&Row> = req.params.iter().filter(|p| p.enabled && !p.key.trim().is_empty()).collect();
    if !params.is_empty() {
        let mut parts = Vec::new();
        for p in params {
            parts.push(format!("{}={}", encode_component(&render(&p.key)?), encode_component(&render(&p.value)?)));
        }
        let qs = parts.join("&");
        let next = match url.query() {
            Some(q) if !q.is_empty() => format!("{}&{}", q, qs),
            _ => qs,
        };
        url.set_query(Some(&next));
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    let set_header = |headers: &mut Vec<(String, String)>, name: String, value: String| {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case(&name));
        headers.push((name, value));
    };
    for h in &req.headers {
        if h.enabled && !h.key.trim().is_empty() {
            set_header(&mut headers, render(&h.key)?.trim().to_string(), render(&h.value)?);
        }
    }
    let has_header = |headers: &Vec<(String, String)>, name: &str| headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name));

    let mut body = None;
    if !NO_BODY_METHODS.contains(&req.method.as_str()) {
        let (b, content_type) = match req.body.mode.as_str() {
            "json" => (Some(render(&req.body.json)?), Some("application/json".to_string())),
            "form" => {
                let mut ser = form_urlencoded::Serializer::new(String::new());
                for f in &req.body.form {
                    if f.enabled && !f.key.trim().is_empty() {
                        ser.append_pair(&render(&f.key)?, &render(&f.value)?);
                    }
                }
                (Some(ser.finish()), Some("application/x-www-form-urlencoded".to_string()))
            }
            "raw" => (Some(render(&req.body.raw)?), Some(render(&req.body.raw_type)?)),
            _ => (None, None),
        };
        if let (Some(_), Some(ct)) = (&b, content_type) {
            if !ct.is_empty() && !has_header(&headers, "content-type") {
                headers.push(("Content-Type".into(), ct));
            }
        }
        body = b;
    }
    for (k, v) in DEFAULT_HEADERS {
        if !has_header(&headers, k) {
            headers.push((k.into(), v.into()));
        }
    }
    Ok(Prepared {
        method: req.method,
        url,
        headers,
        body,
        timeout_ms: req.options.timeout as u64,
        follow_redirects: req.options.follow_redirects,
        insecure: req.options.insecure,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Value {
        Value::Array(pairs.iter().map(|(k, v)| json!({ "key": k, "value": v, "enabled": true })).collect())
    }

    #[test]
    fn prepare_basic() {
        let p = prepare_request(
            Some(&json!({
                "method": "POST",
                "url": "{{baseUrl}}/api/x?a=1",
                "params": [{ "key": "q", "value": "中 文", "enabled": true }, { "key": "off", "value": "1", "enabled": false }],
                "headers": [{ "key": "X-Token", "value": "Bearer {{token}}", "enabled": true }],
                "body": { "mode": "json", "json": "{\"qty\": {{qty}}}" }
            })),
            Some(&vars(&[("baseUrl", "http://h:8080"), ("token", "abc"), ("qty", "10")])),
            "http://127.0.0.1:1",
            "",
        )
        .unwrap();
        assert_eq!(p.url.as_str(), "http://h:8080/api/x?a=1&q=%E4%B8%AD%20%E6%96%87");
        assert_eq!(p.headers[0], ("X-Token".to_string(), "Bearer abc".to_string()));
        assert_eq!(p.body.as_deref(), Some("{\"qty\": 10}"));
        assert!(p.headers.iter().any(|(k, v)| k == "Content-Type" && v == "application/json"));
    }

    #[test]
    fn missing_vars() {
        let e = prepare_request(Some(&json!({ "url": "{{x}}/a" })), None, "", "").err().unwrap();
        assert!(e.message.contains("变量未定义：x（当前没有选择环境）"));
    }

    #[test]
    fn urls_and_form() {
        assert_eq!(prepare_request(Some(&json!({ "url": "/wms/a" })), None, "http://127.0.0.1:3000", "").unwrap().url.as_str(), "http://127.0.0.1:3000/wms/a");
        assert_eq!(prepare_request(Some(&json!({ "url": "10.0.0.1:81/a" })), None, "", "").unwrap().url.as_str(), "http://10.0.0.1:81/a");
        let f = prepare_request(Some(&json!({ "method": "POST", "url": "h", "body": { "mode": "form", "form": [{ "key": "a", "value": "1 2" }, { "key": "b", "value": "&" }] } })), None, "", "").unwrap();
        assert_eq!(f.body.as_deref(), Some("a=1+2&b=%26"));
        assert!(prepare_request(Some(&json!({ "url": "ftp://h/x" })), None, "", "").is_err());
    }

    #[test]
    fn allow_hosts() {
        let c = host_checker("192.168.1.*,*.corp.com,wms:8080,[::1]", "");
        for (u, ok) in [
            ("http://192.168.1.5/", true),
            ("http://192.168.1.5.evil.com/", false),
            ("http://a.b.corp.com/", true),
            ("http://corp.com/", false),
            ("http://wms:8080/", true),
            ("http://wms/", false),
            ("http://[::1]:9/", true),
        ] {
            assert_eq!(c(&Url::parse(u).unwrap()).is_ok(), ok, "{}", u);
        }
    }
}
