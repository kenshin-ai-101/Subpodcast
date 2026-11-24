/**
 * [INPUT]: settings.Settings / Provider
 * [OUTPUT]: resolveChatModel — 统一消费 settings.chatModel || provider.model，避免各模块漂移
 * [POS]: 导读 / 问答 / 高光 / 短句分行 / 生词释义 / 统计画像共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Provider, Settings } from "./settings";

export function resolveChatModel(settings: Settings, provider?: Provider | null): string {
  const p = provider ?? settings.providers[settings.chatProvider];
  if (!p) return "";
  if (p.id === settings.chatProvider && settings.chatModel?.trim()) {
    return settings.chatModel.trim();
  }
  return p.model;
}
