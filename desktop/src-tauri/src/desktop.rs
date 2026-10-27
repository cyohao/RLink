// 桌面端特有的部分：设置、工作区切换、连接服务器时转发管理接口、端口绑定

use std::net::{TcpListener, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::HeaderMap;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::js::{get, text};
use crate::server::AppState;
use crate::store::{read_json_file, write_json_file};

pub const DEFAULT_PORT: u16 = 3000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// local：本地工作区；remote：连接服务器
    pub workspace: String,
    pub remote_url: String,
    pub remote_token: String,
    pub port: u16,
    pub lan: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { workspace: "local".into(), remote_url: String::new(), remote_token: String::new(), port: DEFAULT_PORT, lan: false }
    }
}

impl Settings {
    pub fn load(data_dir: &std::path::Path) -> Self {
        read_json_file(&data_dir.join("settings.json")).ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
}

pub struct DesktopCtx {
    pub data_dir: PathBuf,
    pub settings: Mutex<Settings>,
    /// 本次启动实际使用的端口和监听方式，修改设置后要重启才生效
    pub port: u16,
    pub requested_port: u16,
    pub lan_active: bool,
    pub token: String,
}

fn trim_url(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

/// 本机在局域网里的 IP。只是借用路由表选出出口网卡，不会真的发包
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

impl DesktopCtx {
    /// 连接服务器模式时返回 (服务器地址, 口令)
    pub fn remote(&self) -> Option<(String, String)> {
        let s = self.settings.lock().unwrap();
        if s.workspace == "remote" && !s.remote_url.trim().is_empty() {
            Some((trim_url(&s.remote_url), s.remote_token.clone()))
        } else {
            None
        }
    }

    pub fn info(&self) -> Value {
        let s = self.settings.lock().unwrap();
        let remote = s.workspace == "remote" && !s.remote_url.trim().is_empty();
        json!({
            "workspace": if remote { "remote" } else { "local" },
            "remoteUrl": if remote { trim_url(&s.remote_url) } else { String::new() },
            "port": self.port,
            "portFallback": self.port != self.requested_port,
            "lanActive": self.lan_active,
        })
    }

    fn detail(&self) -> Value {
        let s = self.settings.lock().unwrap().clone();
        let lan_ip = if self.lan_active { lan_ip() } else { None };
        json!({
            "settings": s,
            "dataDir": self.data_dir.display().to_string(),
            "port": self.port,
            "requestedPort": self.requested_port,
            "portFallback": self.port != self.requested_port,
            "lanActive": self.lan_active,
            "lanUrl": lan_ip.map(|ip| format!("http://{}:{}", ip, self.port)),
            // 只有允许局域网访问时，别人才需要这个口令
            "localToken": if self.lan_active { self.token.clone() } else { String::new() },
            "restartRequired": s.port != self.requested_port || s.lan != self.lan_active,
        })
    }

    pub async fn handle(&self, st: &Arc<AppState>, method: &str, seg: &[&str], body: &Value) -> Response {
        match (method, seg) {
            ("GET", []) => ok(&self.detail()),
            ("PUT", []) => {
                let mut next = self.settings.lock().unwrap().clone();
                if let Some(w) = get(body, "workspace").and_then(|v| v.as_str()) {
                    next.workspace = if w == "remote" { "remote".into() } else { "local".into() };
                }
                if get(body, "remoteUrl").is_some() {
                    next.remote_url = trim_url(&text(get(body, "remoteUrl"), ""));
                }
                if get(body, "remoteToken").is_some() {
                    next.remote_token = text(get(body, "remoteToken"), "").trim().to_string();
                }
                if let Some(p) = get(body, "port") {
                    match crate::js::parse_int(Some(p)) {
                        Some(n) if (1..=65535).contains(&n) => next.port = n as u16,
                        _ => return bad("端口应为 1–65535 之间的数字"),
                    }
                }
                if let Some(Value::Bool(b)) = get(body, "lan") {
                    next.lan = *b;
                }
                if next.workspace == "remote" {
                    match url::Url::parse(&next.remote_url) {
                        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => {}
                        _ => return bad("请填写正确的服务器地址，例如 http://192.168.1.100:3000"),
                    }
                }
                if let Err(e) = write_json_file(&self.data_dir.join("settings.json"), &json!(next)) {
                    return bad(&e.message);
                }
                *self.settings.lock().unwrap() = next;
                ok(&self.detail())
            }
            ("POST", ["test"]) => {
                let url = trim_url(&text(get(body, "remoteUrl"), ""));
                let token = text(get(body, "remoteToken"), "").trim().to_string();
                ok(&test_remote(&st.http, &url, &token).await)
            }
            ("POST", ["open-data-dir"]) => {
                let _ = std::process::Command::new("explorer").arg(&self.data_dir).spawn();
                Response::builder().status(204).body(Body::empty()).unwrap()
            }
            _ => Response::builder().status(404).header("content-type", "application/json; charset=utf-8").body(Body::from("{\"message\":\"未知的设置接口\"}")).unwrap(),
        }
    }
}

fn ok(v: &Value) -> Response {
    Response::builder().status(200).header("content-type", "application/json; charset=utf-8").body(Body::from(v.to_string())).unwrap()
}

fn bad(msg: &str) -> Response {
    Response::builder().status(400).header("content-type", "application/json; charset=utf-8").body(Body::from(json!({ "message": msg }).to_string())).unwrap()
}

async fn test_remote(http: &reqwest::Client, url: &str, token: &str) -> Value {
    if url::Url::parse(url).map(|u| u.scheme() != "http" && u.scheme() != "https").unwrap_or(true) {
        return json!({ "ok": false, "message": "服务器地址格式不正确，例如 http://192.168.1.100:3000" });
    }
    let info = match http.get(format!("{}/__admin/api/info", url)).send().await {
        Ok(r) => r.json::<Value>().await.ok(),
        Err(e) => return json!({ "ok": false, "message": format!("连接失败：{}", e) }),
    };
    let Some(info) = info.filter(|v| v.get("authRequired").is_some()) else {
        return json!({ "ok": false, "message": "这个地址不是瑞联的服务" });
    };
    let res = http.get(format!("{}/__admin/api/mocks", url)).header("X-Admin-Token", token).send().await;
    match res {
        Ok(r) if r.status().as_u16() == 401 => json!({ "ok": false, "message": "管理口令错误" }),
        Ok(r) if r.status().is_success() => {
            let count = r.json::<Value>().await.ok().and_then(|v| v.as_array().map(|a| a.len())).unwrap_or(0);
            let client_ok = info.get("client").and_then(|c| c.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
            let mut msg = format!("连接成功，服务器上有 {} 个接口", count);
            if !client_ok {
                msg.push_str("。注意：服务器没有开启接口调用功能，集合和环境无法使用");
            }
            json!({ "ok": true, "message": msg })
        }
        Ok(r) => json!({ "ok": false, "message": format!("服务器返回 {}", r.status()) }),
        Err(e) => json!({ "ok": false, "message": format!("连接失败：{}", e) }),
    }
}

/// 连接服务器模式：把管理接口原样转发到远端服务器
#[allow(clippy::too_many_arguments)]
pub async fn proxy(http: &reqwest::Client, remote: &str, token: &str, method: &str, sub: &str, raw_query: &str, bytes: &[u8], headers: &HeaderMap, patch_allow_hosts: bool) -> Response {
    let mut target = format!("{}/__admin/api{}", remote, sub);
    if !raw_query.is_empty() {
        target = format!("{}?{}", target, raw_query);
    }
    let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut req = http.request(m, &target).header("X-Admin-Token", token);
    if let Some(ct) = headers.get("content-type") {
        req = req.header("Content-Type", ct.as_bytes());
    }
    if !bytes.is_empty() {
        req = req.body(bytes.to_vec());
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/json; charset=utf-8").to_string();
            let mut body = res.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
            if status == 401 {
                // 远端口令不对时给出明确提示，避免页面弹出「输入本机口令」
                body = json!({ "message": "服务器的管理口令不正确，请到「桌面设置」里修改" }).to_string().into_bytes();
                return Response::builder().status(502).header("content-type", "application/json; charset=utf-8").body(Body::from(body)).unwrap();
            }
            // 访问白名单只对服务器转发生效，桌面端在本机发送，不受它限制
            if patch_allow_hosts && status == 200 {
                if let Ok(mut v) = serde_json::from_slice::<Value>(&body) {
                    v["allowHosts"] = json!("");
                    body = v.to_string().into_bytes();
                }
            }
            Response::builder().status(status).header("content-type", ct).body(Body::from(body)).unwrap()
        }
        Err(e) => Response::builder()
            .status(502)
            .header("content-type", "application/json; charset=utf-8")
            .body(Body::from(json!({ "message": format!("连接服务器 {} 失败：{}。可以在「桌面设置」里切回本地工作区", remote, e) }).to_string()))
            .unwrap(),
    }
}

/// 绑定端口，被占用时换一个空闲端口。返回 (监听器, 实际端口)
pub fn bind(port: u16, lan: bool) -> std::io::Result<(TcpListener, u16)> {
    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let listener = match TcpListener::bind((host, port)) {
        Ok(l) => l,
        Err(_) => TcpListener::bind((host, 0))?,
    };
    let actual = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    Ok((listener, actual))
}
