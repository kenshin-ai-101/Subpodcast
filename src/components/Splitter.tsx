/**
 * [INPUT]: 列宽 value / min / max / def / snap；edge 决定拖动方向
 * [OUTPUT]: Splitter（拖宽、过 snap 收起、双击恢复默认、方向键微调）
 * [POS]: 挂在 .app / .ep-body 上的绝对分隔条；与 layout 的 put 协作
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useRef } from "react";

/** 可拖列边。edge 相对被改宽的那一列：朝列内拖则变窄；松手时宽 < snap 收起；双击恢复 def。 */
export function Splitter({
  value,
  min,
  max,
  def,
  snap,
  edge,
  onChange,
  onCollapse,
  label,
}: {
  value: number;
  min: number;
  max: number;
  def: number;
  snap: number;
  edge: "right" | "left";
  onChange: (w: number) => void;
  onCollapse: () => void;
  label: string;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const widthAt = (x: number) => {
    const s = start.current!;
    const d = x - s.x;
    return edge === "right" ? s.w + d : s.w - d;
  };

  return (
    <div
      className={`splitter ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title="拖动调整宽度 · 双击恢复默认"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: value };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const w = widthAt(e.clientX);
        // 收起只在松手时触发，拖拽中途不闪烁
        if (w < snap) return;
        onChange(clamp(w));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const w = widthAt(e.clientX);
        start.current = null;
        document.body.classList.remove("resizing");
        if (w < snap) onCollapse();
      }}
      onDoubleClick={() => onChange(def)}
      onKeyDown={(e) => {
        const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow || e.key === shrink) {
          e.preventDefault();
          e.stopPropagation();
          onChange(clamp(value + (e.key === grow ? 16 : -16)));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onChange(def);
        }
      }}
    />
  );
}
