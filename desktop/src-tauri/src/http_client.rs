// 接口调用的 HTTP 客户端，对应 Node 版的 src/httpClient.js。
// 负责超时、重定向、解压、字符集解码、响应大小上限，出错时返回中文说明而不是抛异常。

use std::error::Error as _;
use std::io::Read;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use url::Url;

use crate::js::Obj;

pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

pub struct SendOptions {
    pub method: String,
    pub url: Url,
    /// 保持用户填写的顺序和大小写
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
    pub follow_redirects: bool,
    pub insecure: bool,
}

#[derive(Debug)]
struct Failed {
    code: String,
    message: String,
}

fn failed(code: &str, message: impl Into<String>) -> Failed {
    Failed { code: code.into(), message: message.into() }
}

fn chain_text(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut src = e.source();
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    parts.join(": ")
}

fn io_kind(e: &reqwest::Error) -> Option<std::io::ErrorKind> {
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            return Some(io.kind());
        }
        src = s.source();
    }
    None
}

fn describe(e: &reqwest::Error, url: &Url) -> Failed {
    let host = format!("{}{}", url.host_str().unwrap_or(""), url.port().map(|p| format!(":{}", p)).unwrap_or_default());
    let detail = chain_text(e);
    let lower = detail.to_lowercase();
    if e.is_builder() {
        if lower.contains("header") {
            return failed("ERR_INVALID_CHAR", format!("请求头不合法（请求头的值不能包含中文等非 ASCII 字符）：{}", detail));
        }
        return failed("ERROR", detail);
    }
    match io_kind(e) {
        Some(std::io::ErrorKind::ConnectionRefused) => return failed("ECONNREFUSED", format!("连接被拒绝：{} 没有服务在监听，请检查地址和端口", host)),
        Some(std::io::ErrorKind::ConnectionReset) | Some(std::io::ErrorKind::ConnectionAborted) => {
            return failed("ECONNRESET", "连接被对方关闭（ECONNRESET）")
        }
        Some(std::io::ErrorKind::TimedOut) => return failed("ETIMEDOUT", format!("连接 {} 超时", host)),
        _ => {}
    }
    if lower.contains("dns error") || lower.contains("no such host") || lower.contains("failed to lookup") {
        return failed("ENOTFOUND", format!("找不到主机 {}，请检查地址或 DNS 设置", url.host_str().unwrap_or("")));
    }
    if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("notvalidforname") {
        return failed("CERT_ERROR", format!("HTTPS 证书校验失败：{}。如果是内网自签证书，可以在「设置」里勾选「忽略证书错误」", detail));
    }
    if lower.contains("tls") || lower.contains("handshake") || lower.contains("ssl") {
        return failed("EPROTO", format!("TLS 握手失败：{}。请确认对方是否支持 HTTPS", detail));
    }
    if lower.contains("unreachable") {
        return failed("EHOSTUNREACH", format!("网络不可达：{}", host));
    }
    if lower.contains("invalid http") || lower.contains("parse") {
        return failed("HPE_INVALID", format!("对方返回的不是合法的 HTTP 响应（{}）", detail));
    }
    if e.is_connect() {
        return failed("ECONNECT", format!("无法连接 {}：{}", host, detail));
    }
    failed("ERROR", detail)
}

fn charset_of(content_type: &str) -> String {
    let lower = content_type.to_lowercase();
    lower
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("charset="))
        .next()
        .map(|c| c.trim_matches('"').to_string())
        .unwrap_or_else(|| "utf-8".into())
}

fn is_text_type(ct: &str) -> bool {
    let ct = ct.to_lowercase();
    ct.starts_with("text/") || ["json", "xml", "javascript", "x-www-form-urlencoded", "ecmascript", "graphql", "yaml", "csv"].iter().any(|k| ct.contains(k))
}

/// 返回 (文本, 是否二进制)
fn decode_body(buf: &[u8], content_type: &str) -> (String, bool) {
    if buf.is_empty() {
        return (String::new(), false);
    }
    if !content_type.is_empty() && !is_text_type(content_type) {
        return (String::new(), true);
    }
    if content_type.is_empty() {
        // 没有 Content-Type 时，能按 UTF-8 正常解码的就当作文本
        return match std::str::from_utf8(buf) {
            Ok(s) => (s.to_string(), false),
            Err(_) => (String::new(), true),
        };
    }
    let enc = encoding_rs::Encoding::for_label(charset_of(content_type).as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = enc.decode(buf);
    (text.into_owned(), false)
}

/// 解压到最多 limit 字节。返回 (内容, 是否截断)；解压失败返回错误
fn decompress(raw: &[u8], encoding: &str, limit: usize) -> Result<(Vec<u8>, bool), Failed> {
    let e = encoding.trim().to_lowercase();
    let mut reader: Box<dyn Read> = match e.as_str() {
        "gzip" | "x-gzip" => Box::new(flate2::read::MultiGzDecoder::new(raw)),
        "deflate" => {
            // 大多数服务器发的是 zlib 格式，少数发裸 deflate
            if raw.len() >= 2 && (raw[0] & 0x0f) == 8 && ((raw[0] as u16) << 8 | raw[1] as u16) % 31 == 0 {
                Box::new(flate2::read::ZlibDecoder::new(raw))
            } else {
                Box::new(flate2::read::DeflateDecoder::new(raw))
            }
        }
        "br" => Box::new(brotli_decompressor::Decompressor::new(raw, 64 * 1024)),
        _ => return Ok((raw.to_vec(), false)),
    };
    let mut out = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return Ok((out, false)),
            Ok(n) => {
                if out.len() + n > limit {
                    out.extend_from_slice(&chunk[..limit - out.len()]);
                    return Ok((out, true));
                }
                out.extend_from_slice(&chunk[..n]);
            }
            Err(err) => {
                if out.is_empty() {
                    return Err(failed("DECOMPRESS", format!("响应解压失败（{}）：{}", encoding, err)));
                }
                // 已经解出一部分时（比如原始数据被截断），保留已解出的内容
                return Ok((out, true));
            }
        }
    }
}

fn headers_to_json(h: &HeaderMap) -> Obj {
    let mut out = Obj::new();
    for name in h.keys() {
        let values: Vec<String> = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        let key = name.as_str().to_string();
        let v = if key == "set-cookie" { json!(values) } else { Value::String(values.join(", ")) };
        out.insert(key, v);
    }
    out
}

fn build_headers(list: &[(String, String)]) -> Result<HeaderMap, Failed> {
    let mut map = HeaderMap::new();
    for (k, v) in list {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| failed("ERR_INVALID_HTTP_TOKEN", format!("请求头名称不合法：{}", k)))?;
        let value = HeaderValue::from_str(v).map_err(|_| failed("ERR_INVALID_CHAR", format!("请求头里有非法字符（请求头的值不能包含中文等非 ASCII 字符）：{}", k)))?;
        map.append(name, value);
    }
    Ok(map)
}

fn without(list: &[(String, String)], names: &[&str]) -> Vec<(String, String)> {
    list.iter().filter(|(k, _)| !names.contains(&k.to_lowercase().as_str())).cloned().collect()
}

async fn read_limited(res: &mut reqwest::Response, limit: usize) -> Result<(Vec<u8>, bool), reqwest::Error> {
    let mut buf = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        if buf.len() + chunk.len() > limit {
            buf.extend_from_slice(&chunk[..limit - buf.len()]);
            return Ok((buf, true));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok((buf, false))
}

/// 发送请求。返回和 Node 版一致的 { finalUrl, redirects, timing, response | error }
/// check_url 用于重定向时检查地址，不允许时返回 Err(说明)
pub async fn send_request(opts: SendOptions, check_url: &(dyn Fn(&Url) -> Result<(), String> + Send + Sync)) -> Value {
    let started = Instant::now();
    let timeout = Duration::from_millis(opts.timeout_ms);
    let mut ttfb: Option<u128> = None;
    let mut redirects: Vec<String> = Vec::new();
    let mut url = opts.url.clone();

    let result = tokio::time::timeout(timeout, async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(opts.insecure)
            .http1_title_case_headers()
            .no_proxy()
            .build()
            .map_err(|e| failed("ERROR", e.to_string()))?;
        let mut method = opts.method.clone();
        let mut headers = opts.headers.clone();
        let mut body = opts.body.clone();
        loop {
            let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| failed("ERROR", format!("不支持的请求方法 {}", method)))?;
            let mut req = client.request(m, url.clone()).headers(build_headers(&headers)?);
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            let mut res = req.send().await.map_err(|e| describe(&e, &url))?;
            ttfb = Some(started.elapsed().as_millis());
            let status = res.status().as_u16();
            let location = res.headers().get("location").and_then(|v| v.to_str().ok()).map(String::from);

            if opts.follow_redirects && [301, 302, 303, 307, 308].contains(&status) {
                if let Some(loc) = location {
                    if redirects.len() >= MAX_REDIRECTS {
                        return Err(failed("TOO_MANY_REDIRECTS", format!("重定向次数超过 {} 次，已停止", MAX_REDIRECTS)));
                    }
                    let next = url.join(&loc).map_err(|_| failed("BAD_REDIRECT", format!("不支持重定向到 {}", loc)))?;
                    if next.scheme() != "http" && next.scheme() != "https" {
                        return Err(failed("BAD_REDIRECT", format!("不支持重定向到 {}", next)));
                    }
                    check_url(&next).map_err(|m| failed("NOT_ALLOWED", m))?;
                    // 303 一律改为 GET；301/302 按浏览器的习惯，非 GET/HEAD 也改为 GET
                    let to_get = if status == 303 { method != "HEAD" } else { (status == 301 || status == 302) && method != "GET" && method != "HEAD" };
                    if to_get {
                        method = "GET".into();
                        body = None;
                        headers = without(&headers, &["content-type", "content-length"]);
                    }
                    // 跳到别的主机时不带上认证信息
                    let host_of = |u: &Url| format!("{}:{}", u.host_str().unwrap_or(""), u.port_or_known_default().unwrap_or(0));
                    if host_of(&next) != host_of(&url) {
                        headers = without(&headers, &["authorization", "cookie"]);
                    }
                    headers = without(&headers, &["host"]);
                    redirects.push(next.to_string());
                    url = next;
                    continue;
                }
            }

            let resp_headers = res.headers().clone();
            let content_type = resp_headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let encoding = resp_headers.get("content-encoding").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            let (raw, raw_truncated) = read_limited(&mut res, MAX_RESPONSE_BYTES).await.map_err(|e| describe(&e, &url))?;
            let (buf, dec_truncated) = decompress(&raw, &encoding, MAX_RESPONSE_BYTES)?;
            let (text, binary) = decode_body(&buf, &content_type);
            return Ok(json!({
                "status": status,
                "statusText": status_text,
                "headers": headers_to_json(&resp_headers),
                "body": text,
                "binary": binary,
                "contentType": content_type,
                "size": buf.len(),
                "truncated": raw_truncated || dec_truncated,
            }));
        }
    })
    .await;

    let timing = json!({ "totalMs": started.elapsed().as_millis() as u64, "ttfbMs": ttfb.map(|t| t as u64) });
    let outcome = match result {
        Err(_) => Err(failed("TIMEOUT", format!("请求超时（{} 秒内没有完成）", fmt_secs(opts.timeout_ms)))),
        Ok(r) => r,
    };
    match outcome {
        Ok(response) => json!({ "finalUrl": url.to_string(), "redirects": redirects, "timing": timing, "response": response }),
        Err(f) => json!({ "finalUrl": url.to_string(), "redirects": redirects, "timing": timing, "error": { "code": f.code, "message": f.message } }),
    }
}

fn fmt_secs(ms: u64) -> String {
    crate::js::fmt_num(ms as f64 / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk() {
        let (t, bin) = decode_body(&[0xd6, 0xd0, 0xce, 0xc4], "text/plain; charset=GBK");
        assert_eq!(t, "中文");
        assert!(!bin);
        assert!(decode_body(&[1, 2, 3], "image/png").1);
    }

    #[test]
    fn gzip_roundtrip() {
        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut e = GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(b"{\"zipped\":true}").unwrap();
        let raw = e.finish().unwrap();
        assert_eq!(decompress(&raw, "gzip", 100).unwrap().0, b"{\"zipped\":true}");
        assert!(decompress(&raw, "gzip", 5).unwrap().1);
    }
}
