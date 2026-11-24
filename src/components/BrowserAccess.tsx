/**
 * [INPUT]: api.openPrivacySettings；Tauri 窗口 focus
 * [OUTPUT]: BrowserAccess 组件、browserName
 * [POS]: ImportPanel 在 macOS 拒绝读浏览器数据时展示的引导
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";

const NAMES: Record<string, string> = {
  chrome: "Chrome",
  safari: "Safari",
  edge: "Edge",
  firefox: "Firefox",
  brave: "Brave",
  chromium: "Chromium",
  opera: "Opera",
  vivaldi: "Vivaldi",
};

export const browserName = (b: string) => NAMES[b] ?? b;

export function BrowserAccess({ browser, onRetry }: { browser: string; onRetry: () => void }) {
  const t = useT();
  const name = browserName(browser);
  useEffect(() => {
    let armed = false;
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) armed = true;
      else if (armed) {
        armed = false;
        onRetry();
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, [browser, onRetry]);

  return (
    <div className="browser-access">
      <p>{t("macOS 需要你允许声译读取 {name} 的数据，才能借用它的 YouTube 登录。", { name })}</p>
      <ol className="small">
        <li>{t("点下面的按钮打开「文件和文件夹」")}</li>
        <li>{t("在声译下打开「{name}」", { name })}</li>
        <li>{t("回到声译，会自动重试")}</li>
      </ol>
      <div className="row-actions">
        <button className="btn primary sm" onClick={() => void api.openPrivacySettings()}>
          {t("打开系统设置")}
        </button>
        <button className="btn ghost sm" onClick={onRetry}>
          {t("重试")}
        </button>
      </div>
    </div>
  );
}
