/**
 * [INPUT]: YtEngine 注册的 pause 回调
 * [OUTPUT]: registerYtHost / pauseYoutubeHost — 同步停掉 iframe 声道
 * [POS]: 与 audioHost 对称的交权点；load / takeAudioEngine 切音频前必须先 pauseYoutubeHost
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

let pauseFn: (() => void) | null = null;

/** YtEngine 挂载时注册；卸载时注销。 */
export function registerYtHost(pause: () => void): () => void {
  pauseFn = pause;
  return () => {
    if (pauseFn === pause) pauseFn = null;
  };
}

/** 立刻停 YouTube（不靠 React effect），避免与 HTMLAudio 叠声。 */
export function pauseYoutubeHost() {
  try {
    pauseFn?.();
  } catch {
    /* iframe 已毁 */
  }
}
