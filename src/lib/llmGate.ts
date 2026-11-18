/**
 * [INPUT]: 无
 * [OUTPUT]: acquireLlm / releaseLlm
 * [POS]: 前端串行化 llm-delta 监听，避免导读与问答并发串流
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

let owner: "guide" | "chat" | null = null;

export function acquireLlm(label: "guide" | "chat"): void {
  if (owner) {
    throw new Error(owner === "guide" ? "导读正在生成，请稍后再试" : "问答正在回答，请稍后再试");
  }
  owner = label;
}

export function releaseLlm(): void {
  owner = null;
}
