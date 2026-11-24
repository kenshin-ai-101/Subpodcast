/**
 * [INPUT]: React Component ErrorBoundary
 * [OUTPUT]: ErrorBoundary — 捕获渲染异常，防止局部视图报错导致整窗白屏
 * [POS]: 包裹 App 主内容区与复杂弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { tNow } from "../lib/i18n";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Subpodcast ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-empty" style={{ padding: 32 }}>
        <p className="lead">{this.props.fallbackTitle ?? tNow("页面加载出了点问题")}</p>
        <p className="muted small" style={{ maxWidth: 420, wordBreak: "break-word" }}>
          {this.state.error.message || tNow("发生未知错误")}
        </p>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => this.setState({ error: null })}
        >
          {tNow("重试渲染")}
        </button>
      </div>
    );
  }
}
