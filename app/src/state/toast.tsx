import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";

export type ToastKind = "error" | "info" | "success";
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastApi {
  push(kind: ToastKind, title: string, message?: string): void;
  error(title: string, err?: unknown): void;
  info(title: string, message?: string): void;
  success(title: string, message?: string): void;
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const h = timers.current.get(id);
    if (h) window.clearTimeout(h);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, message?: string) => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-4), { id, kind, title, message }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), kind === "error" ? 9000 : 4500));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      error: (title, err) => push("error", title, msg(err)),
      info: (title, message) => push("info", title, message),
      success: (title, message) => push("success", title, message),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} className="toast__icon" />
            <div className="toast__body">
              <div className="toast__title">{t.title}</div>
              {t.message && <div className="toast__msg">{t.message}</div>}
            </div>
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
