import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { logUi } from "../api";
import { Icon } from "../components/Icon";

export type ToastKind = "error" | "info" | "success";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Close the toast after the action runs (default true). */
  dismiss?: boolean;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  actions?: ToastAction[];
  key?: string;
}

export interface NotifyOptions {
  kind?: ToastKind;
  title: string;
  message?: string;
  /** Buttons shown in the toast (e.g. Undo, Unlock). */
  actions?: ToastAction[];
  /** Stays until dismissed (default: auto-hides; longer when it has actions). */
  sticky?: boolean;
  /** Auto-hide delay in ms (ignored when sticky). */
  durationMs?: number;
  /** A toast with the same key is replaced instead of stacked. */
  key?: string;
}

interface ToastApi {
  push(kind: ToastKind, title: string, message?: string): void;
  error(title: string, err?: unknown): void;
  info(title: string, message?: string): void;
  success(title: string, message?: string): void;
  /** Toast with actions / stickiness / a de-duplication key; returns its id. */
  notify(opts: NotifyOptions): number;
  dismiss(id: number): void;
  /** Dismiss the toast with this key, if shown. */
  dismissKey(key: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside provider");
  return v;
}

function msg(e: unknown): string | undefined {
  if (e == null) return undefined;
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * The topmost open modal <dialog>. A modal dialog sits in the browser's top layer, above any
 * z-index, and makes the rest of the page inert — so toasts are portalled into it to stay
 * visible and clickable over the lightbox and other dialogs (UX-008).
 */
function topModal(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return true;
    }
  });
  return open[open.length - 1] ?? null;
}

function useTopModal(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => setHost((cur) => {
      const next = topModal();
      return next === cur ? cur : next;
    });
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"], childList: true });
    return () => mo.disconnect();
  }, []);
  return host;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());
  const keys = useRef(new Map<string, number>());
  const host = useTopModal();

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const h = timers.current.get(id);
    if (h) window.clearTimeout(h);
    timers.current.delete(id);
    for (const [k, v] of keys.current) if (v === id) keys.current.delete(k);
  }, []);

  const notify = useCallback(
    (o: NotifyOptions) => {
      const kind = o.kind ?? "info";
      const old = o.key ? keys.current.get(o.key) : undefined;
      if (old != null) {
        const h = timers.current.get(old);
        if (h) window.clearTimeout(h);
        timers.current.delete(old);
      }
      // Same key: update that toast in place (no re-entry animation), e.g. a countdown.
      const id = old ?? next.current++;
      if (o.key) keys.current.set(o.key, id);
      const t: Toast = { id, kind, title: o.title, message: o.message, actions: o.actions, key: o.key };
      setToasts((list) => (list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? t : x)) : [...list.slice(-4), t]));
      if (!o.sticky) {
        const ms = o.durationMs ?? (kind === "error" ? 9000 : o.actions?.length ? 8000 : 4500);
        timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
      }
      return id;
    },
    [dismiss],
  );

  const push = useCallback((kind: ToastKind, title: string, message?: string) => void notify({ kind, title, message }), [notify]);

  const dismissKey = useCallback(
    (key: string) => {
      const id = keys.current.get(key);
      if (id != null) dismiss(id);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: (title, err) => {
        logUi("error", `toast: ${title}${err === undefined ? "" : ` — ${msg(err)}`}`);
        push("error", title, msg(err));
      },
      info: (title, message) => push("info", title, message),
      success: (title, message) => push("success", title, message),
      notify,
      dismiss,
      dismissKey,
    }),
    [push, notify, dismiss, dismissKey],
  );

  const layer = (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} className="toast__icon" />
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            {t.message && <div className="toast__msg">{t.message}</div>}
            {t.actions && t.actions.length > 0 && (
              <div className="toast__actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="btn btn--sm toast__action"
                    onClick={() => {
                      if (a.dismiss !== false) dismiss(t.id);
                      a.onClick();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {host ? createPortal(layer, host) : layer}
    </Ctx.Provider>
  );
}
