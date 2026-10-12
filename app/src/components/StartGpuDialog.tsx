// The one confirmation shown before any click that would start a stopped (billed) GPU pod.
// Opened only through `useGpu().confirmStart()` / `useGpu().start()` (state/gpu.tsx).

import { useRef, type KeyboardEvent } from "react";
import type { GpuProfile } from "../api";
import { formatUsd } from "../lib/format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/** Where each profile's pod runs (spec v5); one pattern for both, "Country (datacenter)" (UI-077). */
export const PROFILE_POD: Record<GpuProfile, { pod: string; region: string }> = {
  image: { pod: "Images pod", region: "Romania (EU-RO-1)" },
  video: { pod: "Video pod", region: "Canada (CA-MTL-3)" },
};

export interface StartGpuInfo {
  profile: GpuProfile;
  /** The pod's GPU when known, else the first-choice GPU ("RTX PRO 6000 or the next available GPU"). */
  gpu: string;
  /** Same source as the GPU pill: the pod's price when known, else the settings fallback. */
  costPerHr: number;
  /** True when the price is the pod's own (not the "or less" estimate). */
  costKnown: boolean;
  idleMinutes: number;
}

export function StartGpuDialog({
  open,
  info,
  action,
  details,
  confirmLabel,
  selfStopOff,
  danger,
  licence,
  warnings,
  onAnswer,
}: {
  open: boolean;
  info: StartGpuInfo | null;
  /** What the start is for ("generate", "download Flux.2"); omitted for a plain Start. */
  action?: string;
  /** Extra facts about the action (size, free space, token status), one line each (UX-031). */
  details?: string[];
  /** Names the outcome on the confirm button ("Start GPU & download 17.2 GB"). */
  confirmLabel?: string;
  /** "Let the pod stop itself when idle" is off: the pod keeps billing if the app closes. */
  selfStopOff?: boolean;
  /** The confirm destroys data (a delete that needs the GPU): danger styling instead of primary (UI-019). */
  danger?: boolean;
  /** A licence / region restriction of what will run, shown as its own row (UI-054). */
  licence?: string;
  /** Amber notices before the price is committed (e.g. a gated model's download may fail). */
  warnings?: string[];
  onAnswer: (ok: boolean) => void;
}) {
  // Opens on Cancel, as every paid or destructive confirm does: a habitual Enter must not start a
  // billed pod (UI-005). Tab reaches the Start button.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const price = info ? `~${formatUsd(info.costPerHr)}/h` : "";
  const where = info ? PROFILE_POD[info.profile] : null;
  // Same casing as the header pills and every other GPU title (UI-054).
  const which = info?.profile === "video" ? "Video GPU" : "Images GPU";

  // Enter activates the focused button (Cancel and ✕ cancel; Start or any other control inside
  // confirms); a held key's repeats are ignored so the ⌘Enter that opened the dialog can't act on it.
  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-cancel], .dialog__head button")) onAnswer(false);
    else onAnswer(true);
  };

  return (
    <Dialog
      open={open}
      onClose={() => onAnswer(false)}
      className="start-gpu"
      initialFocusRef={cancelRef}
      onKeyDown={onKeyDown}
      title={action ? `Start the ${which} to ${action}?` : `Start the ${which}?`}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn" data-cancel onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "btn--danger" : "btn--primary"}`} onClick={() => onAnswer(true)}>
            <Icon name={danger ? "trash" : "bolt"} /> {confirmLabel ? `${confirmLabel} (${price})` : `Start GPU (${price})`}
          </button>
        </>
      }
    >
      {info && where && (
        <>
          <dl className="start-gpu__facts">
            <dt>Pod</dt>
            <dd>
              {where.pod} · {where.region}
            </dd>
            <dt>GPU</dt>
            <dd>{info.gpu}</dd>
            {licence && (
              <>
                <dt>Licence</dt>
                <dd>{licence}</dd>
              </>
            )}
            <dt>Price</dt>
            <dd>
              <strong className="mono">{price}</strong>
              {info.costKnown ? "" : " or less, depending on the GPU it gets"}
            </dd>
            <dt>Billing</dt>
            <dd>
              Bills until you stop it, or until it auto-stops after <strong>{info.idleMinutes} idle minutes</strong>
              {selfStopOff ? " while the app is open" : ""}.
              {action && !/^generate|^make|^create/i.test(action) ? " Started only for this, it stops again when the work finishes." : ""}
            </dd>
          </dl>
          {details && details.length > 0 && (
            <ul className="plain start-gpu__details">
              {details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          {warnings?.map((w) => (
            <p key={w} className="notice notice--warn" role="alert">
              <Icon name="alert" /> {w}
            </p>
          ))}
          {selfStopOff && (
            <p className="notice notice--warn">
              <Icon name="alert" /> “Let the pod stop itself when idle” is off: if this app quits or crashes, the pod keeps billing until you stop it.
            </p>
          )}
          <p className="hint">
            {action
              ? "Starting takes a few minutes; the work waits in the queue until the GPU is ready."
              : "Starting takes a few minutes."}{" "}
            Cancel starts nothing.
          </p>
        </>
      )}
    </Dialog>
  );
}
