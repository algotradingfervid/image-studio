import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level safety net: a render error (e.g. a context mismatch after a hot
 * reload) shows a recoverable panel instead of a blank window.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[ui] render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash__panel">
          <h1 className="crash__title">Something went wrong</h1>
          <p className="crash__message">{error.message || "Unknown error"}</p>
          {error.stack && (
            <details className="crash__details">
              <summary>Details</summary>
              <pre className="mono">{error.stack}</pre>
            </details>
          )}
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()} autoFocus>
            Reload
          </button>
          <p className="hint crash__note">The GPU keeps running in the background — use Stop after reloading if needed.</p>
        </div>
      </div>
    );
  }
}
