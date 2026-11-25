/**
 * [INPUT]: quotePoster（5 主题 / 5 字体 / 渲染与选区拆分）；api（translateTexts / saveDownload / revealFile）；assets/logo.png
 * [OUTPUT]: openQuotePosterDialog / closeQuotePosterDialog / QuotePosterDialogHost — 摘句「分享海报」弹窗
 * [POS]: 选区工具条「生成海报」入口；左栏整图自适应无滚动预览，右栏主题色卡与开源字体选择，底栏复制/保存
 * [PROTOCOL]: 变更时更新此头部，然后检查 src/CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";
import { create } from "zustand";
import logoUrl from "../assets/logo.png";
import { api, errText, type Episode, type Segment } from "../lib/api";
import { tNow, useT } from "../lib/i18n";
import {
  extractSelectionQuote,
  loadQuotePosterFont,
  QUOTE_POSTER_FONTS,
  QUOTE_POSTER_THEMES,
  renderQuotePoster,
  type QuotePosterFontId,
  type QuotePosterInput,
  type QuotePosterThemeId,
} from "../lib/quotePoster";
import { useStore } from "../store";

export interface QuotePosterTarget {
  text: string;
  ts?: string;
  startIdx?: number;
  endIdx?: number;
  episode: Episode | null;
  segments?: Segment[];
  zh?: (string | null | undefined)[];
}

interface PosterModalState {
  target: QuotePosterTarget | null;
}

const useQuotePosterModal = create<PosterModalState>(() => ({ target: null }));

export function openQuotePosterDialog(target: QuotePosterTarget) {
  useQuotePosterModal.setState({ target });
}

export function closeQuotePosterDialog() {
  useQuotePosterModal.setState({ target: null });
}

export function QuotePosterDialogHost() {
  const target = useQuotePosterModal((s) => s.target);
  if (!target) return null;
  const key = `${target.episode?.id ?? "none"}:${target.startIdx ?? "t"}:${target.endIdx ?? "t"}:${target.text.slice(0, 24)}`;
  return <QuotePosterDialogBody key={key} target={target} onClose={closeQuotePosterDialog} />;
}

const PREF_KEY = "subpodcast.qposter";
const DOWNLOADS_DIR = /^.*\/(Downloads|下载)\//;

interface PosterPrefs {
  theme?: QuotePosterThemeId;
  font?: QuotePosterFontId;
}

function readPrefs(): PosterPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as PosterPrefs;
  } catch {
    return {};
  }
}

function savePrefs(p: PosterPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function toSeconds(ts?: string): number {
  if (!ts) return 0;
  return ts.split(":").reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
}

function looksChineseTitle(s: string): boolean {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 2 >= latin;
}

function QuotePosterDialogBody({
  target,
  onClose,
}: {
  target: QuotePosterTarget;
  onClose: () => void;
}) {
  const t = useT();
  const notify = useStore((s) => s.notify);
  const [prefs] = useState(() => readPrefs());

  const [themeId, setThemeId] = useState<QuotePosterThemeId>(() =>
    QUOTE_POSTER_THEMES.some((x) => x.id === prefs.theme) ? prefs.theme! : QUOTE_POSTER_THEMES[0].id,
  );
  const [fontId, setFontId] = useState<QuotePosterFontId>(() =>
    QUOTE_POSTER_FONTS.some((x) => x.id === prefs.font) ? prefs.font! : QUOTE_POSTER_FONTS[0].id,
  );
  const [input, setInput] = useState<QuotePosterInput | null>(null);
  const [fileTitle, setFileTitle] = useState(() => tNow("声译摘句"));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 组装海报文案与出处：只在打开时跑一次，切主题/字体直接重绘
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ep = target.episode;
        const extracted = extractSelectionQuote({
          selectedText: target.text,
          segments: target.segments,
          zh: target.zh,
          startIdx: target.startIdx,
          endIdx: target.endIdx,
        });

        let zh = extracted.primary;
        let en = extracted.original;
        if (extracted.needsTranslation && zh) {
          const translated = await api
            .translateTexts([zh], "zh-CN")
            .then((arr) => arr[0]?.trim() || "")
            .catch(() => "");
          if (translated) {
            en = zh;
            zh = translated;
          } else {
            en = zh;
            zh = "";
          }
        }

        let titleZh = ep?.title ?? "";
        if (titleZh && !looksChineseTitle(titleZh)) {
          titleZh = await api
            .translateTexts([titleZh], "zh-CN")
            .then((arr) => arr[0]?.trim() || titleZh)
            .catch(() => titleZh);
        }

        const secs = toSeconds(target.ts);
        const url = ep?.videoId
          ? `https://www.youtube.com/watch?v=${ep.videoId}${secs ? `&t=${Math.floor(secs)}s` : ""}`
          : (ep?.link ?? undefined);

        const img = new Image();
        img.src = logoUrl;
        await img.decode().catch(() => {});
        if (!alive) return;
        logoRef.current = img;

        setFileTitle(tNow("声译摘句 {title}", { title: (titleZh || "").slice(0, 20) }).trim());
        setInput({
          zh,
          en,
          title: titleZh,
          // 节目名保留原始名称，方便读者搜索
          show: ep?.showTitle ?? "",
          meta: [
            ep?.published ? new Date(ep.published).toLocaleDateString("zh-CN") : "",
            target.ts ? tNow("第 {ts}", { ts: target.ts }) : "",
          ]
            .filter(Boolean)
            .join(" · "),
          url,
          ts: target.ts,
        });
      } catch (e) {
        if (alive) setError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => {
    if (!input) return;
    let alive = true;
    savePrefs({ theme: themeId, font: fontId });
    void (async () => {
      const theme = QUOTE_POSTER_THEMES.find((x) => x.id === themeId) ?? QUOTE_POSTER_THEMES[0];
      let font = QUOTE_POSTER_FONTS.find((x) => x.id === fontId) ?? QUOTE_POSTER_FONTS[0];
      if (font.stylesheet) {
        setFontBusy(true);
        const ok = await loadQuotePosterFont(font, [input.zh, input.title, input.show].join(""));
        if (!alive) return;
        setFontBusy(false);
        if (!ok) {
          notify(tNow("字体没有加载成功，先用系统字体"));
          font = QUOTE_POSTER_FONTS[0];
        }
      }
      const canvas = await renderQuotePoster(input, logoRef.current, theme, font);
      if (alive) setPreviewUrl(canvas.toDataURL("image/png"));
    })();
    return () => {
      alive = false;
    };
  }, [input, themeId, fontId, notify]);

  const copyImage = async () => {
    if (!previewUrl) return;
    try {
      const blob = await (await fetch(previewUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      notify(t("图片已复制"));
    } catch {
      notify(t("复制失败，请用「保存图片」"));
    }
  };

  const saveImage = async () => {
    if (!previewUrl) return;
    try {
      const cleanName = fileTitle.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Subpodcast";
      const base64 = previewUrl.replace(/^data:image\/png;base64,/, "");
      const path = await api.saveDownload(`${cleanName}.png`, base64, true);
      const shortPath = path.replace(DOWNLOADS_DIR, `${tNow("下载")}/`);
      notify(t("已保存到 {path}", { path: shortPath }), {
        label: t("打开文件夹"),
        run: () => void api.revealFile(path).catch(() => {}),
      });
    } catch (e) {
      notify(errText(e));
    }
  };

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal wide has-foot qposter-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("分享海报")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{t("分享海报")}</h3>
          <button type="button" className="icon-btn" aria-label={t("关闭")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="qposter-layout">
            <div className="qposter-pv">
              {previewUrl ? (
                <img src={previewUrl} alt={t("分享海报")} />
              ) : error ? (
                <p className="error-text">{error}</p>
              ) : (
                <div className="qposter-wait">
                  <Loader2 className="spin" size={18} /> {t("正在生成海报…")}
                </div>
              )}
              {fontBusy && previewUrl && (
                <span className="qposter-busy">
                  <Loader2 className="spin" size={13} /> {t("正在加载字体…")}
                </span>
              )}
            </div>

            <div className="qposter-side">
              <p className="qposter-label">{t("主题")}</p>
              <div className="qposter-themes">
                {QUOTE_POSTER_THEMES.map((th) => (
                  <button
                    key={th.id}
                    type="button"
                    className={`qposter-theme${themeId === th.id ? " on" : ""}`}
                    aria-pressed={themeId === th.id}
                    onClick={() => setThemeId(th.id)}
                  >
                    <span
                      className="swatch"
                      style={{
                        background: th.bgEnd ? `linear-gradient(160deg, ${th.bg}, ${th.bgEnd})` : th.bg,
                      }}
                    >
                      <i style={{ background: th.accent }} />
                      <b style={{ color: th.ink }}>文</b>
                    </span>
                    <span>
                      {t(th.name)} · {t(th.style)}
                    </span>
                  </button>
                ))}
              </div>

              <p className="qposter-label">{t("字体")}</p>
              <div className="qposter-fonts">
                {QUOTE_POSTER_FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`qposter-font${fontId === f.id ? " on" : ""}`}
                    aria-pressed={fontId === f.id}
                    onClick={() => setFontId(f.id)}
                  >
                    <span className="pf-name">{t(f.name)}</span>
                    {f.stylesheet && <span className="pf-note">{t("开源")}</span>}
                  </button>
                ))}
              </div>
              <p className="muted small">{t("开源字体第一次使用时联网下载，只取海报上用到的字。")}</p>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            <X size={14} /> {t("关闭")}
          </button>
          <button type="button" className="btn" onClick={() => void copyImage()} disabled={!previewUrl}>
            <Copy size={14} /> {t("复制图片")}
          </button>
          <button type="button" className="btn primary" onClick={() => void saveImage()} disabled={!previewUrl}>
            {t("保存图片")}
          </button>
        </div>
      </div>
    </div>
  );
}
