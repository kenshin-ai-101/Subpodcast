/**
 * [INPUT]: Tauri asset_resolver、本机 TcpListener
 * [OUTPUT]: 发行版把界面挂到 http://localhost，供 YouTube iframe 认 origin
 * [POS]: 与 OTA 无关的纯内嵌资源服务；开发态仍走 Vite
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/// 避开 SubCast 的 14327，两边可同时开。
pub const LOCAL_PORT: u16 = 14427;
pub const UI_PORTS: u16 = 20;

#[cfg(not(debug_assertions))]
fn bind_ui_port(preferred: u16) -> Option<(u16, Vec<std::net::TcpListener>)> {
    use std::net::TcpListener;
    for port in preferred..preferred.saturating_add(UI_PORTS) {
        let Ok(v4) = TcpListener::bind(("127.0.0.1", port)) else {
            continue;
        };
        match TcpListener::bind(("::1", port)) {
            Ok(v6) => return Some((port, vec![v4, v6])),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(_) => return Some((port, vec![v4])),
        }
    }
    None
}

/// 发行版：把打包进应用的前端文件挂到 loopback，返回选用端口。
#[cfg(not(debug_assertions))]
pub fn serve_bundled_ui(app: &tauri::AppHandle) -> u16 {
    use tauri::Manager;
    let Some((port, listeners)) = bind_ui_port(LOCAL_PORT) else {
        eprintln!("Subpodcast: no free port near {LOCAL_PORT}");
        return LOCAL_PORT;
    };
    if port != LOCAL_PORT {
        eprintln!("Subpodcast: port {LOCAL_PORT} busy, using {port}");
    }
    for listener in listeners {
        let Ok(server) = tiny_http::Server::from_listener(listener, None) else {
            continue;
        };
        let resolver = app.asset_resolver();
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let path = req.url().split(['?', '#']).next().unwrap_or("/").to_string();
                let Some(asset) = resolver.get(path) else {
                    let _ = req.respond(tiny_http::Response::empty(404));
                    continue;
                };
                let mut resp = tiny_http::Response::from_data(asset.bytes);
                for (k, v) in [
                    ("Content-Type", Some(asset.mime_type)),
                    ("Cache-Control", Some("no-cache".into())),
                    ("Content-Security-Policy", asset.csp_header),
                ] {
                    if let Some(h) = v.and_then(|v| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
                    {
                        resp.add_header(h);
                    }
                }
                let _ = req.respond(resp);
            }
        });
    }
    port
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_range_matches_capabilities_span() {
        assert_eq!(UI_PORTS, 20);
        assert_eq!(LOCAL_PORT + UI_PORTS - 1, 14446);
    }
}
