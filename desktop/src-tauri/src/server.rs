// 内置服务，对应 Node 版的 src/app.js：管理接口、请求日志、模拟接口处理、静态页面。
// 用一个 fallback 处理函数手动分发路由，和 Express 的匹配顺序保持一致：
//   /__health → /__admin/api/* → /__admin/ 静态文件 → 模拟接口

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{to_bytes, Body};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};

use crate::client::{host_checker, prepare_request};
use crate::client_store::ClientStore;
use crate::engine::{find_mock, match_scenario, validate_rules};
use crate::http_client::{send_request, SendOptions};
use crate::js::{get, js_string, new_id, now_iso, parse_json, stringify, text, Obj};
use crate::store::{ApiError, ApiResult, Store};
use crate::template::{render_body, render_string, HELPER_NAMES};

static PUBLIC: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../public");
const SEEDS: &str = include_str!("../seeds.json");

const LOG_LIMIT: usize = 300;
const LOG_BODY_LIMIT: usize = 20000;
const BODY_LIMIT: usize = 10 * 1024 * 1024;

pub struct Config {
    pub admin_token: String,
    pub client_enabled: bool,
    pub allow_hosts: String,
    pub port: u16,
}

pub struct AppState {
    pub store: Mutex<Store>,
    pub client: Mutex<ClientStore>,
    pub log: Mutex<VecDeque<Value>>,
    pub cfg: Config,
    pub desktop: Option<crate::desktop::DesktopCtx>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn open(data_dir: &Path, cfg: Config, desktop: Option<crate::desktop::DesktopCtx>) -> Result<Arc<Self>, String> {
        let seeds: Value = serde_json::from_str(SEEDS).map_err(|e| e.to_string())?;
        let store = Store::open(data_dir.join("mocks.json"), &seeds)?;
        let client = ClientStore::open(data_dir.join("client.json"), data_dir.join("records.json"))?;
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
        Ok(Arc::new(AppState { store: Mutex::new(store), client: Mutex::new(client), log: Mutex::new(VecDeque::new()), cfg, desktop, http }))
    }

    /// 接口调用会让本机替人访问内网地址，必须设置管理口令才能使用
    fn client_status(&self) -> (bool, &'static str) {
        if !self.cfg.client_enabled {
            return (false, "接口调用功能已被关闭（CLIENT_ENABLED=false）");
        }
        if self.cfg.admin_token.is_empty() {
            return (false, "接口调用功能需要先设置管理口令 ADMIN_TOKEN，设置方法见 README");
        }
        (true, "")
    }
}

pub async fn serve(listener: tokio::net::TcpListener, state: Arc<AppState>) {
    let app = Router::new().fallback(handle).with_state(state);
    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await {
        eprintln!("服务异常退出：{}", e);
    }
}

// ---------- 响应工具 ----------

fn json_resp(status: u16, v: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .body(Body::from(stringify(v)))
        .unwrap()
}

fn no_content() -> Response {
    Response::builder().status(204).body(Body::empty()).unwrap()
}

fn api_error(e: &ApiError) -> Response {
    json_resp(e.status, &json!({ "message": e.message }))
}

fn reply(r: ApiResult<Value>, ok_status: u16) -> Response {
    match r {
        Ok(v) => json_resp(ok_status, &v),
        Err(e) => api_error(&e),
    }
}

fn to_value<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

fn redirect(status: u16, location: &str) -> Response {
    Response::builder()
        .status(status)
        .header("location", location)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Body::from(format!("Found. Redirecting to {}", location)))
        .unwrap()
}

fn header_str(h: &HeaderMap, name: &str) -> String {
    h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Node 的 req.headers：名称小写，同名的用 ", " 连接（cookie 用 "; "，set-cookie 为数组）
fn headers_json(h: &HeaderMap) -> Obj {
    let mut out = Obj::new();
    for name in h.keys() {
        let values: Vec<String> = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        let key = name.as_str().to_string();
        let v = match key.as_str() {
            "set-cookie" => json!(values),
            "cookie" => Value::String(values.join("; ")),
            _ => Value::String(values.join(", ")),
        };
        out.insert(key, v);
    }
    out
}

fn decode_text(bytes: &[u8], content_type: &str) -> String {
    let label = content_type
        .to_lowercase()
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("charset=").map(|c| c.trim_matches('"').to_string()))
        .next()
        .unwrap_or_else(|| "utf-8".into());
    let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    enc.decode(bytes).0.into_owned()
}

fn url_decode(s: &str) -> String {
    let replaced = s.replace('+', " ");
    percent_encoding::percent_decode_str(&replaced).decode_utf8_lossy().into_owned()
}

/// Express 默认的查询参数解析（qs）：同名参数变成数组，a[b]=1 变成嵌套对象
fn parse_query(raw: &str) -> Obj {
    let mut out = Obj::new();
    for pair in raw.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = url_decode(k);
        let value = Value::String(url_decode(v));
        if key.is_empty() {
            continue;
        }
        let (root, rest) = match key.find('[') {
            Some(i) if i > 0 && key.ends_with(']') => (key[..i].to_string(), key[i..].to_string()),
            _ => (key.clone(), String::new()),
        };
        let segs: Vec<String> = if rest.is_empty() { vec![] } else { rest.trim_start_matches('[').trim_end_matches(']').split("][").map(String::from).collect() };
        assign(&mut out, &root, &segs, value);
    }
    out
}

fn assign(obj: &mut Obj, key: &str, segs: &[String], value: Value) {
    if segs.is_empty() {
        match obj.get_mut(key) {
            None => {
                obj.insert(key.into(), value);
            }
            Some(Value::Array(a)) => a.push(value),
            Some(existing) => {
                let prev = existing.take();
                *existing = Value::Array(vec![prev, value]);
            }
        }
        return;
    }
    let (first, rest) = (&segs[0], &segs[1..]);
    if first.is_empty() && rest.is_empty() {
        match obj.get_mut(key) {
            Some(Value::Array(a)) => a.push(value),
            Some(existing) => {
                let prev = existing.take();
                *existing = Value::Array(vec![prev, value]);
            }
            None => {
                obj.insert(key.into(), Value::Array(vec![value]));
            }
        }
        return;
    }
    let entry = obj.entry(key.to_string()).or_insert_with(|| Value::Object(Obj::new()));
    if !entry.is_object() {
        *entry = Value::Object(Obj::new());
    }
    assign(entry.as_object_mut().unwrap(), first, rest, value);
}

// ---------- 入口 ----------

async fn handle(State(st): State<Arc<AppState>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let path = parts.uri.path().to_string();
    let raw_query = parts.uri.query().unwrap_or("").to_string();
    let original_url = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| path.clone());
    let bytes = match to_bytes(body, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => return json_resp(413, &json!({ "code": "413", "msg": "request entity too large", "data": null })),
    };
    let ip = forwarded_ip(&parts.headers).unwrap_or_else(|| addr.ip().to_string());

    if path == "/__health" && method == Method::GET {
        return json_resp(200, &json!({ "status": "ok" }));
    }
    if path == "/__admin/api" || path.starts_with("/__admin/api/") {
        if let Some(resp) = admin(&st, &method, &path["/__admin/api".len()..], &raw_query, &parts.headers, &bytes).await {
            return resp;
        }
    } else if path == "/__admin" && (method == Method::GET || method == Method::HEAD) {
        return redirect(301, "/__admin/");
    } else if path.starts_with("/__admin/") && (method == Method::GET || method == Method::HEAD) {
        if let Some(resp) = static_file(&path["/__admin/".len()..]) {
            return resp;
        }
    }
    let mut resp = mock(&st, &method, &path, &raw_query, &original_url, &parts.headers, &bytes, &ip).await;
    // 允许浏览器跨域调用模拟接口
    let origin = header_str(&parts.headers, "origin");
    let h = resp.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_str(if origin.is_empty() { "*" } else { &origin }).unwrap_or(HeaderValue::from_static("*")));
    h.insert("access-control-allow-credentials", HeaderValue::from_static("true"));
    resp
}

fn forwarded_ip(h: &HeaderMap) -> Option<String> {
    let v = header_str(h, "x-forwarded-for");
    v.split(',').next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn static_file(rel: &str) -> Option<Response> {
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let file = PUBLIC.get_file(rel)?;
    let ct = match rel.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=UTF-8",
        "js" => "application/javascript; charset=UTF-8",
        "css" => "text/css; charset=UTF-8",
        "json" => "application/json; charset=UTF-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    Some(Response::builder().status(200).header("content-type", ct).header("cache-control", "no-cache").body(Body::from(file.contents())).unwrap())
}

// ---------- 管理接口 ----------

fn parse_admin_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, Response> {
    let ct = header_str(headers, "content-type").to_lowercase();
    if !ct.contains("json") || bytes.is_empty() {
        return Ok(json!({}));
    }
    let text = String::from_utf8_lossy(bytes);
    let t = text.trim_start();
    if t.is_empty() {
        return Ok(json!({}));
    }
    // 和 Express 的 express.json 一样只接受对象和数组
    if !(t.starts_with('{') || t.starts_with('[')) {
        return Err(json_resp(400, &json!({ "message": "请求内容不是合法的 JSON" })));
    }
    parse_json(t).map_err(|_| json_resp(400, &json!({ "message": "请求内容不是合法的 JSON" })))
}

fn same_token(given: &str, expected: &str) -> bool {
    // 逐字节比较全部内容，耗时不随第一个不同字符的位置变化
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    let mut diff = (a.len() != b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

fn segments(sub: &str) -> Vec<String> {
    sub.trim_matches('/').split('/').filter(|s| !s.is_empty()).map(url_decode_path).collect()
}

fn url_decode_path(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

fn query_param(raw: &str, key: &str) -> String {
    parse_query(raw).get(key).map(|v| text(Some(v), "")).unwrap_or_default()
}

/// 返回 None 表示没有匹配的管理接口，交给后面的模拟接口处理（和 Express 一样会得到 404）
async fn admin(st: &Arc<AppState>, method: &Method, sub: &str, raw_query: &str, headers: &HeaderMap, bytes: &[u8]) -> Option<Response> {
    let body = match parse_admin_body(headers, bytes) {
        Ok(b) => b,
        Err(resp) => return Some(resp),
    };
    let seg = segments(sub);
    let seg: Vec<&str> = seg.iter().map(|s| s.as_str()).collect();
    let m = method.as_str();

    if m == "GET" && seg == ["info"] {
        let (enabled, reason) = st.client_status();
        let mut info = json!({
            "authRequired": !st.cfg.admin_token.is_empty(),
            "mockCount": st.store.lock().unwrap().list().len(),
            "client": { "enabled": enabled, "reason": reason },
        });
        if let Some(d) = &st.desktop {
            info["desktop"] = d.info();
        }
        return Some(json_resp(200, &info));
    }
    if !st.cfg.admin_token.is_empty() && !same_token(&header_str(headers, "x-admin-token"), &st.cfg.admin_token) {
        return Some(json_resp(401, &json!({ "message": "管理口令错误" })));
    }

    if seg.first() == Some(&"desktop") {
        if let Some(d) = &st.desktop {
            return Some(d.handle(st, m, &seg[1..], &body).await);
        }
        return None;
    }

    // 连接服务器模式：除了在本机发送请求，其余管理接口都转发到远端服务器
    if let Some((remote, token)) = st.desktop.as_ref().and_then(|d| d.remote()) {
        let local_only = seg.first() == Some(&"client") && (seg.get(1) == Some(&"send") || seg.get(1) == Some(&"preview"));
        if !local_only {
            let patch_allow_hosts = m == "GET" && seg == ["client"];
            return Some(crate::desktop::proxy(&st.http, &remote, &token, m, sub, raw_query, bytes, headers, patch_allow_hosts).await);
        }
    }

    if seg.first() == Some(&"client") {
        let (enabled, reason) = st.client_status();
        if !enabled {
            return Some(json_resp(403, &json!({ "message": reason })));
        }
        return client_routes(st, m, &seg[1..], &body).await;
    }

    let r = match (m, seg.as_slice()) {
        ("GET", ["mocks"]) => json_resp(200, &to_value(st.store.lock().unwrap().list())),
        ("GET", ["mocks", id]) => match st.store.lock().unwrap().get(id) {
            Some(mock) => json_resp(200, &to_value(mock)),
            None => api_error(&ApiError::with(404, "接口不存在")),
        },
        ("POST", ["mocks"]) => reply(st.store.lock().unwrap().create(&body).map(to_value), 201),
        ("PUT", ["mocks", id]) => reply(st.store.lock().unwrap().update(id, &body).map(to_value), 200),
        ("DELETE", ["mocks", id]) => match st.store.lock().unwrap().remove(id) {
            Ok(()) => no_content(),
            Err(e) => api_error(&e),
        },
        ("GET", ["logs"]) => {
            let limit = crate::js::parse_int(Some(&Value::String(query_param(raw_query, "limit")))).filter(|n| *n != 0).unwrap_or(100).min(LOG_LIMIT as i64).max(0) as usize;
            let mock_id = query_param(raw_query, "mockId");
            let log = st.log.lock().unwrap();
            let items: Vec<&Value> =
                log.iter().filter(|e| mock_id.is_empty() || e.get("mock").and_then(|m| m.get("id")).and_then(|v| v.as_str()) == Some(mock_id.as_str())).take(limit).collect();
            json_resp(200, &json!(items))
        }
        ("DELETE", ["logs"]) => {
            st.log.lock().unwrap().clear();
            no_content()
        }
        // 导出接口配置和接口调用的集合、请求；环境变量可能包含 token，不导出
        ("GET", ["export"]) => json_resp(
            200,
            &json!({
                "version": 2,
                "exportedAt": now_iso(),
                "mocks": st.store.lock().unwrap().list(),
                "client": st.client.lock().unwrap().export_data(),
            }),
        ),
        // 文件里没有 client 时不动现有的集合和请求，覆盖导入也一样
        ("POST", ["import"]) => {
            let mode = if get(&body, "mode").and_then(|v| v.as_str()) == Some("replace") { "replace" } else { "merge" };
            let mut client = st.client.lock().unwrap();
            let mut store = st.store.lock().unwrap();
            let mut run = || -> ApiResult<Value> {
                let client_import = match get(&body, "client") {
                    Some(c) if crate::js::truthy(Some(c)) => Some(client.prepare_import(c, mode)?),
                    _ => None,
                };
                let (next, count) = store.prepare_import(get(&body, "mocks"), mode)?;
                store.commit_import(next)?;
                let (cols, reqs) = match client_import {
                    Some(p) => {
                        let counts = (p.collection_count, p.request_count);
                        client.commit_import(p)?;
                        counts
                    }
                    None => (0, 0),
                };
                Ok(json!({ "count": count, "collections": cols, "requests": reqs }))
            };
            reply(run(), 200)
        }
        _ => return None,
    };
    Some(r)
}

async fn client_routes(st: &Arc<AppState>, m: &str, seg: &[&str], body: &Value) -> Option<Response> {
    let r = match (m, seg) {
        ("GET", []) => {
            let mut snap = st.client.lock().unwrap().snapshot();
            snap["allowHosts"] = json!(st.cfg.allow_hosts);
            snap["helpers"] = json!(HELPER_NAMES);
            json_resp(200, &snap)
        }
        ("POST", ["collections"]) => reply(st.client.lock().unwrap().create_collection(body).map(to_value), 201),
        ("PUT", ["collections", id]) => reply(st.client.lock().unwrap().update_collection(id, body).map(to_value), 200),
        ("DELETE", ["collections", id]) => match st.client.lock().unwrap().remove_collection(id) {
            Ok(()) => no_content(),
            Err(e) => api_error(&e),
        },
        ("POST", ["requests"]) => reply(st.client.lock().unwrap().create_request(body).map(to_value), 201),
        ("PUT", ["requests", id]) => reply(st.client.lock().unwrap().update_request(id, body).map(to_value), 200),
        ("DELETE", ["requests", id]) => match st.client.lock().unwrap().remove_request(id) {
            Ok(()) => no_content(),
            Err(e) => api_error(&e),
        },
        ("PUT", ["environments"]) => reply(st.client.lock().unwrap().set_environments(get(body, "environments")).map(to_value), 200),
        // 只做变量替换，不发送，用于「复制 curl」
        ("POST", ["preview"]) => {
            let env_name = text(get(body, "envName"), "");
            match prepare_request(get(body, "request"), get(body, "variables"), &self_origin(st), &env_name) {
                Ok(p) => json_resp(200, &json!({ "sent": p.sent_view() })),
                Err(e) => api_error(&e),
            }
        }
        ("POST", ["send"]) => send(st, body).await,
        ("GET", ["records"]) => json_resp(200, &json!(st.client.lock().unwrap().list_records())),
        ("GET", ["records", id]) => match st.client.lock().unwrap().get_record(id) {
            Ok(r) => json_resp(200, &to_value(r)),
            Err(e) => api_error(&e),
        },
        ("POST", ["records"]) => reply(st.client.lock().unwrap().create_record(body), 201),
        ("PUT", ["records", id]) => reply(st.client.lock().unwrap().update_record(id, body), 200),
        ("DELETE", ["records", id]) => match st.client.lock().unwrap().remove_record(id) {
            Ok(()) => no_content(),
            Err(e) => api_error(&e),
        },
        _ => return None,
    };
    Some(r)
}

/// 相对地址指向哪里：本地工作区是本机服务，连接服务器时是远端服务器
fn self_origin(st: &AppState) -> String {
    if let Some((remote, _)) = st.desktop.as_ref().and_then(|d| d.remote()) {
        if let Ok(u) = url::Url::parse(&remote) {
            return u.origin().ascii_serialization();
        }
    }
    format!("http://127.0.0.1:{}", st.cfg.port)
}

async fn send(st: &Arc<AppState>, body: &Value) -> Response {
    let origin = self_origin(st);
    let env_name = text(get(body, "envName"), "");
    let prepared = match prepare_request(get(body, "request"), get(body, "variables"), &origin, &env_name) {
        Ok(p) => p,
        Err(e) => return api_error(&e),
    };
    let check = host_checker(&st.cfg.allow_hosts, &origin);
    if let Err(msg) = check(&prepared.url) {
        return api_error(&ApiError::with(403, msg));
    }
    let sent = prepared.sent_view();
    let result = send_request(
        SendOptions {
            method: prepared.method,
            url: prepared.url,
            headers: prepared.headers,
            body: prepared.body,
            timeout_ms: prepared.timeout_ms,
            follow_redirects: prepared.follow_redirects,
            insecure: prepared.insecure,
        },
        &check,
    )
    .await;
    let mut out = json!({ "sent": sent });
    if let Value::Object(r) = result {
        for (k, v) in r {
            out[k] = v;
        }
    }
    json_resp(200, &out)
}

// ---------- 模拟接口 ----------

fn truncate_log(s: &str) -> String {
    let n = s.chars().count();
    if n > LOG_BODY_LIMIT {
        format!("{}\n...（已截断，共 {} 字符）", s.chars().take(LOG_BODY_LIMIT).collect::<String>(), n)
    } else {
        s.to_string()
    }
}

/// 返回 (body, 是否 JSON, 原文)
fn parse_body(raw: &str, content_type: &str) -> (Value, bool) {
    if raw.is_empty() {
        return (json!({}), true);
    }
    if content_type.to_lowercase().contains("application/x-www-form-urlencoded") {
        let mut o = Obj::new();
        for (k, v) in form_urlencoded::parse(raw.as_bytes()) {
            o.insert(k.into_owned(), Value::String(v.into_owned()));
        }
        return (Value::Object(o), false);
    }
    match parse_json(raw) {
        Ok(v) => (v, true),
        Err(_) => (Value::String(raw.to_string()), false),
    }
}

/// 和 Express 的 res.send 一样，文本响应的 Content-Type 一律带上 charset=utf-8
fn with_utf8_charset(ct: &str) -> String {
    let mut parts: Vec<String> = ct.split(';').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ct.to_string();
    }
    parts.retain(|p| !p.to_lowercase().starts_with("charset="));
    parts.push("charset=utf-8".into());
    parts.join("; ")
}

#[allow(clippy::too_many_arguments)]
async fn mock(st: &Arc<AppState>, method: &Method, path: &str, raw_query: &str, original_url: &str, req_headers: &HeaderMap, bytes: &[u8], ip: &str) -> Response {
    if method == Method::OPTIONS {
        let origin = header_str(req_headers, "origin");
        let allow_headers = header_str(req_headers, "access-control-request-headers");
        return Response::builder()
            .status(204)
            .header("access-control-allow-origin", if origin.is_empty() { "*".to_string() } else { origin })
            .header("access-control-allow-credentials", "true")
            .header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
            .header("access-control-allow-headers", if allow_headers.is_empty() { "*".to_string() } else { allow_headers })
            .body(Body::empty())
            .unwrap();
    }

    let started = Instant::now();
    let content_type = header_str(req_headers, "content-type");
    let raw = decode_text(bytes, &content_type);
    let (body, is_json) = parse_body(&raw, &content_type);
    let query = parse_query(raw_query);
    let headers_obj = headers_json(req_headers);
    let found = {
        let store = st.store.lock().unwrap();
        find_mock(store.list(), method.as_str(), path).map(|(m, p)| (m.clone(), p))
    };

    if found.is_none() && method == Method::GET && path == "/" {
        return redirect(302, "/__admin/");
    }

    let mut out_headers: Vec<(String, String)> = Vec::new();
    let (status, output, is_json_output, hit) = match &found {
        None => (404, stringify(&json!({ "code": "404", "msg": format!("未找到匹配的接口: {} {}", method, path), "data": null })), true, "未匹配".to_string()),
        Some((mock, params)) => {
            let mut ctx = Obj::new();
            ctx.insert("body".into(), body.clone());
            ctx.insert("query".into(), Value::Object(query.clone()));
            ctx.insert("params".into(), Value::Object(params.clone()));
            ctx.insert("headers".into(), Value::Object(headers_obj.clone()));
            ctx.insert("method".into(), json!(method.as_str()));
            ctx.insert("path".into(), json!(path));
            let result: Result<(i64, String, bool, String, Vec<(String, String)>), String> = async {
                // 顺序：条件场景 → 参数校验 → 默认返回
                let mut scenario = None;
                for s in &mock.scenarios {
                    if match_scenario(s, &ctx).map_err(|e| e.0)? {
                        scenario = Some(s);
                        break;
                    }
                }
                let (resp, hit) = match scenario {
                    Some(s) => (&s.response, format!("场景：{}", s.name)),
                    None => {
                        let errors = validate_rules(&mock.rules, &ctx, is_json);
                        if errors.is_empty() {
                            (&mock.response, "默认返回".to_string())
                        } else {
                            ctx.insert("error".into(), json!(errors.join("；")));
                            ctx.insert("errors".into(), json!(errors));
                            (&mock.validation_response, "参数校验失败".to_string())
                        }
                    }
                };
                if mock.delay > 0 {
                    tokio::time::sleep(Duration::from_millis(mock.delay as u64)).await;
                }
                let (rendered, json_out) = render_body(&resp.body, &ctx).map_err(|e| e.0)?;
                let mut hs = Vec::new();
                for (k, v) in &resp.headers {
                    let value = render_string(&text(Some(v), ""), &ctx).map_err(|e| e.0)?;
                    let value = match value {
                        None | Some(Value::Null) => String::new(),
                        other => js_string(other.as_ref()),
                    };
                    hs.push((k.clone(), value));
                }
                Ok((resp.status, rendered, json_out, hit, hs))
            }
            .await;
            match result {
                Ok((s, o, j, h, hs)) => {
                    out_headers = hs;
                    (s, o, j, h)
                }
                Err(msg) => (500, stringify(&json!({ "code": "500", "msg": format!("返回值模板出错：{}", msg), "data": null })), true, "模板错误".to_string()),
            }
        }
    };

    if !out_headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        out_headers.push(("Content-Type".into(), if is_json_output { "application/json; charset=utf-8".into() } else { "text/plain; charset=utf-8".into() }));
    }
    let mut builder = Response::builder().status(StatusCode::from_u16(status as u16).unwrap_or(StatusCode::OK));
    let mut header_obj = Obj::new();
    for (k, v) in &out_headers {
        let sent_value = if k.eq_ignore_ascii_case("content-type") { with_utf8_charset(v) } else { v.clone() };
        let (Ok(name), Ok(value)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&sent_value)) else {
            return json_resp(500, &json!({ "code": "500", "msg": format!("Invalid character in header content [\"{}\"]", k), "data": null }));
        };
        builder = builder.header(name, value);
        // 日志里记录配置渲染出来的值，和 Node 版一致
        header_obj.insert(k.clone(), Value::String(v.clone()));
    }
    let resp = builder.body(Body::from(output.clone())).unwrap();

    let entry = json!({
        "id": new_id(),
        "time": now_iso(),
        "method": method.as_str(),
        "url": original_url,
        "ip": ip,
        "mock": found.as_ref().map(|(m, _)| json!({ "id": m.id, "name": m.name, "path": m.path })),
        "hit": hit,
        "status": status,
        "durationMs": started.elapsed().as_millis() as u64,
        "request": { "headers": headers_obj, "query": query, "body": truncate_log(&raw) },
        "response": { "headers": header_obj, "body": truncate_log(&output) },
    });
    let mut log = st.log.lock().unwrap();
    log.push_front(entry);
    log.truncate(LOG_LIMIT);
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_parsing() {
        let q = parse_query("a=1&a=2&b[c]=3&d[]=x&e=%E4%B8%AD+%20");
        assert_eq!(Value::Object(q), json!({ "a": ["1", "2"], "b": { "c": "3" }, "d": ["x"], "e": "中  " }));
    }

    #[test]
    fn charset() {
        assert_eq!(with_utf8_charset("text/xml; charset=GBK"), "text/xml; charset=utf-8");
        assert_eq!(with_utf8_charset("application/json"), "application/json; charset=utf-8");
    }
}
