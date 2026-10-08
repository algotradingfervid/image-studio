import { useEffect, useState } from "react";
import { formatElapsed, formatUsd, toDate } from "../lib/format";
import { useGpu } from "../state/gpu";
import { Icon } from "./Icon";

/** Re-render every `ms` while `on`. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const h = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(h);
  }, [on, ms]);
  return now;
}

/** Header pill: GPU pod status, live elapsed time and cost, Start/Stop. Hidden for the serverless backend. */
export function GpuPill() {
  const gpu = useGpu();
  const g = gpu.state;
  const running = g?.status === "running";
  const now = useNow(running);
  const [busy, setBusy] = useState(false);

  if (!gpu.podMode || !g) return null;

  const start = async () => {
    setBusy(true);
    await gpu.start();
    setBusy(false);
  };

  switch (g.status) {
    case "stopped":
      return (
        <div className="gpu-pill gpu-pill--stopped" role="status" aria-label="GPU status">
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text">GPU stopped</span>
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={start} disabled={busy} title={`Start the GPU pod (${gpu.startTarget}, ${gpu.costLabel})`}>
            <Icon name="bolt" size={13} /> Start
          </button>
        </div>
      );
    case "starting":
      return (
        <div className="gpu-pill gpu-pill--starting" role="status" aria-label="GPU status">
          <Icon name="refresh" size={13} className="spin" />
          <span className="gpu-pill__text">
            Starting{g.phase ? ` · ${g.phase}` : "…"}
          </span>
          <button type="button" className="btn btn--sm btn--ghost gpu-pill__btn" onClick={gpu.stop} title="Cancel the start and remove the pod">
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      );
    case "running": {
      const started = toDate(g.startedAt);
      const ms = started ? now - started.getTime() : 0;
      const cost = (Math.max(0, ms) / 3_600_000) * gpu.costPerHr;
      const noWatchdog = g.watchdogArmed === false;
      const watchdogMsg = `Pod can't auto-stop itself — the app will stop it after ${gpu.idleMinutes} idle min; keep the app open or stop manually.`;
      return (
        <div className="gpu-pill gpu-pill--running" role="status" aria-label="GPU status">
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text" title={`${g.gpuType ?? gpu.gpuName} · ${formatUsd(gpu.costPerHr)}/h · auto-stops after ${gpu.idleMinutes} idle min`}>
            Running · {gpu.gpuName}
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
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={gpu.stop}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      );
    }
    case "stopping":
      return (
        <div className="gpu-pill gpu-pill--stopping" role="status" aria-label="GPU status">
          <Icon name="refresh" size={13} className="spin" />
          <span className="gpu-pill__text">Stopping…</span>
        </div>
      );
    default:
      // A pod may still exist (and bill): Stop comes first and is prominent.
      if (g.podId) {
        return (
          <div className="gpu-pill gpu-pill--error" role="status" aria-label="GPU status">
            <Icon name="alert" size={13} />
            <span className="gpu-pill__text" title={g.error ?? undefined}>
              Error · <strong>may still be billing</strong>
            </span>
            <button type="button" className="btn btn--sm btn--danger gpu-pill__btn" onClick={gpu.stop} title={g.error ? `${g.error}\n\nStop terminates the pod.` : "Stop terminates the pod."}>
              <Icon name="stop" size={13} /> Stop
            </button>
            <button type="button" className="btn btn--sm btn--ghost gpu-pill__btn" onClick={start} disabled={busy}>
              <Icon name="refresh" size={13} /> Retry
            </button>
          </div>
        );
      }
      return (
        <div className="gpu-pill gpu-pill--error" role="status" aria-label="GPU status">
          <Icon name="alert" size={13} />
          <span className="gpu-pill__text">Error</span>
          {g.error && (
            <span className="gpu-pill__msg" title={g.error}>
              {g.error}
            </span>
          )}
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={start} disabled={busy}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        </div>
      );
  }
}
