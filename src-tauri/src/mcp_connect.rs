/**
 * [INPUT]: cli_install（CLI 软链状态与命令路径）、本机 PATH / /Applications / 用户主目录配置
 * [OUTPUT]: AgentClientInfo / detect_clients / connect_clients / disconnect_client — 本机 AI 工具探测与一键写入 MCP 配置
 * [POS]: 桌面首启弹窗与设置页「命令行与 MCP」的后端核心；无损合并 JSON/TOML 配置，永不覆盖用户已有项
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
use crate::cli_install;
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientInfo {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub installed: bool,
    pub connected: bool,
    pub needs_update: bool,
    pub config_path: String,
    pub format: String,
}

#[derive(Clone, Copy)]
enum ConfigKind {
    /// 顶层 `mcpServers.subpodcast = { command, args: ["mcp"] }`
    McpServersJson,
    /// Claude Code: 顶层 `mcpServers.subpodcast = { type: "stdio", command, args: ["mcp"] }`
    ClaudeCodeJson,
    /// OpenCode: 顶层 `mcp.subpodcast = { type: "local", command: [cmd, "mcp"], enabled: true }`
    OpenCodeJson,
    /// Codex: `~/.codex/config.toml` 的 `[mcp_servers.subpodcast]` 段
    CodexToml,
}

struct ClientSpec {
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    exe: Option<&'static str>,
    mac_app: Option<&'static str>,
    kind: ConfigKind,
}

const CLIENTS: &[ClientSpec] = &[
    ClientSpec {
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic",
        exe: Some("claude"),
        mac_app: None,
        kind: ConfigKind::ClaudeCodeJson,
    },
    ClientSpec {
        id: "claude-desktop",
        name: "Claude Desktop",
        vendor: "Anthropic",
        exe: None,
        mac_app: Some("/Applications/Claude.app"),
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "codex",
        name: "Codex",
        vendor: "OpenAI",
        exe: Some("codex"),
        mac_app: Some("/Applications/Codex.app"),
        kind: ConfigKind::CodexToml,
    },
    ClientSpec {
        id: "cursor",
        name: "Cursor",
        vendor: "Cursor",
        exe: Some("cursor"),
        mac_app: Some("/Applications/Cursor.app"),
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        exe: None,
        mac_app: Some("/Applications/Antigravity.app"),
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "antigravity-cli",
        name: "Antigravity CLI",
        vendor: "Google",
        exe: Some("agy"),
        mac_app: None,
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "gemini-cli",
        name: "Gemini CLI",
        vendor: "Google",
        exe: Some("gemini"),
        mac_app: None,
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "kimi",
        name: "Kimi Code",
        vendor: "Moonshot",
        exe: Some("kimi"),
        mac_app: None,
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "qwen",
        name: "Qwen Code",
        vendor: "Alibaba",
        exe: Some("qwen"),
        mac_app: None,
        kind: ConfigKind::McpServersJson,
    },
    ClientSpec {
        id: "opencode",
        name: "OpenCode",
        vendor: "OpenCode",
        exe: Some("opencode"),
        mac_app: None,
        kind: ConfigKind::OpenCodeJson,
    },
    ClientSpec {
        id: "windsurf",
        name: "Windsurf",
        vendor: "Codeium",
        exe: Some("windsurf"),
        mac_app: Some("/Applications/Windsurf.app"),
        kind: ConfigKind::McpServersJson,
    },
];

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn search_dirs() -> Vec<PathBuf> {
    let h = home_dir();
    let mut dirs_list: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for rel in [
        ".local/bin",
        ".claude/local",
        ".bun/bin",
        ".npm-global/bin",
        ".cargo/bin",
        ".opencode/bin",
        ".volta/bin",
        "bin",
    ] {
        dirs_list.push(h.join(rel));
    }
    for sys in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs_list.push(PathBuf::from(sys));
    }
    dirs_list
}

fn exe_exists(name: &str) -> bool {
    let bin = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    search_dirs().into_iter().any(|d| d.join(&bin).is_file())
}

fn config_path_for(id: &str) -> PathBuf {
    let h = home_dir();
    match id {
        "claude-code" => h.join(".claude.json"),
        "claude-desktop" => {
            #[cfg(target_os = "macos")]
            {
                h.join("Library")
                    .join("Application Support")
                    .join("Claude")
                    .join("claude_desktop_config.json")
            }
            #[cfg(target_os = "windows")]
            {
                dirs::config_dir()
                    .unwrap_or_else(|| h.clone())
                    .join("Claude")
                    .join("claude_desktop_config.json")
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                h.join(".config").join("Claude").join("claude_desktop_config.json")
            }
        }
        "codex" => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| h.join(".codex"))
            .join("config.toml"),
        "cursor" => h.join(".cursor").join("mcp.json"),
        "antigravity" => h.join(".gemini").join("antigravity").join("mcp_config.json"),
        "kimi" => h.join(".kimi-code").join("mcp.json"),
        "qwen" => h.join(".qwen").join("settings.json"),
        "antigravity-cli" => h.join(".gemini").join("config").join("mcp_config.json"),
        "gemini-cli" => h.join(".gemini").join("settings.json"),
        "opencode" => h.join(".config").join("opencode").join("opencode.json"),
        "windsurf" => h.join(".codeium").join("windsurf").join("mcp_config.json"),
        _ => h.join(format!(".{id}.json")),
    }
}

fn is_client_installed(spec: &ClientSpec, cfg_path: &Path) -> bool {
    if spec.exe.is_some_and(exe_exists) {
        return true;
    }
    #[cfg(target_os = "macos")]
    if spec.mac_app.is_some_and(|p| Path::new(p).exists()) {
        return true;
    }
    if cfg_path.is_file() {
        return true;
    }
    match spec.id {
        "claude-code" => home_dir().join(".claude").is_dir(),
        "codex" => cfg_path.parent().is_some_and(|d| d.is_dir()),
        "cursor" => home_dir().join(".cursor").is_dir(),
        "antigravity" => home_dir().join(".gemini").join("antigravity").is_dir(),
        "opencode" => home_dir().join(".config").join("opencode").is_dir(),
        "windsurf" => home_dir().join(".codeium").join("windsurf").is_dir(),
        _ => false,
    }
}

fn inspect_connection(kind: ConfigKind, path: &Path, expected_cmd: &str) -> (bool, bool) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return (false, false);
    };
    match kind {
        ConfigKind::McpServersJson | ConfigKind::ClaudeCodeJson => {
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                return (false, false);
            };
            let entry = &v["mcpServers"]["subpodcast"];
            let Some(cmd) = entry["command"].as_str() else {
                return (false, false);
            };
            let has_mcp = entry["args"]
                .as_array()
                .is_some_and(|a| a.first().and_then(Value::as_str) == Some("mcp"));
            if !has_mcp {
                return (false, false);
            }
            (true, cmd != expected_cmd)
        }
        ConfigKind::OpenCodeJson => {
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                return (false, false);
            };
            let entry = &v["mcp"]["subpodcast"];
            let Some(arr) = entry["command"].as_array() else {
                return (false, false);
            };
            let cmd = arr.first().and_then(Value::as_str).unwrap_or("");
            let sub = arr.get(1).and_then(Value::as_str).unwrap_or("");
            if cmd.is_empty() || sub != "mcp" {
                return (false, false);
            }
            (true, cmd != expected_cmd)
        }
        ConfigKind::CodexToml => inspect_codex_toml(&raw, expected_cmd),
    }
}

fn inspect_codex_toml(raw: &str, expected_cmd: &str) -> (bool, bool) {
    let mut in_section = false;
    let mut found_cmd: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed == "[mcp_servers.subpodcast]";
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("command") {
            if let Some((_, rhs)) = rest.split_once('=') {
                let val = rhs.trim().trim_matches('"').trim_matches('\'').to_string();
                if !val.is_empty() {
                    found_cmd = Some(val);
                }
            }
        }
    }
    match found_cmd {
        Some(cmd) => (true, cmd != expected_cmd),
        None => (false, false),
    }
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

fn upsert_json_config(path: &Path, kind: ConfigKind, command: &str) -> Result<()> {
    let mut root: Value = match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).with_context(|| format!("配置文件 {} 不是有效的 JSON", path.display()))?
        }
        _ => json!({}),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow!("配置文件 {} 顶层不是 JSON 对象", path.display()))?;

    match kind {
        ConfigKind::McpServersJson => {
            let servers = obj
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow!("mcpServers 字段格式异常"))?;
            servers.insert(
                "subpodcast".into(),
                json!({ "command": command, "args": ["mcp"] }),
            );
        }
        ConfigKind::ClaudeCodeJson => {
            let servers = obj
                .entry("mcpServers")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow!("mcpServers 字段格式异常"))?;
            servers.insert(
                "subpodcast".into(),
                json!({ "type": "stdio", "command": command, "args": ["mcp"] }),
            );
        }
        ConfigKind::OpenCodeJson => {
            let mcp = obj
                .entry("mcp")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow!("mcp 字段格式异常"))?;
            mcp.insert(
                "subpodcast".into(),
                json!({ "type": "local", "command": [command, "mcp"], "enabled": true }),
            );
        }
        ConfigKind::CodexToml => unreachable!(),
    }

    let formatted = format!("{}\n", serde_json::to_string_pretty(&root)?);
    atomic_write(path, &formatted)
}

fn remove_json_config(path: &Path, kind: ConfigKind) -> Result<()> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(mut root) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(());
    };
    match kind {
        ConfigKind::McpServersJson | ConfigKind::ClaudeCodeJson => {
            if let Some(servers) = obj.get_mut("mcpServers").and_then(Value::as_object_mut) {
                servers.remove("subpodcast");
            }
        }
        ConfigKind::OpenCodeJson => {
            if let Some(mcp) = obj.get_mut("mcp").and_then(Value::as_object_mut) {
                mcp.remove("subpodcast");
            }
        }
        ConfigKind::CodexToml => unreachable!(),
    }
    let formatted = format!("{}\n", serde_json::to_string_pretty(&root)?);
    atomic_write(path, &formatted)
}

fn escape_toml_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 保留用户 `~/.codex/config.toml` 里原有注释与其它段，仅增改或移除 `[mcp_servers.subpodcast]`。
pub fn update_codex_toml_content(raw: &str, command: Option<&str>) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if trimmed == "[mcp_servers.subpodcast]" || trimmed.starts_with("[mcp_servers.subpodcast.") {
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
            "[mcp_servers.subpodcast]\ncommand = \"{}\"\nargs = [\"mcp\"]\n",
            escape_toml_str(cmd)
        ));
    } else if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn upsert_codex_toml(path: &Path, command: &str) -> Result<()> {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let next = update_codex_toml_content(&raw, Some(command));
    atomic_write(path, &next)
}

fn remove_codex_toml(path: &Path) -> Result<()> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    let next = update_codex_toml_content(&raw, None);
    atomic_write(path, &next)
}

pub fn detect_clients() -> Vec<AgentClientInfo> {
    let cli = cli_install::inspect();
    let expected_cmd = cli.command;
    CLIENTS
        .iter()
        .map(|spec| {
            let path = config_path_for(spec.id);
            let installed = is_client_installed(spec, &path);
            let (connected, needs_update) = inspect_connection(spec.kind, &path, &expected_cmd);
            AgentClientInfo {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                vendor: spec.vendor.to_string(),
                installed,
                connected,
                needs_update,
                config_path: path.to_string_lossy().into_owned(),
                format: match spec.kind {
                    ConfigKind::CodexToml => "toml".into(),
                    _ => "json".into(),
                },
            }
        })
        .collect()
}

/// 一键连接所选本机 AI 工具：先确保 `subpodcast` CLI 软链已安装，再把 MCP 配置无损写入每个工具的配置。
pub fn connect_clients(ids: &[String]) -> Result<Vec<AgentClientInfo>> {
    if ids.is_empty() {
        return Err(anyhow!("请至少选择一个要连接的 AI 工具"));
    }
    // 优先尝试安装/更新 CLI 软链，让写入的命令尽量简短且长期有效
    let cli = match cli_install::install() {
        Ok(st) => st,
        Err(_) => cli_install::inspect(),
    };
    if !cli.bundled && !cli.installed {
        return Err(anyhow!(
            "当前未找到 subpodcast-cli 二进制（开发态请先执行 cargo build --bin subpodcast-cli）"
        ));
    }
    let cmd = cli.command;

    for id in ids {
        let spec = CLIENTS
            .iter()
            .find(|c| c.id == id.as_str())
            .ok_or_else(|| anyhow!("不支持的 AI 工具：{id}"))?;
        let path = config_path_for(spec.id);
        match spec.kind {
            ConfigKind::CodexToml => upsert_codex_toml(&path, &cmd)?,
            kind => upsert_json_config(&path, kind, &cmd)?,
        }
    }
    Ok(detect_clients())
}

pub fn disconnect_client(id: &str) -> Result<Vec<AgentClientInfo>> {
    let spec = CLIENTS
        .iter()
        .find(|c| c.id == id)
        .ok_or_else(|| anyhow!("不支持的 AI 工具：{id}"))?;
    let path = config_path_for(spec.id);
    match spec.kind {
        ConfigKind::CodexToml => remove_codex_toml(&path)?,
        kind => remove_json_config(&path, kind)?,
    }
    Ok(detect_clients())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_merge_preserves_other_servers_and_disconnects_cleanly() {
        let dir = std::env::temp_dir().join(format!("subpodcast-mcpc-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude.json");
        std::fs::write(
            &file,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"npx","args":["foo"]}}}"#,
        )
        .unwrap();

        upsert_json_config(&file, ConfigKind::ClaudeCodeJson, "subpodcast").unwrap();
        let (conn, outdated) = inspect_connection(ConfigKind::ClaudeCodeJson, &file, "subpodcast");
        assert!(conn && !outdated);
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "npx");
        assert_eq!(parsed["mcpServers"]["subpodcast"]["type"], "stdio");

        remove_json_config(&file, ConfigKind::ClaudeCodeJson).unwrap();
        let (conn2, _) = inspect_connection(ConfigKind::ClaudeCodeJson, &file, "subpodcast");
        assert!(!conn2);
        let parsed2: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(parsed2["mcpServers"]["other"]["command"], "npx");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_toml_merge_preserves_comments_and_other_sections() {
        let initial = "# User config\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"foo\"\n";
        let added = update_codex_toml_content(initial, Some("subpodcast"));
        assert!(added.contains("# User config"));
        assert!(added.contains("[mcp_servers.other]"));
        assert!(added.contains("[mcp_servers.subpodcast]\ncommand = \"subpodcast\"\nargs = [\"mcp\"]"));

        let (conn, outdated) = inspect_codex_toml(&added, "subpodcast");
        assert!(conn && !outdated);
        let (_, outdated2) = inspect_codex_toml(&added, "/usr/local/bin/subpodcast");
        assert!(outdated2);

        let updated = update_codex_toml_content(&added, Some("/usr/local/bin/subpodcast"));
        assert_eq!(updated.matches("[mcp_servers.subpodcast]").count(), 1);
        assert!(updated.contains("/usr/local/bin/subpodcast"));

        let removed = update_codex_toml_content(&updated, None);
        assert!(!removed.contains("subpodcast"));
        assert!(removed.contains("[mcp_servers.other]"));
    }
}
