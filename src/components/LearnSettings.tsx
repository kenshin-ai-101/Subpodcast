/**
 * [INPUT]: store.settings；useDict / useWords；exportWords
 * [OUTPUT]: 设置 › 学英语 面板
 * [POS]: SettingsDialog 的 learn 分区
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { LEVELS, loadDict, useDict } from "../lib/dict";
import type { LearnLevel } from "../lib/settings";
import { useWords } from "../lib/words";
import { useStore } from "../store";
import { exportWords } from "./WordsBook";

const DAILY = [10, 20, 30];

export function LearnSettings() {
  const { s, save, set, go } = useStore(
    useShallow((st) => ({
      s: st.settings,
      save: st.saveSettings,
      set: st.set,
      go: st.go,
    })),
  );
  const count = useWords((w) => Object.keys(w.words).length);
  const dictFailed = useDict((d) => d.failed);

  useEffect(() => {
    void useWords.getState().load();
    if (s.learnOn) void loadDict();
  }, [s.learnOn]);

  const exportAs = (kind: "anki" | "csv") =>
    exportWords(
      kind,
      Object.values(useWords.getState().words).sort((x, y) => y.added - x.added),
    );

  return (
    <div className="learn-settings">
      <section className="setup-block">
        <div className="ls-main">
          <div>
            <p className="ls-name">英语学习模式</p>
            <p className="muted small">点单词查释义，生词进生词本，按记忆曲线复习。只对英文节目生效。</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={s.learnOn}
            aria-label="英语学习模式"
            className={`switch ${s.learnOn ? "on" : ""}`}
            onClick={() => void save({ learnOn: !s.learnOn, learnAsked: true })}
          >
            <span />
          </button>
        </div>
        {s.learnOn && dictFailed && (
          <p className="error-text small">词典没能加载，查词暂时用不了。重启声译再试。</p>
        )}
      </section>
      {s.learnOn && (
        <>
          <section className="setup-block">
            <p className="setup-title">水平</p>
            <div className="ls-group">
              <div className="ls-row">
                <span>我的水平</span>
                <div className="seg-control" role="radiogroup" aria-label="我的水平">
                  {LEVELS.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={s.learnLevel === id}
                      className={s.learnLevel === id ? "on" : ""}
                      onClick={() => void save({ learnLevel: id as LearnLevel })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ls-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.learnMark}
                    onChange={(e) => void save({ learnMark: e.target.checked })}
                  />{" "}
                  在字幕里标出超过这个水平的词
                </label>
              </div>
            </div>
          </section>
          <section className="setup-block">
            <p className="setup-title">查词</p>
            <div className="ls-group">
              <div className="ls-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.learnCard}
                    onChange={(e) => void save({ learnCard: e.target.checked })}
                  />{" "}
                  点单词弹出词卡
                </label>
              </div>
              <div className="ls-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.learnAi}
                    onChange={(e) => void save({ learnAi: e.target.checked })}
                  />{" "}
                  用 AI 解释「在这句里」的意思
                </label>
                <button type="button" className="link-btn small" onClick={() => set({ settingsSection: "ai" })}>
                  用「AI」页的默认模型
                </button>
              </div>
            </div>
          </section>
          <section className="setup-block">
            <p className="setup-title">生词本与复习</p>
            <div className="ls-group">
              <div className="ls-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.learnSide}
                    onChange={(e) => void save({ learnSide: e.target.checked })}
                  />{" "}
                  侧栏显示「生词本」
                </label>
              </div>
              <div className="ls-row">
                <span>每天新学</span>
                <div className="seg-control" role="radiogroup" aria-label="每天新学">
                  {DAILY.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={s.learnDaily === n}
                      className={s.learnDaily === n ? "on" : ""}
                      onClick={() => void save({ learnDaily: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ls-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.learnRemind}
                    onChange={(e) => void save({ learnRemind: e.target.checked })}
                  />{" "}
                  打开声译时，有要复习的词就提醒我
                </label>
              </div>
              <div className="ls-row">
                <span>生词本 {count} 个词</span>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!count}
                    onClick={() => {
                      set({ settingsOpen: false, settingsSection: null });
                      go({ kind: "words" });
                    }}
                  >
                    查看
                  </button>
                  <button type="button" className="btn sm" disabled={!count} onClick={() => void exportAs("anki")}>
                    导出 Anki
                  </button>
                  <button type="button" className="btn sm" disabled={!count} onClick={() => void exportAs("csv")}>
                    导出 CSV
                  </button>
                </div>
              </div>
            </div>
            <p className="muted small">词典来自开源的 ECDICT，离线可用。</p>
          </section>
        </>
      )}
    </div>
  );
}
