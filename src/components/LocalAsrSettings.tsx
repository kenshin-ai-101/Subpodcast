/**
 * [INPUT]: useAsrModels、store.settings、confirm.ask
 * [OUTPUT]: LocalAsrPicker — 设置 › 字幕 › 本机模型列表
 * [POS]: 从 SettingsDialog 拆出，保持设置壳轻量
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Trash2, X } from "lucide-react";
import { errText } from "../lib/api";
import { useAsrModels } from "../lib/asrModels";
import { ask } from "../lib/confirm";
import { useT } from "../lib/i18n";
import { useStore } from "../store";

export function LocalAsrPicker() {
  const t = useT();
  const { settings, saveSettings, notify } = useStore(
    useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, notify: s.notify })),
  );
  const { models, loading, downloading, error, refresh, rescan, download, remove, cancelDownload } = useAsrModels(
    useShallow((s) => ({
      models: s.models,
      loading: s.loading,
      downloading: s.downloading,
      error: s.error,
      refresh: s.refresh,
      rescan: s.rescan,
      download: s.download,
      remove: s.remove,
      cancelDownload: s.cancelDownload,
    })),
  );
  const [more, setMore] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const main = models.filter((m) => m.id === "qwen3-asr" || settings.asrModel === m.id);
  const rest = models.filter((m) => m.id !== "qwen3-asr");
  const shown = more ? models : main.length ? main : models.slice(0, 1);

  return (
    <div className="provider-form">
      <p className="muted small">{t("音频留在本机。会自动复用 SubCast / HF 缓存里已有的同名模型，不必重复下载。")}</p>
      {error && <p className="muted small">{error}</p>}
      {loading && !models.length ? (
        <p className="muted small">{t("读取模型列表…")}</p>
      ) : (
        <div className="asr-model-list">
          {shown.map((m) => {
            const on = settings.asrModel === m.id;
            const dl = downloading[m.id];
            const busy = dl != null;
            return (
              <div key={m.id} className={`asr-model-row ${on ? "on" : ""}`}>
                <button
                  type="button"
                  className="asr-model-pick"
                  onClick={() => void saveSettings({ asrEngine: "local", asrModel: m.id })}
                >
                  <span className="asr-model-name">{m.name}</span>
                  <span className="muted small">
                    {m.sizeMb} MB · {m.engine === "qwen3" ? "Qwen3" : "Whisper"}
                  </span>
                  {m.note && <span className="muted small">{m.note}</span>}
                </button>
                <div className="asr-model-actions">
                  {busy ? (
                    <>
                      <span className="muted small">{Math.round((dl ?? 0) * 100)}%</span>
                      <button type="button" className="btn ghost sm" onClick={() => void cancelDownload(m.id)}>
                        {t("取消")}
                      </button>
                    </>
                  ) : m.installed && m.from ? (
                    <>
                      <span className="from-tag small">{t("来自 {from}", { from: m.from })}</span>
                      <button
                        type="button"
                        className="icon-btn sm"
                        title={t("不再使用（原文件保留）")}
                        onClick={() => void remove(m.id).catch((e) => notify(errText(e)))}
                      >
                        <X size={14} />
                      </button>
                    </>
                  ) : m.installed ? (
                    <>
                      <span className="ok-text small">
                        <Check size={13} /> {t("已下载")}
                      </span>
                      <button
                        type="button"
                        className="icon-btn sm"
                        title={t("删除模型")}
                        onClick={() =>
                          void ask(t("删除「{name}」？以后生成字幕需要重新下载。", { name: m.name })).then((ok) => {
                            if (ok) void remove(m.id).catch((e) => notify(errText(e)));
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void download(m.id).catch((e) => notify(errText(e)))}
                    >
                      {t("下载")}
                    </button>
                  )}
                </div>
                {busy && (
                  <div className="asr-bar thin">
                    <span style={{ width: `${Math.round((dl ?? 0) * 100)}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="row-actions" style={{ marginTop: 8, gap: 8, display: "flex", flexWrap: "wrap" }}>
        {!more && rest.length > 0 && (
          <button type="button" className="btn ghost sm" onClick={() => setMore(true)}>
            {t("其他模型（Whisper）")}
          </button>
        )}
        <button type="button" className="btn ghost sm" disabled={loading} onClick={() => void rescan()}>
          {t("重新查找本机模型")}
        </button>
      </div>
    </div>
  );
}
