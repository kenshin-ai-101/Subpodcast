/**
 * [INPUT]: 无外部业务依赖；随主题色（currentColor / CSS --ink --accent）上色
 * [OUTPUT]: WaveToTextArt / TrayArt / CassetteArt / PageArt / PlugArt / MoonArt / NightNote
 * [POS]: components 视觉小品；GenCard / 导读空态消费，与业务逻辑解耦
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useT } from "../lib/i18n";

type Art = { className?: string };

function svg(w: number, h: number, name: string, className?: string) {
  return {
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    fill: "none" as const,
    "aria-hidden": true as const,
    focusable: "false" as const,
    className: `ia ${name}${className ? ` ${className}` : ""}`,
  };
}

/** 插头与插座相向；连模型空态用。 */
export function PlugArt({ className }: Art) {
  return (
    <svg {...svg(124, 48, "ia-plug", className)}>
      <g className="ia-l">
        <path d="M6 32c7 0 9-7 16-7h8" />
        <rect x="30" y="16" width="18" height="16" rx="4" />
        <path d="M48 20h6M48 28h6" />
      </g>
      <g className="ia-r">
        <path d="M92 24h8c7 0 9 7 16 7" />
        <rect x="70" y="12" width="22" height="24" rx="6" />
        <path className="s" d="M74 20h3M74 28h3" />
      </g>
      <path
        className="a ia-spark"
        d="M63 15v3M63 30v3M58.5 18.5l2 2M67.5 18.5l-2 2M58.5 29.5l2-2M67.5 29.5l-2-2"
      />
    </svg>
  );
}

/** 带时间线的书页；writing 时逐行描出。 */
export function PageArt({ writing, className }: Art & { writing?: boolean }) {
  return (
    <svg {...svg(96, 64, `ia-page${writing ? " is-writing" : ""}`, className)}>
      <rect x="18" y="4" width="60" height="56" rx="6" />
      <rect className="ia-mark" x="37" y="30" width="33" height="6" rx="2" />
      <path className="s" d="M30 18v32" />
      <g className="ia-lines">
        <path d="M38 16h28" />
        <path className="s" d="M38 22h20" />
        <path d="M38 33h30" />
        <path className="s" d="M38 39h16" />
        <path d="M38 50h24" />
      </g>
      <g className="ia-dots">
        <circle cx="30" cy="16" r="2.5" />
        <circle className="a" cx="30" cy="33" r="2.5" />
        <circle cx="30" cy="50" r="2.5" />
      </g>
    </svg>
  );
}

/** 左声波、中流转点、右字幕卡——「听 → 字」的一笔示意。 */
export function WaveToTextArt({ className }: Art) {
  return (
    <svg {...svg(140, 58, "ia-w2t", className)}>
      <g className="ia-eq">
        <path d="M8 26v6" />
        <path d="M15 18v22" />
        <path d="M22 10v38" />
        <path d="M29 16v26" />
        <path d="M36 24v10" />
      </g>
      <g className="ia-flow">
        <circle cx="48" cy="29" r="1.5" />
        <circle cx="56" cy="29" r="1.5" />
        <circle cx="64" cy="29" r="1.5" />
      </g>
      <rect x="74" y="13" width="58" height="32" rx="8" />
      <path className="a" d="M82 24h6" />
      <g className="ia-sub">
        <path d="M92 24h32" />
        <path className="s" d="M82 34h36" />
      </g>
    </svg>
  );
}

/** 托盘接住下落的声波；busy 时由 CSS 保持下落感。 */
export function TrayArt({ busy, className }: Art & { busy?: boolean }) {
  return (
    <svg {...svg(100, 66, `ia-tray${busy ? " is-busy" : ""}`, className)}>
      <path d="M20 40v10a7 7 0 0 0 7 7h46a7 7 0 0 0 7-7V40" />
      <path className="s" d="M34 50h32" />
      <g className="ia-drop">
        <path d="M44 16v10" />
        <path className="a" d="M50 8v26" />
        <path d="M56 16v10" />
      </g>
    </svg>
  );
}

/** 磁带：取音频 / 听写中；tangled 时带子溢出，对应生成失败。 */
export function CassetteArt({
  mode = "idle",
  className,
}: Art & { mode?: "idle" | "fetch" | "listen" | "tangled" }) {
  const h = mode === "tangled" ? 86 : 70;
  return (
    <svg {...svg(116, h, `ia-tape is-${mode}`, className)}>
      <rect x="8" y="8" width="100" height="52" rx="8" />
      <rect className="s" x="24" y="20" width="68" height="22" rx="11" />
      <g className="ia-reel">
        <circle cx="38" cy="31" r="7" />
        <path d="M38 27.5V25M41 32.5l2 1.2M35 32.5l-2 1.2" />
      </g>
      <g className="ia-reel">
        <circle cx="78" cy="31" r="7" />
        <path d="M78 27.5V25M81 32.5l2 1.2M75 32.5l-2 1.2" />
      </g>
      <path className="s" d="M30 60l5-8h46l5 8" />
      <circle className="f ia-rec" cx="98" cy="16" r="2.2" />
      {mode === "tangled" && (
        <path className="ia-spill" d="M52 60c-8 6-4 16 4 15s5-10-1-9-3 11 5 10 12-5 10-12" />
      )}
    </svg>
  );
}

export function MoonArt({ className }: Art) {
  return (
    <svg {...svg(12, 12, "ia-moon", className)}>
      <path d="M10.2 7.4A4.5 4.5 0 0 1 4.6 2.2a4.5 4.5 0 1 0 5.6 5.2z" />
    </svg>
  );
}

/** 午夜到清晨：空态底部一句轻声叮嘱。 */
export function NightNote() {
  const t = useT();
  if (new Date().getHours() >= 5) return null;
  return (
    <p className="night-note">
      <MoonArt />
      {t("夜深了，听完这期早点休息")}
    </p>
  );
}
