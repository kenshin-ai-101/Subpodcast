/**
 * [INPUT]: subpodcast_lib::{asr, mcp}；命令行参数（mcp / shows / episodes / doctor / version）
 * [OUTPUT]: `subpodcast-cli` 独立无头二进制（安装后软链为 `subpodcast`）
 * [POS]: 供终端与外部 AI Agent（Claude Code / Codex / Cursor / Antigravity）调用；零 GUI / Dock 图标开销
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use std::path::PathBuf;
use subpodcast_lib::{asr, mcp};

fn print_help() {
    eprintln!(
        "subpodcast {} — 声译 CLI & MCP Server\n\n\
         用法:\n\
           subpodcast [全局选项] <命令>\n\n\
         命令:\n\
           mcp                        启动 MCP over stdio 服务（JSON-RPC 2.0）\n\
           shows                      列出已订阅节目（JSON）\n\
           episodes [show] [--limit N] 列出单集（JSON）\n\
           doctor                     检查环境、数据目录、FFmpeg 与模型状态（JSON）\n\
           version                    显示版本号\n\n\
         全局选项:\n\
           --data-dir <PATH>          指定数据目录（默认使用系统应用数据目录）\n\
           --proxy <URL>              指定 HTTP/SOCKS 代理地址\n\
           -h, --help                 显示帮助\n\
           -V, --version              显示版本号",
        env!("CARGO_PKG_VERSION")
    );
}

fn main() {
    let raw: Vec<String> = std::env::args().collect();
    // 兼容本机 Whisper 子进程识别模式
    if raw.get(1).map(String::as_str) == Some("--asr-worker") {
        std::process::exit(asr::worker_main(&raw[2..]));
    }

    let mut data_dir: Option<PathBuf> = None;
    let mut proxy: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();

    let mut i = 1;
    while i < raw.len() {
        match raw[i].as_str() {
            "--data-dir" => {
                if let Some(v) = raw.get(i + 1) {
                    data_dir = Some(PathBuf::from(v));
                    i += 2;
                    continue;
                }
                eprintln!("缺少 --data-dir 参数值");
                std::process::exit(2);
            }
            "--proxy" => {
                if let Some(v) = raw.get(i + 1) {
                    proxy = Some(v.clone());
                    i += 2;
                    continue;
                }
                eprintln!("缺少 --proxy 参数值");
                std::process::exit(2);
            }
            "-V" | "--version" => {
                println!("subpodcast {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "-h" | "--help" => {
                print_help();
                return;
            }
            other => {
                rest.push(other.to_string());
                i += 1;
            }
        }
    }

    let Some(cmd) = rest.first().cloned() else {
        print_help();
        return;
    };
    if cmd == "version" {
        println!("subpodcast {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("runtime init failed: {e}");
            std::process::exit(1);
        }
    };

    let res = rt.block_on(async move {
        let ctx = mcp::McpCtx::open(data_dir, proxy)?;
        match cmd.as_str() {
            "mcp" => mcp::run_stdio_mcp(&ctx).await,
            "doctor" => {
                println!("{}", serde_json::to_string_pretty(&mcp::run_doctor(&ctx)?)?);
                Ok(())
            }
            "shows" => {
                println!("{}", serde_json::to_string_pretty(&mcp::list_shows_json(&ctx)?)?);
                Ok(())
            }
            "episodes" => {
                let mut show: Option<String> = None;
                let mut limit: i64 = 20;
                let mut k = 1;
                while k < rest.len() {
                    if rest[k] == "--limit" {
                        if let Some(v) = rest.get(k + 1).and_then(|s| s.parse::<i64>().ok()) {
                            limit = v.clamp(1, 200);
                        }
                        k += 2;
                    } else {
                        show = Some(rest[k].clone());
                        k += 1;
                    }
                }
                println!(
                    "{}",
                    serde_json::to_string_pretty(&mcp::list_episodes_json(&ctx, show.as_deref(), limit)?)?
                );
                Ok(())
            }
            other => Err(anyhow::anyhow!("未知命令：{other}（运行 subpodcast --help 查看用法）")),
        }
    });

    if let Err(err) = res {
        eprintln!("错误：{err:#}");
        std::process::exit(1);
    }
}
