/**
 * [INPUT]: 封面所选字形 id + 待排字文案
 * [OUTPUT]: CoverFontId / familyOf / ensureFont — 按需从 CDN 拉开源中文字体
 * [POS]: 剪视频封面工作室字体（不随包分发，选中时才加载）
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/CLAUDE.md
 */

export type CoverFontId = "" | "sans" | "serif" | "noto-sans" | "noto-serif" | "wenkai";

interface WebFontFace {
  family: string;
  css: string[];
}

const WEB: Record<"noto-sans" | "noto-serif" | "wenkai", WebFontFace> = {
  "noto-sans": {
    family: "Noto Sans SC",
    css: [
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.1/500.css",
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.1/700.css",
    ],
  },
  "noto-serif": {
    family: "Noto Serif SC",
    css: [
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/500.css",
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.3.1/700.css",
    ],
  },
  wenkai: {
    family: "LXGW WenKai",
    css: ["https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css"],
  },
};

const linked = new Set<string>();

export function familyOf(id: CoverFontId, fallback: string): string {
  if (id === "noto-sans" || id === "noto-serif" || id === "wenkai") {
    return `"${WEB[id].family}", ${fallback}`;
  }
  return fallback;
}

export async function ensureFont(id: CoverFontId, text: string): Promise<boolean> {
  if (id !== "noto-sans" && id !== "noto-serif" && id !== "wenkai") return true;
  const face = WEB[id];
  for (const href of face.css) {
    if (!linked.has(href)) {
      linked.add(href);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
      await new Promise<void>((resolve) => {
        link.onload = () => resolve();
        link.onerror = () => resolve();
        window.setTimeout(resolve, 4000);
      });
    }
  }
  const sample = text.replace(/\s+/g, "") || "字";
  const weights = id === "wenkai" ? ["400", "700"] : ["500", "700"];
  try {
    await Promise.race([
      Promise.all(weights.map((w) => document.fonts.load(`${w} 64px "${face.family}"`, sample))),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 6000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export const isWebFont = (id: CoverFontId) => id === "noto-sans" || id === "noto-serif" || id === "wenkai";