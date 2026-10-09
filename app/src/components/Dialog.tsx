import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal built on the native <dialog> element: Esc and backdrop for free; Tab / Shift+Tab
 * cycle inside the dialog (the browser alone would let focus escape to its own chrome).
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  labelledBy,
  initialFocusRef,
  onKeyDown,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  labelledBy?: string;
  /** Focused once the dialog opens (otherwise the browser focuses the first control: the close button). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      initialFocusRef?.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open, initialFocusRef]);

  const trapTab = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !ref.current.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !ref.current.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, []);

  const autoId = useId();
  const titleId = labelledBy ?? autoId;
  return (
    <dialog
      ref={ref}
      className={`dialog ${className ?? ""}`}
      aria-labelledby={title ? titleId : undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented) trapTab(e);
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog__inner">
          {title && (
            <header className="dialog__head">
              <h2 id={titleId} className="dialog__title">
                {title}
              </h2>
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
                <Icon name="x" />
              </button>
            </header>
          )}
          <div className="dialog__body">{children}</div>
          {footer && <footer className="dialog__foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function ProgressBar({
  value,
  label,
  indeterminate,
  tone,
}: {
  value: number;
  label: string;
  indeterminate?: boolean;
  tone?: "accent" | "warn" | "muted";
}) {
  return (
    <div
      className={`progress ${indeterminate ? "progress--indeterminate" : ""} ${tone ? `progress--${tone}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
    >
      <div className="progress__fill" style={indeterminate ? undefined : { width: `${value}%` }} />
    </div>
  );
}
