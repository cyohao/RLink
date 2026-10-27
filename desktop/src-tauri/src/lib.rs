// 瑞联（桌面版）：Tauri 窗口 + Rust 重写的内置服务。
// 内置服务的 HTTP 接口、数据文件格式和 Node 版完全一致，页面直接复用 public/。

pub mod client;
pub mod client_store;
pub mod desktop;
pub mod engine;
pub mod http_client;
pub mod js;
pub mod server;
pub mod store;
pub mod template;

use std::path::PathBuf;
use std::sync::Mutex;

use rand::Rng;

use crate::desktop::{bind, DesktopCtx, Settings};
use crate::server::{AppState, Config};

fn random_token() -> String {
    let mut rng = rand::thread_rng();
    (0..16).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

pub fn main_entry() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--serve") {
        run_headless(&args);
    } else {
        run_gui();
    }
}

/// 不开窗口，只运行服务。用于和 Node 版做对照测试，参数和环境变量的含义与 Node 版一致
fn run_headless(args: &[String]) {
    let port: u16 = arg_value(args, "--port").and_then(|p| p.parse().ok()).unwrap_or(3000);
    let host = arg_value(args, "--host").unwrap_or_else(|| "127.0.0.1".into());
    let data_dir = PathBuf::from(arg_value(args, "--data-dir").unwrap_or_else(|| "data".into()));
    let cfg = Config {
        admin_token: arg_value(args, "--token").unwrap_or_default(),
        client_enabled: arg_value(args, "--client-enabled").map_or(true, |v| v.to_lowercase() != "false"),
        allow_hosts: arg_value(args, "--allow-hosts").unwrap_or_default(),
        port,
    };
    if let Err(e) = client::validate_allow_hosts(&cfg.allow_hosts) {
        eprintln!("{}", e);
        std::process::exit(1);
    }
    let rt = tokio::runtime::Runtime::new().expect("启动运行时失败");
    rt.block_on(async move {
        let state = match AppState::open(&data_dir, cfg, None) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        };
        let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("监听 {}:{} 失败：{}", host, port, e);
                std::process::exit(1);
            }
        };
        println!("瑞联已启动：http://{}:{}", host, port);
        server::serve(listener, state).await;
    });
}

fn run_gui() {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已经打开时，再次双击只把现有窗口切到前面
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let start = || -> Result<String, String> {
                let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败 {}：{}", data_dir.display(), e))?;
                let settings = Settings::load(&data_dir);
                let (listener, port) = bind(settings.port, settings.lan).map_err(|e| format!("监听端口失败：{}", e))?;
                let token = random_token();
                let desktop = DesktopCtx {
                    data_dir: data_dir.clone(),
                    requested_port: settings.port,
                    lan_active: settings.lan,
                    settings: Mutex::new(settings),
                    port,
                    token: token.clone(),
                };
                let cfg = Config { admin_token: token.clone(), client_enabled: true, allow_hosts: String::new(), port };
                let state = AppState::open(&data_dir, cfg, Some(desktop))?;
                tauri::async_runtime::spawn(async move {
                    match tokio::net::TcpListener::from_std(listener) {
                        Ok(l) => server::serve(l, state).await,
                        Err(e) => eprintln!("启动服务失败：{}", e),
                    }
                });
                Ok(format!("{}|{}", port, token))
            };

            match start() {
                Ok(s) => {
                    let (port, token) = s.split_once('|').unwrap();
                    let url = format!("http://127.0.0.1:{}/__admin/", port);
                    // 页面加载前把本机口令写进 localStorage，和网页版的键名一致，用户无感
                    let script = format!("try {{ localStorage.setItem('mockAdminToken', {}); }} catch (e) {{}}", serde_json::to_string(token).unwrap());
                    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                        .title("瑞联 R-Link")
                        .inner_size(1400.0, 900.0)
                        .min_inner_size(900.0, 600.0)
                        .initialization_script(&script);
                    // 自动化测试用：设置 HUARUI_DEVTOOLS_PORT 时打开 WebView2 的远程调试端口（前半部分是 Tauri 默认的参数）
                    if let Ok(p) = std::env::var("HUARUI_DEVTOOLS_PORT") {
                        builder = builder.additional_browser_args(&format!("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={}", p));
                    }
                    builder.build()?;
                }
                Err(msg) => {
                    let script = format!(
                        "window.addEventListener('DOMContentLoaded', () => {{ document.body.style.cssText = 'font-family:sans-serif;padding:40px;color:#b91c1c'; document.body.textContent = '启动失败：' + {}; }});",
                        serde_json::to_string(&msg).unwrap()
                    );
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).title("瑞联 R-Link").inner_size(900.0, 500.0).initialization_script(&script).build()?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动桌面应用失败");
}
