import { useState } from "react";
import type { GpuProfile } from "../api";
import { formatElapsed, formatUsd, toDate } from "../lib/format";
import { useNow } from "../lib/useNow";
import { PROFILES, PROFILE_LABEL, useGpu } from "../state/gpu";
import { Icon } from "./Icon";

export { useNow };

/**
 * Header GPU pills: one per profile (Images, Video) that isn't stopped, each with its own
 * Stop / Retry. With both stopped, one compact "GPU stopped · Start" pill (starts the image
 * profile). Hidden for the serverless backend.
 */
export function GpuPills() {
  const gpu = useGpu();
  if (!gpu.podMode) return null;
  const shown = PROFILES.filter((p) => {
    const g = gpu.profiles[p].state;
    return g && g.status !== "stopped";
  });
  if (shown.length === 0) {
    return gpu.profiles.image.state ? <GpuPill profile="image" /> : null;
  }
  return (
    <div className={`gpu-pills ${shown.length > 1 ? "gpu-pills--dual" : ""}`}>
      {shown.map((p) => (
        <GpuPill key={p} profile={p} />
      ))}
    </div>
  );
}

/** One profile's pill: status, live elapsed time and cost, Start/Stop. */
export function GpuPill({ profile = "image" }: { profile?: GpuProfile }) {
  const gpu = useGpu();
  const info = gpu.profiles[profile];
  const g = info.state;
  const running = g?.status === "running";
  const now = useNow(running);
  const [busy, setBusy] = useState(false);

  if (!gpu.podMode || !g) return null;

  const label = PROFILE_LABEL[profile];
  const what = profile === "video" ? "video GPU" : "GPU";
  const aria = `${label} GPU status`;
  const start = async () => {
    setBusy(true);
    await gpu.start(profile);
    setBusy(false);
  };
  const stop = () => gpu.stop(profile);

  switch (g.status) {
    case "stopped":
      return (
        <div className="gpu-pill gpu-pill--stopped" role="status" aria-label={aria}>
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text">GPU stopped</span>
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={start} disabled={busy} title={`Start the ${what} pod (${info.startTarget}, ${info.costLabel})`}>
            <Icon name="bolt" size={13} /> Start
          </button>
        </div>
      );
    case "starting":
      return (
        <div className="gpu-pill gpu-pill--starting" role="status" aria-label={aria}>
          <Icon name="refresh" size={13} className="spin" />
          <span className="gpu-pill__text" title={`${label} · starting ${info.startTarget} · ${info.costLabel}`}>
            <span className="gpu-pill__profile">{label}</span>
            <span className="gpu-pill__gpu"> · Starting</span>
            {g.phase ? ` · ${g.phase}` : "…"}
          </span>
          <button type="button" className="btn btn--sm btn--ghost gpu-pill__btn" onClick={stop} title={`Cancel the start and remove the ${what} pod`} aria-label={`Stop the ${what}`}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      );
    case "running": {
      const started = toDate(g.startedAt);
      const ms = started ? now - started.getTime() : 0;
      const cost = (Math.max(0, ms) / 3_600_000) * info.costPerHr;
      const noWatchdog = g.watchdogArmed === false;
      const watchdogMsg = `The ${what} pod can't auto-stop itself — the app will stop it after ${info.idleMinutes} idle min; keep the app open or stop manually.`;
      return (
        <div className={`gpu-pill gpu-pill--running gpu-pill--${profile}`} role="status" aria-label={aria}>
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text" title={`${label} · ${g.gpuType ?? info.gpuName} · ${formatUsd(info.costPerHr)}/h · auto-stops after ${info.idleMinutes} idle min`}>
            <span className="gpu-pill__profile">{label}</span>
            <span className="gpu-pill__gpu"> · {info.gpuName}</span>
            {started && (
              <>
                {" "}
                · <span className="mono">{formatElapsed(ms)}</span> · <span className="mono">~{formatUsd(cost)}</span>
              </>
            )}
          </span>
          {noWatchdog && (
            <span className="gpu-pill__warn" title={watchdogMsg} tabIndex={0}>
              <Icon name="alert" size={13} label={watchdogMsg} />
            </span>
          )}
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={stop} aria-label={`Stop the ${what}`}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      );
    }
    case "stopping":
      return (
        <div className="gpu-pill gpu-pill--stopping" role="status" aria-label={aria}>
          <Icon name="refresh" size={13} className="spin" />
          <span className="gpu-pill__text">
            <span className="gpu-pill__profile">{label}</span> · Stopping…
          </span>
        </div>
      );
    default:
      // A pod may still exist (and bill): Stop comes first and is prominent.
      if (g.podId) {
        return (
          <div className="gpu-pill gpu-pill--error" role="status" aria-label={aria}>
            <Icon name="alert" size={13} />
            <span className="gpu-pill__text" title={g.error ?? undefined}>
              {label} · Error · <strong>may still be billing</strong>
            </span>
            <button
              type="button"
              className="btn btn--sm btn--danger gpu-pill__btn"
              onClick={stop}
              title={g.error ? `${g.error}\n\nStop terminates the pod.` : "Stop terminates the pod."}
              aria-label={`Stop the ${what}`}
            >
              <Icon name="stop" size={13} /> Stop
            </button>
            <button type="button" className="btn btn--sm btn--ghost gpu-pill__btn" onClick={start} disabled={busy} aria-label={`Retry starting the ${what}`}>
              <Icon name="refresh" size={13} /> Retry
            </button>
          </div>
        );
      }
      return (
        <div className="gpu-pill gpu-pill--error" role="status" aria-label={aria}>
          <Icon name="alert" size={13} />
          <span className="gpu-pill__text">{label} · Error</span>
          {g.error && (
            <span className="gpu-pill__msg" title={g.error}>
              {g.error}
            </span>
          )}
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={start} disabled={busy} aria-label={`Retry starting the ${what}`}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        </div>
      );
  }
}
