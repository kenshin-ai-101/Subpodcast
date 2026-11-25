/**
 * [INPUT]: assets/providers 下的 LobeHub Icons（MIT）SVG 原文
 * [OUTPUT]: agentMarkSvg(id) — 助手行品牌标；无标则返回 undefined，由 UI 回退首字母
 * [POS]: 设置 › AI 助手接入列表的图标映射；与 ModelSettings 字母标并列，不进模型侧栏
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const FILES = import.meta.glob("../assets/providers/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const svg = (name: string) => FILES[`../assets/providers/${name}.svg`];

/** 后端 icon / 助手 id → LobeHub 文件名（Cursor / Windsurf 无彩色标时回退首字母） */
const BY_ID: Record<string, string> = {
  "cli-claude": "claude-color",
  "cli-codex": "codex-color",
  "cli-antigravity": "antigravity-color",
  "cli-gemini": "gemini-color",
  "cli-qwen": "qwen-color",
  "cli-kimi": "kimi-color",
  "cli-opencode": "opencode",
  anthropic: "claude-color",
  "claude-code": "claude-color",
  "claude-desktop": "claude-color",
  codex: "codex-color",
  antigravity: "antigravity-color",
  gemini: "gemini-color",
  qwen: "qwen-color",
  kimi: "kimi-color",
  opencode: "opencode",
};

export function agentMarkSvg(id: string): string | undefined {
  const name = BY_ID[id];
  return name ? svg(name) : undefined;
}
