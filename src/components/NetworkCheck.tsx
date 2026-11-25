/**
 * [INPUT]: api.networkCheck；WebView fetch（播放器侧可达性）
 * [OUTPUT]: 设置 › 通用 › 网络诊断列表 + 结论 + 复制报告
 * [POS]: SettingsDialog 网络区块；对照 SubCast 诊断行为的原创实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Check, Copy, Loader2, X } from "lucide-react";
import { api, type NetCheck } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import { useT, tNow } from "../lib/i18n";
import { IS_MAC } from "../lib/shortcuts";
import { useStore } from "../store";

type Row = { name: string; label: string; ok: boolean; ms?: number | null; detail: string };

/** WebView 能否摸到某 URL：opaque 应答即通，网络错或 10s 无响应算不通。 */
async function viewReach(url: string): Promise<{ ok: boolean; ms: number; detail: string }> {
  const start = performance.now();
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 10_000);
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctl.signal });
    return { ok: true, ms: Math.round(performance.now() - start), detail: "" };
  } catch (e) {
    return {
      ok: false,
      ms: Math.round(performance.now() - start),
      detail: ctl.signal.aborted ? tNow("10 秒内没有响应") : String((e as Error)?.message ?? e),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

const LABELS: Record<string, string> = {
  proxy: "声译使用的代理",
  youtube: "声译 → YouTube",
  google: "声译 → Google",
  apple: "声译 → Apple Podcasts",
  video: "声译 → YouTube 视频服务器",
  ytdlpSource: "声译 → 播放组件下载源",
  ytdlp: "播放组件 yt-dlp",
  viewYoutube: "播放器 → YouTube",
  viewVideo: "播放器 → YouTube 视频服务器",
};

export function NetworkCheck() {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [viewProxy, setViewProxy] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setRows(null);
    const [report, vy, vv] = await Promise.all([
      api.networkCheck().catch((e) => ({
        checks: [] as NetCheck[],
        webviewProxy: "",
        error: String(e),
      })),
      viewReach("https://www.youtube.com/generate_204"),
      viewReach("https://redirector.googlevideo.com/generate_204"),
    ]);
    const proxyText = (d: string) =>
      d === "none"
        ? t("无（直接连接）")
        : d
            .replace(/^Subpodcast: /, `${t("声译里设置的")} `)
            .replace(/^system: /, `${t("系统代理")} `);
    const ytdlpText = (d: string) =>
      d === "not installed"
        ? t("还没下载（第一次用时会自动下载）")
        : d === "doesn't run"
          ? t("无法运行")
          : d;
    setRows([
      ...report.checks.map((c) => ({
        name: c.name,
        label: t(LABELS[c.name] ?? c.name),
        ok: c.ok,
        ms: c.ms,
        detail: c.name === "proxy" ? proxyText(c.detail) : c.name === "ytdlp" ? ytdlpText(c.detail) : c.detail,
      })),
      { name: "viewYoutube", label: t(LABELS.viewYoutube), ...vy },
      { name: "viewVideo", label: t(LABELS.viewVideo), ...vv },
    ]);
    setViewProxy(report.webviewProxy);
    setBusy(false);
  };

  const ok = (name: string) => rows?.find((r) => r.name === name)?.ok;
  const verdict = !rows
    ? null
    : ok("viewYoutube") && ok("viewVideo") && ok("youtube")
      ? t("网络正常：播放器和声译都能连上 YouTube。")
      : !ok("youtube") && !ok("viewYoutube")
        ? t("声译和播放器都连不上 YouTube。请确认代理软件在运行，并在上面填上它的地址（例如 127.0.0.1:7890）。")
        : ok("youtube") && !(ok("viewYoutube") && ok("viewVideo"))
          ? viewProxy === "restart"
            ? t("声译能连上 YouTube，播放器还不能：代理改过了，重启声译后播放器才会用上新代理。")
            : viewProxy === "unsupported-os"
              ? t("声译能连上 YouTube，播放器不能：这个 macOS 版本的播放器只能用系统代理。请在系统设置里打开代理，或开启代理软件的「系统代理」。")
              : viewProxy === "unsupported-proxy"
                ? t("声译能连上 YouTube，播放器不能：播放器只支持带端口的 HTTP 或 SOCKS5 代理地址。")
                : viewProxy === "system"
                  ? t("声译能连上 YouTube，播放器不能：在上面填上代理地址并重启声译，播放器就会使用它。")
                  : t("声译能连上 YouTube，播放器不能。可稍后重试，或检查代理是否允许访问 googlevideo。")
          : !ok("youtube")
            ? t("播放器能连上 YouTube，声译不能：检查上面的代理地址是否正确。")
            : !ok("ytdlp") && !ok("ytdlpSource")
              ? t("播放组件还没下载，下载源也连不上：直连播放和下载视频暂时用不了。")
              : t("部分检查没有通过，看下面的详情。");

  const copy = async () => {
    if (!rows) return;
    const version = await getVersion().catch(() => "?");
    const text = [
      `Subpodcast ${version} · ${IS_MAC ? "macOS" : navigator.platform} · ${navigator.userAgent.match(/(Mac OS X|Windows NT|Linux)[^;)]*/)?.[0] ?? ""}`,
      `webview proxy: ${viewProxy}`,
      ...rows.map(
        (r) =>
          `${r.ok ? "✓" : "✗"} ${r.label}${r.ms != null ? ` (${r.ms} ms)` : ""}${r.detail ? ` — ${r.detail}` : ""}`,
      ),
    ].join("\n");
    try {
      await writeClipboardText(text);
      notify(t("诊断结果已复制，可以粘贴到反馈里"));
    } catch {
      notify(t("复制失败，请重试"));
    }
  };

  return (
    <div className="net-check" id="network">
      <div className="row-actions">
        <button type="button" className="btn sm" onClick={() => void run()} disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={13} className="spin" /> {t("正在检查…")}
            </>
          ) : (
            t("网络诊断")
          )}
        </button>
        {rows && (
          <button type="button" className="btn ghost sm" onClick={() => void copy()}>
            <Copy size={13} /> {t("复制结果")}
          </button>
        )}
        {!rows && !busy && <span className="muted small">{t("视频加载不出来时，查一下是哪里不通")}</span>}
      </div>
      {verdict && <p className="net-verdict small">{verdict}</p>}
      {rows && (
        <ul className="net-rows">
          {rows.map((r) => (
            <li key={r.name} className={r.ok ? "ok" : "bad"}>
              {r.ok ? <Check size={13} /> : <X size={13} />}
              <span className="net-label">{r.label}</span>
              <span className="muted small clamp1" title={r.detail}>
                {r.detail || (r.ms != null ? `${r.ms} ms` : "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
