/**
 * [INPUT]: format.parseClock
 * [OUTPUT]: Markdown 组件（标题/列表/引用/粗体/表格/可点时间戳含区间）
 * [POS]: 导读与问答回答的轻量渲染；时间线列表走 .timeline 竖脊样式
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Fragment, memo, type ReactNode } from "react";
import { parseClock } from "../lib/format";

const INLINE =
  /(\*\*[^*]+\*\*|`[^`]+`|\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s*[-–~至]\s*\[\d{1,2}:\d{2}(?::\d{2})?\])?)/g;

function inline(text: string, onSeek: (t: number) => void, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={k}>{part.slice(1, -1)}</code>;
    const stamp = part.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    if (stamp) {
      const sec = parseClock(stamp[1]);
      if (sec == null) return <Fragment key={k}>{part}</Fragment>;
      return (
        <button key={k} type="button" className="stamp" title="跳到这里播放" onClick={() => onSeek(sec)}>
          {stamp[1]}
        </button>
      );
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

export const Markdown = memo(function Markdown({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let ordered = false;
  let timeline = true;
  let rows: string[][] = [];

  const flushTable = () => {
    if (!rows.length) return;
    const [head, ...body] = rows;
    const k = `t${blocks.length}`;
    blocks.push(
      <div key={k} className="md-table">
        <table>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{inline(c, onSeek, `${k}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{inline(c, onSeek, `${k}${i}-${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    rows = [];
  };

  const flush = () => {
    flushTable();
    if (list.length) {
      blocks.push(
        ordered ? (
          <ol key={`l${blocks.length}`} className={timeline ? "timeline" : undefined}>
            {list}
          </ol>
        ) : (
          <ul key={`l${blocks.length}`} className={timeline ? "timeline" : undefined}>
            {list}
          </ul>
        ),
      );
    }
    list = [];
    timeline = true;
  };

  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();
    const cells = line.trim().match(/^\|(.*)\|$/);
    if (cells) {
      if (list.length) flush();
      if (!/^[\s|:-]+$/.test(cells[1])) rows.push(cells[1].split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)、])\s+(.*)$/);
    if (bullet) {
      const isOrdered = Boolean(bullet[1]);
      if (list.length && isOrdered !== ordered) flush();
      ordered = isOrdered;
      const stamped = /^\[\d{1,2}:\d{2}/.test(bullet[2]);
      timeline &&= stamped;
      list.push(
        <li key={i} className={stamped ? "ts-item" : undefined}>
          {inline(bullet[2], onSeek, `b${i}`)}
        </li>,
      );
      continue;
    }
    if (line.trim().startsWith(">")) {
      flush();
      blocks.push(
        <blockquote key={i}>{inline(line.trim().replace(/^>\s*/, ""), onSeek, `q${i}`)}</blockquote>,
      );
      continue;
    }
    flush();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        heading[1].length <= 2 ? (
          <h3 key={i}>{inline(heading[2], onSeek, `h${i}`)}</h3>
        ) : (
          <h4 key={i}>{inline(heading[2], onSeek, `h${i}`)}</h4>
        ),
      );
    } else if (line.trim() === "---") {
      blocks.push(<hr key={i} />);
    } else if (line.trim()) {
      blocks.push(<p key={i}>{inline(line, onSeek, `p${i}`)}</p>);
    }
  }
  flush();
  return <div className="markdown">{blocks}</div>;
});
