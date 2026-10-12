import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
  /** Runs once when the toast goes away without one of its actions (timeout, ✕, pushed out). */
  onClose?: () => void;
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

/** Most toasts shown at once; older ones give way (UI-020). */
const MAX_SHOWN = 3;

/**
 * How long a toast stays (UI-022): reading time at ~4 words a second plus a margin, at least
 * 6 s, at least 10 s with an action (Undo, Unlock) and for errors.
 */
function lifetime(t: { kind: ToastKind; title: string; message?: string; actions?: ToastAction[] }): number {
  const words = `${t.title} ${t.message ?? ""}`.trim().split(/\s+/).length;
  const read = 2000 + words * 250;
  return Math.max(read, t.actions?.length || t.kind === "error" ? 10_000 : 6000);
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

/** Sticky action bars toasts must never cover (Settings' Save bar, any `[data-sticky-bar]`). */
const STICKY_BARS = "[data-sticky-bar], .settings-bar";

/**
 * Keeps the toast stack clear of sticky action bars: it sits above the highest one it would
 * overlap. Scrolling pages keep fixed room at their end for the stack (styles/jobs.css).
 */
function useClearOfStickyBars(layerRef: RefObject<HTMLDivElement | null>, count: number) {
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      frame = 0;
      const layer = layerRef.current;
      if (!layer) return;
      const vh = window.innerHeight;
      let bottom = BASE_BOTTOM;
      const box = layer.getBoundingClientRect();
      for (const bar of document.querySelectorAll<HTMLElement>(STICKY_BARS)) {
        const r = bar.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom <= 0 || r.top >= vh) continue;
        // Only bars under the stack's column.
        if (r.right < box.left || r.left > box.right) continue;
        bottom = Math.max(bottom, vh - r.top + 10);
      }
      layer.style.bottom = `${bottom}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "open"] });
    const ro = new ResizeObserver(schedule);
    if (layerRef.current) ro.observe(layerRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      mo.disconnect();
      ro.disconnect();
    };
  }, [layerRef, count]);
}

/** The stack's distance from the window's bottom edge with nothing to avoid. */
const BASE_BOTTOM = 18;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  /** Auto-hide timers: the handle while counting, and the time left (kept while paused). */
  const timers = useRef(new Map<number, { handle: number | null; left: number; since: number }>());
  /** Toasts under the pointer or holding focus: their timers wait (UI-022). */
  const held = useRef(new Set<number>());
  const keys = useRef(new Map<string, number>());
  const closers = useRef(new Map<number, () => void>());
  const shown = useRef<Toast[]>([]);
  shown.current = toasts;
  const host = useTopModal();
  const layerRef = useRef<HTMLDivElement>(null);
  useClearOfStickyBars(layerRef, toasts.length);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const close = closers.current.get(id);
    closers.current.delete(id);
    close?.();
    const h = timers.current.get(id);
    if (h?.handle) window.clearTimeout(h.handle);
    timers.current.delete(id);
    held.current.delete(id);
    for (const [k, v] of keys.current) if (v === id) keys.current.delete(k);
  }, []);

  const notify = useCallback(
    (o: NotifyOptions) => {
      const kind = o.kind ?? "info";
      const old = o.key ? keys.current.get(o.key) : undefined;
      if (old != null) {
        const h = timers.current.get(old);
        if (h?.handle) window.clearTimeout(h.handle);
        timers.current.delete(old);
      }
      // Same key: update that toast in place (no re-entry animation), e.g. a countdown.
      const id = old ?? next.current++;
      if (o.key) keys.current.set(o.key, id);
      const t: Toast = { id, kind, title: o.title, message: o.message, actions: o.actions, key: o.key };
      if (o.onClose) closers.current.set(id, o.onClose);
      else closers.current.delete(id);
      const isNew = !shown.current.some((x) => x.id === id);
      // Pushed out by a newer toast: dismissed properly (timer cleared, onClose run).
      if (isNew) shown.current.slice(0, Math.max(0, shown.current.length - (MAX_SHOWN - 1))).forEach((x) => dismiss(x.id));
      setToasts((list) => (list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? t : x)) : [...list.slice(-(MAX_SHOWN - 1)), t]));
      if (!o.sticky) {
        const ms = Math.max(o.durationMs ?? 0, lifetime(t));
        const paused = held.current.has(id);
        timers.current.set(id, { handle: paused ? null : window.setTimeout(() => dismiss(id), ms), left: ms, since: Date.now() });
      }
      return id;
    },
    [dismiss],
  );

  // Hover or focus inside a toast holds its timer; leaving restarts it with the time it had left.
  const hold = useCallback((id: number, on: boolean) => {
    const t = timers.current.get(id);
    if (on) {
      held.current.add(id);
      if (t?.handle) {
        window.clearTimeout(t.handle);
        timers.current.set(id, { handle: null, left: Math.max(0, t.left - (Date.now() - t.since)), since: Date.now() });
      }
    } else {
      held.current.delete(id);
      if (t && !t.handle) {
        const left = Math.max(t.left, 2000);
        timers.current.set(id, { handle: window.setTimeout(() => dismiss(id), left), left, since: Date.now() });
      }
    }
  }, [dismiss]);

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
    <div className="toasts" ref={layerRef} aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
          onMouseEnter={() => hold(t.id, true)}
          onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && hold(t.id, false)}
          onFocus={() => hold(t.id, true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover") && hold(t.id, false)}
        >
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
                      // An action is not a close: onClose (e.g. "finalise unless undone") doesn't run.
                      if (a.dismiss !== false) {
                        closers.current.delete(t.id);
                        dismiss(t.id);
                      }
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
