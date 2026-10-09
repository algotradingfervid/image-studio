// The one confirmation shown before any click that would start a stopped (billed) GPU pod.
// Opened only through `useGpu().confirmStart()` / `useGpu().start()` (state/gpu.tsx).

import { useRef, type KeyboardEvent } from "react";
import type { GpuProfile } from "../api";
import { formatUsd } from "../lib/format";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/** Where each profile's pod runs (spec v5). */
export const PROFILE_POD: Record<GpuProfile, { pod: string; region: string }> = {
  image: { pod: "Images pod", region: "EU-RO-1 (Romania)" },
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
  onAnswer,
}: {
  open: boolean;
  info: StartGpuInfo | null;
  /** What the start is for ("generate", "download Flux.2"); omitted for a plain Start. */
  action?: string;
  onAnswer: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const price = info ? `~${formatUsd(info.costPerHr)}/h` : "";
  const where = info ? PROFILE_POD[info.profile] : null;
  const which = info?.profile === "video" ? "video GPU" : "Images GPU";

  // Enter confirms (Cancel / ✕ keep their own meaning); a held key's repeats are ignored so the
  // ⌘Enter that opened the dialog can't also confirm it.
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
      initialFocusRef={confirmRef}
      onKeyDown={onKeyDown}
      title={action ? `Start the ${which} to ${action}?` : `Start the ${which}?`}
      footer={
        <>
          <button type="button" className="btn" data-cancel onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="btn btn--primary" onClick={() => onAnswer(true)}>
            <Icon name="bolt" /> Start GPU ({price})
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
            <dt>Price</dt>
            <dd>
              <strong className="mono">{price}</strong>
              {info.costKnown ? "" : " or less, depending on the GPU it gets"}
            </dd>
            <dt>Billing</dt>
            <dd>
              Bills until you stop it, or until it auto-stops after <strong>{info.idleMinutes} idle minutes</strong>.
            </dd>
          </dl>
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
