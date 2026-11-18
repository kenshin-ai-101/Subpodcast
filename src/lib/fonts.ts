/**
 * [INPUT]: 无
 * [OUTPUT]: 字幕可选字体与按需加载 CSS
 * [POS]: ReadingSettings / useReadingSettings 共用；不引入海报模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export interface SubFont {
  id: "system" | "serif" | "kai" | "sans";
  name: string;
  family: string;
  css?: string;
}

export const SUB_FONT_DEFS: SubFont[] = [
  { id: "system", name: "系统字体", family: "inherit" },
  {
    id: "serif",
    name: "思源宋体",
    family: '"Noto Serif SC", "Songti SC", serif',
    css: "https://fonts.googleapis.cn/css2?family=Noto+Serif+SC:wght@500;700&display=swap",
  },
  {
    id: "kai",
    name: "霞鹜文楷",
    family: '"LXGW WenKai Screen", "Kaiti SC", serif',
    css: "https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/lxgwwenkaiscreen.css",
  },
  {
    id: "sans",
    name: "思源黑体",
    family: '"Noto Sans SC", "PingFang SC", sans-serif',
    css: "https://fonts.googleapis.cn/css2?family=Noto+Sans+SC:wght@500;700&display=swap",
  },
];

const loaded = new Map<string, Promise<void>>();

export function loadCss(href: string): Promise<void> {
  let p = loaded.get(href);
  if (!p) {
    p = new Promise((res, rej) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = () => res();
      l.onerror = () => {
        loaded.delete(href);
        rej(new Error("font css"));
      };
      document.head.appendChild(l);
    });
    loaded.set(href, p);
  }
  return p;
}
