import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Can `el` take focus back now (still in the page, enabled, rendered)? */
function canFocus(el: HTMLElement | null | undefined): boolean {
  return !!el && el.isConnected && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0;
}

/**
 * Modal built on the native <dialog> element: Esc and backdrop for free; Tab / Shift+Tab
 * cycle inside the dialog (the browser alone would let focus escape to its own chrome).
 * On close, focus goes back to the control that opened it, or to `returnFocusRef` when that
 * control is gone, disabled or hidden (UI-006), never to <body>.
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
  returnFocusRef,
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
  /** Focused on close when the opener can't take focus back (it was removed, swapped or disabled). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const opener = useRef<HTMLElement | null>(null);
  const returnRef = useRef(returnFocusRef);
  returnRef.current = returnFocusRef;

  // Remember the opener while rendering the open, before this commit can disable or swap it
  // (the browser then moves focus to <body> before any effect could read it).
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const at = document.activeElement;
    opener.current = at instanceof HTMLElement && at !== document.body && !ref.current?.contains(at) ? at : null;
  }
  wasOpen.current = open;

  // Runs after the caller's own close handling, so a caller that already moved focus somewhere
  // (outside the dialog, not <body>) keeps it. An opener that is still in the page but disabled
  // (its handler is awaiting the answer) gets a few frames to re-enable before the fallback.
  const restoreFocus = (frames = 10) => {
    const at = document.activeElement;
    if (at && at !== document.body && at.isConnected && !ref.current?.contains(at)) {
      opener.current = null;
      return;
    }
    const o = opener.current;
    if (o && canFocus(o)) {
      opener.current = null;
      o.focus();
    } else if (o?.isConnected && frames > 0) {
      requestAnimationFrame(() => restoreFocus(frames - 1));
    } else {
      opener.current = null;
      const fallback = returnRef.current?.current;
      if (fallback && canFocus(fallback)) fallback.focus();
    }
  };

  // `shown`, not `d.open`: Esc can close the native dialog before `open` turns false (the browser
  // then puts focus on <body> itself), and focus must still come back.
  const shown = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      shown.current = true;
      initialFocusRef?.current?.focus();
    } else if (!open && shown.current) {
      shown.current = false;
      if (d.open) d.close();
      restoreFocus();
    }
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
    return () => {
      d.removeEventListener("cancel", onCancel);
      // Unmounted while open (its screen went away): the dialog took focus with it.
      if (opener.current) restoreFocus();
    };
  }, []);

  const autoId = useId();
  const titleId = labelledBy ?? autoId;
  return (
    <dialog
      ref={ref}
      className={`dialog ${className ?? ""}`}
      aria-labelledby={title || labelledBy ? titleId : undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (!e.defaultPrevented) trapTab(e);
      }}
      aria-modal="true"
      // Close on a full click on the backdrop (press and release both outside the box). Closing
      // on mousedown let the release land on the page behind and click it (UX-065).
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        const wasDown = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (wasDown && e.target === ref.current) onClose();
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
  valueText,
}: {
  value: number;
  label: string;
  indeterminate?: boolean;
  tone?: "accent" | "warn" | "muted";
  /** Spoken instead of the bare percentage ("Image 2 of 4 · step 13 of 40"). */
  valueText?: string;
}) {
  return (
    <div
      className={`progress ${indeterminate ? "progress--indeterminate" : ""} ${tone ? `progress--${tone}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuetext={valueText}
    >
      <div className="progress__fill" style={indeterminate ? undefined : { width: `${value}%` }} />
    </div>
  );
}
