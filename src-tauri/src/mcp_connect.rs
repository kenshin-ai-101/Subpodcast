/**
 * [INPUT]: cli_install（CLI 路径）；本机 PATH / 助手可执行文件；用户主目录下各助手配置
 * [OUTPUT]: AgentClientInfo / detect_clients / connect_clients / disconnect_client / repair —
 *           优先跑助手自带 `mcp add|remove`，失败再无损改 JSON/TOML；启动时可 repair 过期路径
 * [POS]: 设置「让 AI 助手调用声译」与启动提示卡的后端；行为对齐 SubCast mcp_targets，保留 Windsurf
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::cli_install;
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const NAME: &str = "subpodcast";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientInfo {
    pub id: String,
    pub name: String,
    pub vendor: String,
    /// 前端品牌标 id（与 ModelSettings / agentMarks 共用映射）
    pub icon: String,
    pub installed: bool,
    pub connected: bool,
    pub needs_update: bool,
    pub config_path: String,
    pub format: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentKind {
    Claude,
    Codex,
    Antigravity,
    Gemini,
    Qwen,
}

#[derive(Clone, Copy)]
enum How {
    /// 助手自己的 `mcp add/remove`；配置文件只用来读回状态，部分种类失败时再写 JSON
    Cli(AgentKind),
    /// `mcpServers.subpodcast = { command, args }`
    Json,
    /// Claude Desktop / 手写 Claude：带 `type: "stdio"`
    ClaudeJson,
    /// OpenCode：`mcp.subpodcast = { type: local, command: [cmd, mcp] }`
    OpenCode,
}

struct Def {
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    icon: &'static str,
    how: How,
}

/// 与 SubCast 目标表对齐，额外保留 Windsurf。
const DEFS: &[Def] = &[
    Def { id: "claude-code", name: "Claude Code", vendor: "Anthropic", icon: "cli-claude", how: How::Cli(AgentKind::Claude) },
    Def { id: "claude-desktop", name: "Claude 桌面版", vendor: "Anthropic", icon: "anthropic", how: How::ClaudeJson },
    Def { id: "codex", name: "Codex", vendor: "OpenAI", icon: "cli-codex", how: How::Cli(AgentKind::Codex) },
    Def { id: "antigravity", name: "Antigravity CLI", vendor: "Google", icon: "cli-antigravity", how: How::Cli(AgentKind::Antigravity) },
    Def { id: "gemini", name: "Gemini CLI", vendor: "Google", icon: "cli-gemini", how: How::Cli(AgentKind::Gemini) },
    Def { id: "qwen", name: "Qwen Code", vendor: "Alibaba", icon: "cli-qwen", how: How::Cli(AgentKind::Qwen) },
    Def { id: "kimi", name: "Kimi Code", vendor: "Moonshot", icon: "cli-kimi", how: How::Json },
    Def { id: "opencode", name: "OpenCode", vendor: "OpenCode", icon: "cli-opencode", how: How::OpenCode },
    Def { id: "cursor", name: "Cursor", vendor: "Cursor", icon: "cursor", how: How::Json },
    Def { id: "windsurf", name: "Windsurf", vendor: "Codeium", icon: "windsurf", how: How::Json },
];

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn search_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut v: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for rel in [
        ".local/bin",
        ".claude/local",
        ".bun/bin",
        ".npm-global/bin",
        ".cargo/bin",
        ".opencode/bin",
        ".kimi-code/bin",
        ".volta/bin",
        "bin",
    ] {
        v.push(h.join(rel));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        v.push(PathBuf::from(d));
    }
    for base in [h.join(".nvm/versions/node"), h.join(".volta/tools/image/node")] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            v.extend(vers.into_iter().rev());
        }
    }
    let mut seen = std::collections::HashSet::new();
    v.retain(|p| seen.insert(p.clone()));
    v
}

fn child_path() -> std::ffi::OsString {
    std::env::join_paths(search_dirs()).unwrap_or_default()
}

fn exe_name(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Antigravity => "agy",
        AgentKind::Gemini => "gemini",
        AgentKind::Qwen => "qwen",
    }
}

fn find_exe(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|e| format!("{name}.{e}")).collect()
    } else {
        vec![name.to_string()]
    };
    for d in search_dirs() {
        for n in &names {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn path_of(kind: AgentKind) -> Option<PathBuf> {
    find_exe(exe_name(kind))
}

fn config_path(id: &str) -> PathBuf {
    let h = home();
    match id {
        "claude-code" => h.join(".claude.json"),
        "claude-desktop" => {
            #[cfg(target_os = "macos")]
            {
                h.join("Library/Application Support/Claude/claude_desktop_config.json")
            }
            #[cfg(target_os = "windows")]
            {
                dirs::config_dir()
                    .unwrap_or_else(|| h.clone())
                    .join("Claude/claude_desktop_config.json")
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                h.join(".config/Claude/claude_desktop_config.json")
            }
        }
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| h.join(".codex"))
            .join("config.toml"),
        "antigravity" => h.join(".gemini/config/mcp_config.json"),
        "gemini" => h.join(".gemini/settings.json"),
        "qwen" => h.join(".qwen/settings.json"),
        "kimi" => h.join(".kimi-code/mcp.json"),
        "opencode" => h.join(".config/opencode/opencode.json"),
        "cursor" => h.join(".cursor/mcp.json"),
        "windsurf" => h.join(".codeium/windsurf/mcp_config.json"),
        _ => PathBuf::new(),
    }
}

fn present(d: &Def) -> bool {
    match d.how {
        How::Cli(k) => path_of(k).is_some(),
        How::Json | How::ClaudeJson | How::OpenCode => match d.id {
            "claude-desktop" => {
                (cfg!(target_os = "macos") || cfg!(target_os = "windows"))
                    && config_path(d.id).parent().is_some_and(|p| p.exists())
            }
            "kimi" => find_exe("kimi").is_some(),
            "opencode" => find_exe("opencode").is_some(),
            "cursor" => home().join(".cursor").is_dir(),
            "windsurf" => {
                find_exe("windsurf").is_some()
                    || Path::new("/Applications/Windsurf.app").exists()
                    || home().join(".codeium/windsurf").is_dir()
            }
            _ => false,
        },
    }
}

fn current_command(id: &str) -> Option<String> {
    let path = config_path(id);
    let text = std::fs::read_to_string(&path).ok()?;
    if id == "codex" {
        let start = text.find(&format!("[mcp_servers.{NAME}]"))?;
        let rest = &text[start..];
        let block = &rest[..rest[1..].find("\n[").map(|i| i + 1).unwrap_or(rest.len())];
        let line = block.lines().find(|l| l.trim_start().starts_with("command"))?;
        let raw = line.split_once('=')?.1.trim();
        let val = if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
            raw[1..raw.len() - 1].replace("\\\\", "\\")
        } else {
            raw.trim_matches('\'').to_string()
        };
        return Some(val);
    }
    let v: Value = serde_json::from_str(&text).ok()?;
    if id == "opencode" {
        let e = &v["mcp"][NAME];
        return e["command"][0]
            .as_str()
            .map(str::to_string)
            .or_else(|| e.is_object().then(String::new));
    }
    let e = &v["mcpServers"][NAME];
    e["command"]
        .as_str()
        .map(str::to_string)
        .or_else(|| e.is_object().then(String::new))
}

/// 配置里写下的 command 是否就是当前这份 CLI（绝对路径 / 软链 / PATH 名 都算对上）。
fn same_cli(stored: &str, expected: &Path) -> bool {
    if stored.is_empty() {
        return false;
    }
    let stored_path = Path::new(stored);
    if stored_path == expected {
        return true;
    }
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(stored_path), std::fs::canonicalize(expected)) {
        return a == b;
    }
    // 旧配置可能只写了 PATH 里的 `subpodcast`
    if stored == "subpodcast" || stored == "subpodcast-cli" {
        return expected
            .file_stem()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == "subpodcast" || n == "subpodcast-cli");
    }
    false
}

fn target(d: &Def, cli: &Path) -> AgentClientInfo {
    let cmd = current_command(d.id);
    let connected = cmd.is_some();
    let outdated = cmd.as_deref().is_some_and(|c| !c.is_empty() && !same_cli(c, cli));
    AgentClientInfo {
        id: d.id.into(),
        name: d.name.into(),
        vendor: d.vendor.into(),
        icon: d.icon.into(),
        installed: true,
        connected,
        needs_update: outdated,
        config_path: config_path(d.id).to_string_lossy().into(),
        format: if d.id == "codex" { "toml".into() } else { "json".into() },
    }
}

/// 只读解析当前 CLI 绝对路径（探测 / 比较 outdated 用，不触发安装）。
fn resolve_cli_path(st: &cli_install::CliStatus) -> PathBuf {
    if let Some(p) = st.target_path.as_ref().map(PathBuf::from).filter(|p| p.is_file()) {
        return p;
    }
    if let Some(p) = st.link_path.as_ref().map(PathBuf::from) {
        if let Ok(c) = std::fs::canonicalize(&p) {
            return c;
        }
        if p.is_file() {
            return p;
        }
    }
    if let Some(p) = st.bundled_path.as_ref().map(PathBuf::from).filter(|p| p.is_file()) {
        return p;
    }
    let cmd = PathBuf::from(&st.command);
    if cmd.is_file() {
        return cmd;
    }
    find_exe("subpodcast-cli")
        .or_else(|| find_exe("subpodcast"))
        .unwrap_or(cmd)
}

fn expected_cli() -> Result<PathBuf> {
    let st = match cli_install::install() {
        Ok(st) => st,
        Err(_) => cli_install::inspect(),
    };
    if !st.bundled && !st.installed {
        return Err(anyhow!(
            "当前未找到 subpodcast-cli 二进制（开发态请先执行 cargo build --bin subpodcast-cli）"
        ));
    }
    // MCP 配置里写入的路径必须是绝对路径，与 detect 用同一套解析，避免接入后误报「需要更新」。
    Ok(resolve_cli_path(&st))
}

fn run_cli(exe: &Path, args: &[&str], secs: u64) -> Result<(bool, String)> {
    let mut c = std::process::Command::new(exe);
    c.args(args)
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if exe.file_stem().is_some_and(|n| n.eq_ignore_ascii_case("agy")) {
        c.env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
    }
    if let Some(h) = dirs::home_dir() {
        c.current_dir(h);
    }
    let child = c.spawn().with_context(|| format!("无法启动 {}", exe.display()))?;
    let output = wait_with_timeout(child, secs)?;
    Ok((
        output.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    ))
}

fn wait_with_timeout(mut child: std::process::Child, secs: u64) -> Result<std::process::Output> {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(Into::into),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(anyhow!("助手命令超时（{secs}s）"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.into()),
        }
    }
}

fn add_args(kind: AgentKind, cli: &str) -> Vec<String> {
    let v: Vec<&str> = match kind {
        AgentKind::Claude => vec!["mcp", "add", "--scope", "user", NAME, "--", cli, "mcp"],
        AgentKind::Codex => vec!["mcp", "add", NAME, "--", cli, "mcp"],
        AgentKind::Gemini | AgentKind::Qwen => vec!["mcp", "add", "-s", "user", NAME, cli, "mcp"],
        AgentKind::Antigravity => vec!["mcp", "add", NAME, cli, "mcp"],
    };
    v.into_iter().map(String::from).collect()
}

fn remove_args(kind: AgentKind) -> Vec<&'static str> {
    match kind {
        AgentKind::Claude => vec!["mcp", "remove", "--scope", "user", NAME],
        AgentKind::Gemini | AgentKind::Qwen => vec!["mcp", "remove", "-s", "user", NAME],
        _ => vec!["mcp", "remove", NAME],
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.is_empty() {
        path.with_extension("subpodcast-backup")
    } else {
        path.with_extension(format!("{ext}.subpodcast-backup"))
    }
}

/// 改 JSON：坏文件拒写；首次改动留一份 backup；合并写入，不抹其它项。
fn edit_json(path: &Path, change: impl FnOnce(&mut Value)) -> Result<()> {
    let mut v: Value = match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => json!({}),
        Ok(t) => {
            let parsed: Value = serde_json::from_str(&t)
                .map_err(|e| anyhow!("{} 不是有效的 JSON，没有改动：{e}", path.display()))?;
            let backup = backup_path(path);
            if !backup.exists() {
                let _ = std::fs::write(&backup, &t);
            }
            parsed
        }
        Err(_) => json!({}),
    };
    if !v.is_object() {
        return Err(anyhow!("{} 的格式不认识，没有改动", path.display()));
    }
    change(&mut v);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    atomic_write(path, &(serde_json::to_string_pretty(&v)? + "\n"))
}

fn atomic_write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("无法创建配置目录 {}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("subpodcast.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, content).with_context(|| format!("无法写入 {}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        anyhow!("无法保存配置文件 {}：{e}", path.display())
    })
}

fn write_mcp_servers(path: &Path, command: &str, with_stdio: bool) -> Result<()> {
    edit_json(path, |v| {
        let entry = if with_stdio {
            json!({ "type": "stdio", "command": command, "args": ["mcp"] })
        } else {
            json!({ "command": command, "args": ["mcp"] })
        };
        v["mcpServers"][NAME] = entry;
    })
}

fn write_opencode(path: &Path, command: &str) -> Result<()> {
    edit_json(path, |v| {
        v["mcp"][NAME] = json!({ "type": "local", "command": [command, "mcp"], "enabled": true });
    })
}

fn remove_mcp_servers(path: &Path) -> Result<()> {
    edit_json(path, |v| {
        if let Some(m) = v["mcpServers"].as_object_mut() {
            m.remove(NAME);
        }
    })
}

fn remove_opencode(path: &Path) -> Result<()> {
    edit_json(path, |v| {
        if let Some(m) = v["mcp"].as_object_mut() {
            m.remove(NAME);
        }
    })
}

fn escape_toml_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 保留用户 `~/.codex/config.toml` 注释与其它段，仅增改或移除 `[mcp_servers.subpodcast]`。
pub fn update_codex_toml_content(raw: &str, command: Option<&str>) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if trimmed == format!("[mcp_servers.{NAME}]")
                || trimmed.starts_with(&format!("[mcp_servers.{NAME}."))
            {
                skipping = true;
                continue;
            }
            skipping = false;
        }
        if !skipping {
            kept.push(line);
        }
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    if let Some(cmd) = command {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!(
            "[mcp_servers.{NAME}]\ncommand = \"{}\"\nargs = [\"mcp\"]\n",
            escape_toml_str(cmd)
        ));
    } else if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn upsert_codex_toml(path: &Path, command: &str) -> Result<()> {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    if !raw.is_empty() {
        let backup = backup_path(path);
        if !backup.exists() {
            let _ = std::fs::write(&backup, &raw);
        }
    }
    atomic_write(path, &update_codex_toml_content(&raw, Some(command)))
}

fn remove_codex_toml(path: &Path) -> Result<()> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    atomic_write(path, &update_codex_toml_content(&raw, None))
}

/// 本机已装助手及其接入态（未安装的不返回，与原站 list 一致）。
pub fn detect_clients() -> Vec<AgentClientInfo> {
    let cli_path = resolve_cli_path(&cli_install::inspect());
    DEFS.iter()
        .filter(|d| present(d))
        .map(|d| target(d, &cli_path))
        .collect()
}

fn connect_one(id: &str, cli: &Path) -> Result<AgentClientInfo> {
    let d = DEFS
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| anyhow!("未知的 AI 助手：{id}"))?;
    let c = cli.to_string_lossy().to_string();
    match d.how {
        How::Cli(kind) => {
            let exe = path_of(kind).ok_or_else(|| anyhow!("没有找到 {}", d.name))?;
            let _ = run_cli(&exe, &remove_args(kind), 30);
            let add = add_args(kind, &c);
            let add_ref: Vec<&str> = add.iter().map(String::as_str).collect();
            let (ok, out) = run_cli(&exe, &add_ref, 60)?;
            if !ok || current_command(id).is_none() {
                if matches!(kind, AgentKind::Antigravity | AgentKind::Gemini | AgentKind::Qwen) {
                    write_mcp_servers(&config_path(id), &c, false)?;
                } else if matches!(kind, AgentKind::Codex) {
                    // Codex CLI 失败时仍可直接改 TOML
                    upsert_codex_toml(&config_path(id), &c)?;
                } else {
                    return Err(anyhow!(
                        "{} 没有接受：{}",
                        d.name,
                        out.trim().lines().last().unwrap_or("")
                    ));
                }
            }
        }
        How::Json => write_mcp_servers(&config_path(id), &c, false)?,
        How::ClaudeJson => write_mcp_servers(&config_path(id), &c, true)?,
        How::OpenCode => write_opencode(&config_path(id), &c)?,
    }
    Ok(target(d, cli))
}

fn disconnect_one(id: &str, cli: &Path) -> Result<AgentClientInfo> {
    let d = DEFS
        .iter()
        .find(|d| d.id == id)
        .ok_or_else(|| anyhow!("未知的 AI 助手：{id}"))?;
    match d.how {
        How::Cli(kind) => {
            let exe = path_of(kind).ok_or_else(|| anyhow!("没有找到 {}", d.name))?;
            let (ok, out) = run_cli(&exe, &remove_args(kind), 30)?;
            if current_command(id).is_some() {
                if matches!(kind, AgentKind::Antigravity | AgentKind::Gemini | AgentKind::Qwen) {
                    remove_mcp_servers(&config_path(id))?;
                } else if matches!(kind, AgentKind::Codex) {
                    remove_codex_toml(&config_path(id))?;
                } else if !ok {
                    return Err(anyhow!(
                        "{} 没有移除：{}",
                        d.name,
                        out.trim().lines().last().unwrap_or("")
                    ));
                }
            }
        }
        How::Json | How::ClaudeJson => remove_mcp_servers(&config_path(id))?,
        How::OpenCode => remove_opencode(&config_path(id))?,
    }
    Ok(target(d, cli))
}

/// 接入单个助手，返回该助手最新状态（对齐 SubCast `mcp_connect`）。
pub fn connect_client(id: &str) -> Result<AgentClientInfo> {
    let cli = expected_cli()?;
    connect_one(id, &cli)
}

/// 一键接入多个：先确保 CLI 软链，再按助手官方方式写入；返回全量列表。
pub fn connect_clients(ids: &[String]) -> Result<Vec<AgentClientInfo>> {
    if ids.is_empty() {
        return Err(anyhow!("请至少选择一个要连接的 AI 工具"));
    }
    let cli = expected_cli()?;
    for id in ids {
        connect_one(id, &cli)?;
    }
    Ok(detect_clients())
}

/// 移除单个助手上的声译条目，返回该助手最新状态（对齐 SubCast `mcp_disconnect`）。
pub fn disconnect_client(id: &str) -> Result<AgentClientInfo> {
    let cli = resolve_cli_path(&cli_install::inspect());
    disconnect_one(id, &cli)
}

/// 应用搬家或 CLI 路径变更后，把过期条目指回当前 CLI。
pub fn repair() {
    let Ok(cli) = expected_cli() else { return };
    for t in detect_clients().into_iter().filter(|t| t.needs_update) {
        let _ = connect_one(&t.id, &cli);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_merge_preserves_other_servers_and_backs_up() {
        let dir = std::env::temp_dir().join(format!("subpodcast-mcpc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mcp.json");
        std::fs::write(
            &file,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"npx","args":["foo"]}}}"#,
        )
        .unwrap();

        write_mcp_servers(&file, "subpodcast", true).unwrap();
        assert!(backup_path(&file).exists());
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "npx");
        assert_eq!(parsed["mcpServers"][NAME]["type"], "stdio");

        remove_mcp_servers(&file).unwrap();
        let parsed2: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(parsed2["mcpServers"].get(NAME).is_none());
        assert_eq!(parsed2["mcpServers"]["other"]["command"], "npx");

        std::fs::write(&file, "{ not json").unwrap();
        assert!(write_mcp_servers(&file, "x", false).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_toml_merge_preserves_comments_and_other_sections() {
        let initial = "# User config\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"foo\"\n";
        let added = update_codex_toml_content(initial, Some("subpodcast"));
        assert!(added.contains("# User config"));
        assert!(added.contains("[mcp_servers.other]"));
        assert!(added.contains("[mcp_servers.subpodcast]\ncommand = \"subpodcast\"\nargs = [\"mcp\"]"));

        let updated = update_codex_toml_content(&added, Some("/usr/local/bin/subpodcast"));
        assert_eq!(updated.matches("[mcp_servers.subpodcast]").count(), 1);
        assert!(updated.contains("/usr/local/bin/subpodcast"));

        let removed = update_codex_toml_content(&updated, None);
        assert!(!removed.contains("subpodcast"));
        assert!(removed.contains("[mcp_servers.other]"));
    }

    #[test]
    fn defs_cover_subcast_ids_plus_windsurf() {
        let ids: Vec<_> = DEFS.iter().map(|d| d.id).collect();
        for need in [
            "claude-code",
            "claude-desktop",
            "codex",
            "antigravity",
            "gemini",
            "qwen",
            "kimi",
            "opencode",
            "cursor",
            "windsurf",
        ] {
            assert!(ids.contains(&need), "missing {need}");
        }
    }

    #[test]
    fn same_cli_accepts_path_name_and_absolute() {
        let abs = PathBuf::from("/usr/local/bin/subpodcast");
        assert!(same_cli("/usr/local/bin/subpodcast", &abs));
        assert!(same_cli("subpodcast", &abs));
        assert!(!same_cli("/old/path/subpodcast", &abs));
        assert!(!same_cli("", &abs));
    }
}
