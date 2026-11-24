/**
 * [INPUT]: store.settings；api.hasApiKey；GROUPS；Seg
 * [OUTPUT]: ModelSettings（本机 AI 空态 + API 模型列表 + 问答/翻译分用）
 * [POS]: 设置 › AI；布局对齐 SubCast，本机 Agent 检测留二期
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown } from "lucide-react";
import type { Provider } from "../lib/settings";
import { GROUPS } from "../lib/settings";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Seg } from "./ReadingSettings";

function Mark({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const letters = name
    .replace(/[（(].*$/, "")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="ms-mark" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {letters || id.slice(0, 2).toUpperCase()}
    </span>
  );
}

const RECOMMENDED = ["deepseek", "siliconflow", "openrouter"];
const SHOWN = 3;

export function ModelSettings({
  ProviderEditor,
}: {
  ProviderEditor: (props: { p: Provider; onChange: (p: Provider) => void }) => ReactElement;
}) {
  const t = useT();
  const { settings, saveSettings } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings })));
  const [editing, setEditing] = useState(settings.chatProvider);
  const [more, setMore] = useState(false);
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const apiProviders = useMemo(() => Object.values(settings.providers), [settings.providers]);

  useEffect(() => {
    void Promise.all(apiProviders.filter((p) => p.needsKey).map(async (p) => [p.id, await api.hasApiKey(p.id)] as const)).then((r) =>
      setKeys(Object.fromEntries(r)),
    );
  }, [apiProviders.length, editing]);

  const used = (id: string) => (settings.translateProvider === id && settings.translateMode !== "google" ? t("默认") : "");
  const ready = (p: Provider) => !p.needsKey || keys[p.id];
  const inUse = (id: string) => settings.chatProvider === id || settings.translateProvider === id;
  const rank = (p: Provider) => (inUse(p.id) ? 0 : p.needsKey && keys[p.id] ? 1 : RECOMMENDED.includes(p.id) ? 2 + RECOMMENDED.indexOf(p.id) : 9);
  const ranked = apiProviders.filter((p) => p.id !== "custom" && rank(p) < 9).sort((a, b) => rank(a) - rank(b));
  const mine = ranked.filter((p, i) => i < SHOWN || p.id === editing);
  const rest = apiProviders.filter((p) => !mine.includes(p) && p.id !== "custom");
  const custom = settings.providers.custom;
  const p = settings.providers[editing];

  const update = (np: Provider) =>
    void saveSettings({
      providers: { ...settings.providers, [np.id]: np },
      ...(np.id === settings.chatProvider && np.model !== p?.model ? { chatModel: "" } : {}),
    });

  const nameOf = (id: string) => (settings.providers[id]?.name ? t(settings.providers[id]!.name) : "");
  const google = settings.translateMode === "google";
  const translateName = google ? t("谷歌翻译（免费）") : nameOf(settings.translateProvider) || t("没有设置");
  const split = google || settings.chatProvider !== settings.translateProvider;
  const [advanced, setAdvanced] = useState(split);

  const choices = apiProviders.filter(ready).map((x) => ({ id: x.id, name: t(x.name) }));
  const withCurrent = (id: string) => (choices.some((c) => c.id === id) || !settings.providers[id] ? choices : [...choices, { id, name: nameOf(id) }]);

  return (
    <div className="ms">
      <div className="ms-uses">
        <div className="ms-use">
          {split ? (
            <b>
              {t("问答")}：{nameOf(settings.chatProvider) || t("没有设置")} · {t("字幕翻译")}：{translateName}
            </b>
          ) : (
            <b>
              {t("当前")}：{nameOf(settings.chatProvider) || t("没有设置")}
              <span className="muted small"> · {t("管问答和翻译")}</span>
            </b>
          )}
        </div>
      </div>
      <div className="ms-split">
        <aside className="ms-list">
          <div className="ms-group-h">
            <span>
              {t("API 模型")}<em>{t("填 Key 使用，按量付费")}</em>
            </span>
          </div>
          {mine.map((x) => (
            <button key={x.id} type="button" className={`ms-item ${editing === x.id ? "on" : ""}`} onClick={() => setEditing(x.id)}>
              <Mark id={x.id} name={t(x.name)} />
              <span className="ms-item-name">
                {t(x.name)}
                <small>{used(x.id) || (ready(x) ? t("已填 Key") : t("未设置"))}</small>
              </span>
              <span className={`ms-dot ${ready(x) ? "ok" : "idle"}`} />
            </button>
          ))}
          {custom && (
            <button type="button" className={`ms-item slim ${editing === custom.id ? "on" : ""}`} onClick={() => setEditing(custom.id)}>
              <Mark id={custom.id} name={t(custom.name)} size={20} />
              <span className="ms-item-name">{t(custom.name)}</span>
            </button>
          )}
          <button type="button" className="ms-more" aria-expanded={more} onClick={() => setMore(!more)}>
            <ChevronDown size={13} className={more ? "flip" : ""} /> {more ? t("收起") : t("更多服务商（{n}）", { n: rest.length })}
          </button>
          {more &&
            GROUPS.map((g) => {
              const list = rest.filter((x) => (x.group ?? "provider") === g.id);
              if (!list.length) return null;
              return (
                <div key={g.id}>
                  <p className="ms-sub-h">{t(g.name)}</p>
                  {list.map((x) => (
                    <button key={x.id} type="button" className={`ms-item slim ${editing === x.id ? "on" : ""}`} onClick={() => setEditing(x.id)}>
                      <Mark id={x.id} name={t(x.name)} size={20} />
                      <span className="ms-item-name">{t(x.name)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
        </aside>
        <section className="ms-detail">
          {p && (
            <>
              <div className="ms-head">
                <Mark id={p.id} name={t(p.name)} size={36} />
                <div>
                  <p className="ms-title">{t(p.name)}</p>
                  <p className="muted small">
                    {p.needsKey ? t("用你自己的 API Key，按用量付费给服务商。Key 只保存在本机。") : t("在你电脑上运行的模型服务，不需要 Key。")}
                  </p>
                </div>
              </div>
              <ProviderEditor key={p.id} p={p} onChange={update} />
            </>
          )}
        </section>
      </div>
      <button type="button" className="ms-more ms-adv" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        <ChevronDown size={13} className={advanced ? "flip" : ""} /> {t("问答和翻译分别用不同模型")}
      </button>
      {advanced && (
        <div className="setup-block ms-adv-body">
          <div className="reading-row">
            <span>{t("问答")}</span>
            <select value={settings.chatProvider} onChange={(e) => void saveSettings({ chatProvider: e.target.value, chatModel: "" })}>
              {withCurrent(settings.chatProvider).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="reading-row">
            <span>{t("字幕翻译")}</span>
            <select
              value={google ? "google" : settings.translateProvider}
              onChange={(e) =>
                void saveSettings(
                  e.target.value === "google"
                    ? { translateMode: "google" }
                    : { translateMode: "auto", translateProvider: e.target.value },
                )
              }
            >
              <option value="google">{t("谷歌翻译（免费）")}</option>
              {withCurrent(settings.translateProvider).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {!google && (
            <>
              <div className="reading-row">
                <span>{t("翻译方式")}</span>
                <Seg
                  value={settings.translateQuality}
                  options={
                    [
                      ["fast", t("快速")],
                      ["best", t("精翻")],
                    ]
                  }
                  onChange={(q) => void saveSettings({ translateQuality: q })}
                />
              </div>
              <p className="muted small">
                {settings.translateQuality === "best" ? t("翻完再通读润色一遍，更准，时间和费用约多一倍。") : t("一遍翻完，最快。")}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
