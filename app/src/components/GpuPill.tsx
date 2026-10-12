import { useEffect, useId, useRef, useState } from "react";
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
    // Both pods live: each pill goes compact (state word + cost; GPU and elapsed time in its details).
    <div className={`gpu-pills gpu-pills--dual ${both ? "gpu-pills--both" : ""}`} role="group" aria-label="GPU pods">
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

/** "28m" / "<1m": the idle countdown short enough for the pill at any width (UI-058). */
function untilShort(at: number, now: number): string {
  const m = Math.ceil(Math.max(0, at - now) / 60_000);
  return m <= 1 ? "<1m" : `${m}m`;
}

/**
 * One profile's pill: a short state word that shows at every width ("Starting", "Idle 28m"),
 * then GPU, elapsed time and cost as room allows; the text opens a details popover (start time,
 * cost so far, auto-stop) for keyboard, touch and screen readers (UI-058).
 *
 * The Start / Stop / Retry action is ONE button whose label changes with the state, and it is
 * never `disabled` while its confirm is open, so focus stays on it through a confirm and the
 * Start → Stop swap instead of dropping to <body> (UI-006).
 */
export function GpuPill({ profile = "image" }: { profile?: GpuProfile }) {
  const gpu = useGpu();
  const info = gpu.profiles[profile];
  const g = info.state;
  const running = g?.status === "running" || g?.status === "starting";
  const now = useNow(running, 15_000);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!g) return null;

  const label = PROFILE_LABEL[profile];
  const what = `${label} GPU`;
  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await gpu.start(profile);
    } finally {
      setBusy(false);
    }
  };
  const stop = () => gpu.stop(profile);

  const started = toDate(g.startedAt);
  const ms = started ? Math.max(0, now - started.getTime()) : 0;
  const cost = (ms / 3_600_000) * info.costPerHr;
  const isRunning = g.status === "running";
  // useNow's clock can trail the moment the pod went idle: never count past the limit.
  const idleNow = info.autoStopAt != null ? Math.max(now, info.autoStopAt - info.idleMinutes * 60_000) : now;
  const countdown = isRunning && info.autoStopAt != null ? untilText(info.autoStopAt, idleNow) : null;
  const noWatchdog = isRunning && g.watchdogArmed === false;
  const watchdogMsg = `The ${what} pod can't auto-stop itself — the app will stop it after ${info.idleMinutes} idle min; keep the app open or stop manually.`;
  const errorWithPod = g.status === "error" && !!g.podId;

  // The state word: always visible. The live region announces only state changes, not the countdown.
  const word =
    g.status === "stopped"
      ? "Stopped"
      : g.status === "starting"
        ? "Starting"
        : g.status === "stopping"
          ? "Stopping…"
          : isRunning
            ? countdown
              ? `Idle ${untilShort(info.autoStopAt!, idleNow)}`
              : "Running"
            : errorWithPod
              ? "Error · may still be billing"
              : "Error";
  const spoken =
    g.status === "error" ? `${what}: error${errorWithPod ? ", may still be billing" : ""}` : `${what} ${g.status === "stopping" ? "stopping" : g.status}`;

  const facts: [string, string][] = [
    ["GPU", g.gpuType ? info.gpuName : info.startTarget],
    ["Price", info.costLabel],
  ];
  if (g.status === "starting" && g.phase) facts.push(["Phase", g.phase]);
  if (started && (isRunning || g.status === "starting"))
    facts.push(["Started", `${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ~${formatUsd(cost)} so far`]);
  if (isRunning)
    facts.push([
      "Auto-stop",
      countdown ? `idle · stops in ${countdown}` : info.activeWork > 0 ? `busy · ${info.idleMinutes} idle min after the work ends` : `after ${info.idleMinutes} idle min`,
    ]);
  if (g.status === "stopped") facts.push(["Billing", "not billing"]);
  if (g.status === "error" && g.error) facts.push(["Problem", g.error]);
  if (noWatchdog) facts.push(["Note", watchdogMsg]);

  // The one action button: what it does in this state.
  const action =
    g.status === "stopped" || (g.status === "error" && !g.podId)
      ? {
          text: g.status === "stopped" ? "Start" : "Retry",
          icon: g.status === "stopped" ? ("bolt" as const) : ("refresh" as const),
          name: g.status === "stopped" ? `Start the ${what}` : `Retry starting the ${what}`,
          title: `Start the ${what} pod (${info.startTarget}, ${info.costLabel})`,
          cls: "",
          run: start,
          off: busy,
        }
      : {
          text: "Stop",
          icon: "stop" as const,
          name: `Stop the ${what}`,
          title: g.status === "starting" ? `Cancel the start and remove the ${what} pod` : g.status === "stopping" ? "Stopping…" : `Stop the ${what} pod`,
          cls: g.status === "starting" ? "btn--ghost" : errorWithPod ? "btn--danger" : "",
          run: stop,
          off: g.status === "stopping",
        };

  return (
    <div
      ref={rootRef}
      className={`gpu-pill gpu-pill--${g.status} gpu-pill--${profile}`}
      role="group"
      aria-label={what}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector<HTMLElement>(".gpu-pill__text")?.focus();
        }
      }}
    >
      <span className="gpu-pill__ind" aria-hidden>
        {g.status === "starting" || g.status === "stopping" ? (
          <Icon name="refresh" size={13} className="spin" />
        ) : g.status === "error" ? (
          <Icon name="alert" size={13} />
        ) : (
          <span className="gpu-pill__dot" />
        )}
      </span>
      <button type="button" className="gpu-pill__text" aria-expanded={open} aria-controls={popId} onClick={() => setOpen((o) => !o)}>
        <span className="gpu-pill__profile">{label}</span>
        <span className="gpu-pill__word"> · {word}</span>
        {g.status === "starting" && g.phase && <span className="gpu-pill__phase"> · {g.phase}</span>}
        {g.status === "starting" && <span className="mono gpu-pill__rate"> · ~{formatUsd(info.costPerHr)}/h</span>}
        {isRunning && <span className="gpu-pill__gpu"> · {info.gpuName}</span>}
        {isRunning && started && (
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
        <span className="visually-hidden"> (details)</span>
      </button>
      {noWatchdog && (
        <span className="gpu-pill__warn" title={watchdogMsg}>
          <Icon name="alert" size={13} label="Can't auto-stop itself" />
        </span>
      )}
      <button
        type="button"
        className={`btn btn--sm gpu-pill__btn ${action.cls}`}
        onClick={() => !action.off && void action.run()}
        aria-disabled={action.off || undefined}
        title={action.title}
        aria-label={action.name}
      >
        <Icon name={action.icon} size={13} /> <span className="gpu-pill__btn-text">{action.text}</span>
      </button>
      {errorWithPod && (
        <button type="button" className="btn btn--sm btn--ghost gpu-pill__btn" onClick={() => void start()} aria-disabled={busy || undefined} aria-label={`Retry starting the ${what}`}>
          <Icon name="refresh" size={13} /> <span className="gpu-pill__btn-text">Retry</span>
        </button>
      )}
      <span className="visually-hidden" role="status">
        {spoken}
      </span>
      <div id={popId} className="gpu-pill__pop" hidden={!open}>
        <p className="gpu-pill__pop-title">
          {what} · {word}
        </p>
        <dl>
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
