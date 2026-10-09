import { useState } from "react";
import type { GpuProfile } from "../api";
import { formatElapsed, formatUsd, toDate } from "../lib/format";
import { useNow } from "../lib/useNow";
import { PROFILES, PROFILE_LABEL, useGpu } from "../state/gpu";
import { Icon } from "./Icon";
import "../styles/gpu-settings.css";

export { useNow };

/**
 * Header GPU pills (UX-013 / UX-023): always one per profile — Images and Video — each with
 * its own status and its own Start / Stop, so Start always starts the pod the user means.
 * Starting shows the hourly rate, an idle running pod its auto-stop countdown, and with two
 * pods billing a combined total follows.
 */
export function GpuPills() {
  const gpu = useGpu();
  const known = PROFILES.some((p) => gpu.profiles[p].state);
  const now = useNow(gpu.runningTotal.count > 1, 15_000);
  if (!known) return null;
  const both = gpu.runningTotal.count > 1;
  void now; // re-render for the total
  return (
    <div className="gpu-pills gpu-pills--dual" role="group" aria-label="GPU pods">
      {PROFILES.map((p) => (
        <GpuPill key={p} profile={p} />
      ))}
      {both && (
        <span className="gpu-total mono" title="Approximate cost so far of both running pods together" aria-label={`Both GPU pods: about ${formatUsd(gpu.runningTotal.cost)} so far`}>
          Σ ~{formatUsd(gpu.runningTotal.cost)}
        </span>
      )}
    </div>
  );
}

/** "27 min" / "<1 min" until `at`. */
function untilText(at: number, now: number): string {
  const m = Math.ceil(Math.max(0, at - now) / 60_000);
  return m <= 1 ? "<1 min" : `${m} min`;
}

/** One profile's pill: status, live elapsed time and cost, Start/Stop. */
export function GpuPill({ profile = "image" }: { profile?: GpuProfile }) {
  const gpu = useGpu();
  const info = gpu.profiles[profile];
  const g = info.state;
  const running = g?.status === "running" || g?.status === "starting";
  const now = useNow(running, 15_000);
  const [busy, setBusy] = useState(false);

  if (!g) return null;

  const label = PROFILE_LABEL[profile];
  const what = profile === "video" ? "video GPU" : "Images GPU";
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
        <div className={`gpu-pill gpu-pill--stopped gpu-pill--${profile}`} role="status" aria-label={aria}>
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text" title={`${label} pod stopped · not billing · starts ${info.startTarget} at ${info.costLabel}`}>
            <span className="gpu-pill__profile">{label}</span>
            <span className="gpu-pill__state"> · stopped</span>
          </span>
          <button
            type="button"
            className="btn btn--sm gpu-pill__btn"
            onClick={start}
            disabled={busy}
            title={`Start the ${what} pod (${info.startTarget}, ${info.costLabel})`}
            aria-label={`Start the ${what}`}
          >
            <Icon name="bolt" size={13} /> Start
          </button>
        </div>
      );
    case "starting":
      return (
        <div className={`gpu-pill gpu-pill--starting gpu-pill--${profile}`} role="status" aria-label={aria}>
          <Icon name="refresh" size={13} className="spin" />
          <span className="gpu-pill__text" title={`${label} · starting ${info.startTarget} · billed ${info.costLabel} from now`}>
            <span className="gpu-pill__profile">{label}</span>
            <span className="gpu-pill__gpu"> · Starting{g.phase ? ` · ${g.phase}` : "…"}</span>
            <span className="mono gpu-pill__rate"> · ~{formatUsd(info.costPerHr)}/h</span>
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
      // useNow's clock can trail the moment the pod went idle: never count past the limit.
      const countdown = info.autoStopAt != null ? untilText(info.autoStopAt, Math.max(now, info.autoStopAt - info.idleMinutes * 60_000)) : null;
      const tip = [
        `${label} · ${g.gpuType ?? info.gpuName} · ${formatUsd(info.costPerHr)}/h`,
        started ? `started ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ~${formatUsd(cost)} so far` : null,
        countdown ? `idle · auto-stops in ${countdown}` : info.activeWork > 0 ? `busy · auto-stops ${info.idleMinutes} idle min after the work ends` : `auto-stops after ${info.idleMinutes} idle min`,
      ]
        .filter(Boolean)
        .join("\n");
      return (
        <div className={`gpu-pill gpu-pill--running gpu-pill--${profile}`} role="status" aria-label={aria}>
          <span className="gpu-pill__dot" aria-hidden />
          <span className="gpu-pill__text" title={tip}>
            <span className="gpu-pill__profile">{label}</span>
            <span className="gpu-pill__gpu"> · {info.gpuName}</span>
            {started && (
              <>
                <span className="gpu-pill__elapsed">
                  {" "}
                  · <span className="mono">{formatElapsed(ms)}</span>
                </span>
                <span className="gpu-pill__cost">
                  {" "}
                  · <span className="mono">~{formatUsd(cost)}</span>
                </span>
              </>
            )}
            {countdown && <span className="gpu-pill__idle"> · idle, stops in {countdown}</span>}
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
        <div className={`gpu-pill gpu-pill--stopping gpu-pill--${profile}`} role="status" aria-label={aria}>
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
          <div className={`gpu-pill gpu-pill--error gpu-pill--${profile}`} role="status" aria-label={aria}>
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
        <div className={`gpu-pill gpu-pill--error gpu-pill--${profile}`} role="status" aria-label={aria}>
          <Icon name="alert" size={13} />
          <span className="gpu-pill__text" title={g.error ?? undefined}>
            {label} · Error
          </span>
          <button type="button" className="btn btn--sm gpu-pill__btn" onClick={start} disabled={busy} aria-label={`Retry starting the ${what}`} title={g.error ?? undefined}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        </div>
      );
  }
}
