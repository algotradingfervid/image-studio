// The dedicated GPU pods — one per profile ("image" in EU-RO-1, "video" in CA-MTL-3, spec v5):
// live state from `gpu-update`, Start/Stop, and the confirmations that go with them
// (stopping while work runs, starting a billed pod for a Models-screen action, quitting
// while any pod may still be billing).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { gpuIsOff, isTaskActive, type GpuProfile, type GpuState, type Job } from "../api";
import { useNow } from "../lib/useNow";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { formatElapsed, formatUsd, shortGpuName, toDate } from "../lib/format";
import { useLibrary } from "./library";
import { useToast } from "./toast";

const DEFAULT_COST = 2.49;
const DEFAULT_IDLE = 30;

export const PROFILES: GpuProfile[] = ["image", "video"];
/** "Images" / "Video" — the pill and dialog label of a profile. */
export const PROFILE_LABEL: Record<GpuProfile, string> = { image: "Images", video: "Video" };

/** Everything the UI needs about one profile's pod. */
export interface GpuProfileInfo {
  profile: GpuProfile;
  /** null until the first get_gpu_state answers. */
  state: GpuState | null;
  /** Short name of the pod's actual GPU ("RTX PRO 6000"); before a pod exists, the first-priority GPU. */
  gpuName: string;
  /** What a start will try: "RTX PRO 6000" or "RTX PRO 6000 or the next available GPU". */
  startTarget: string;
  /** The pod's price when known, else the settings fallback. */
  costPerHr: number;
  /** "~$2.49/h" when the pod reports its price, else "~$2.49/h or less" (the GPU isn't chosen yet). */
  costLabel: string;
  idleMinutes: number;
  /** Jobs + model/LoRA tasks of this profile that are queued or running. */
  activeWork: number;
  /** Starting, running, stopping, or in error with a pod that may still bill. */
  live: boolean;
}

interface Gpu extends Omit<GpuProfileInfo, "profile" | "live"> {
  /** The image profile's fields are spread at the top level (state, gpuName, costLabel, …) for older callers. */
  profiles: Record<GpuProfile, GpuProfileInfo>;
  /** The pod backend is selected (false for legacy serverless: no pill, no prompts). */
  podMode: boolean;
  start(profile?: GpuProfile): Promise<void>;
  /** Stops that profile's pod; asks first (in-app) when a job or task is active on it. */
  stop(profile?: GpuProfile): void;
  /**
   * Before an action that auto-starts a GPU: resolves true at once when that profile's GPU is
   * starting/running (or in serverless mode); otherwise asks and resolves with the answer.
   */
  confirmStart(action?: string, profile?: GpuProfile): Promise<boolean>;
}

const Ctx = createContext<Gpu | null>(null);

export function useGpu(): Gpu {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGpu outside provider");
  return v;
}

const jobActive = (j: Job) => api.isJobActive(j);
const jobProfile = (j: Job): GpuProfile => (j.kind === "video" ? "video" : "image");

/** A pod may exist (and bill) in this state. */
export const gpuIsLive = (g: GpuState | null | undefined): boolean =>
  !!g && (g.status === "starting" || g.status === "running" || g.status === "stopping" || (g.status === "error" && !!g.podId));

const emptyStates: Record<GpuProfile, GpuState | null> = { image: null, video: null };

export function GpuProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const lib = useLibrary();
  const [states, setStates] = useState<Record<GpuProfile, GpuState | null>>(emptyStates);
  const prev = useRef<Record<GpuProfile, GpuState | null>>({ ...emptyStates });
  /** Active generation jobs by id → the profile they run on. */
  const [activeJobs, setActiveJobs] = useState<Map<string, GpuProfile>>(() => new Map());
  const [stopAsk, setStopAsk] = useState<GpuProfile | null>(null);
  const [stopping, setStopping] = useState(false);
  const [startAsk, setStartAsk] = useState<{ action?: string; profile: GpuProfile; resolve: (ok: boolean) => void } | null>(null);
  // Quit confirmation (the backend emits `quit-requested` on ⌘Q / window close).
  const [quitAsk, setQuitAsk] = useState(false);
  const [quitBusy, setQuitBusy] = useState<null | "stop" | "quit">(null);
  const [quitError, setQuitError] = useState<string | null>(null);

  const s = lib.settings;
  const podMode = (s?.backend ?? "pod") === "pod";

  const videoModelIds = useMemo(() => new Set(lib.videoModels.map((m) => m.id)), [lib.videoModels]);
  const tasksOf = (p: GpuProfile) =>
    lib.models.filter((m) => isTaskActive(m.task) && (videoModelIds.has(m.id) ? "video" : "image") === p).length +
    (p === "image" ? lib.loras.filter((l) => isTaskActive(l.task)).length : 0);
  const jobsOf = (p: GpuProfile) => [...activeJobs.values()].filter((x) => x === p).length;

  const info = (p: GpuProfile): GpuProfileInfo => {
    const state = states[p];
    const knownCost = state?.costPerHr ?? null;
    const costPerHr = knownCost ?? s?.fallbackCostPerHr ?? DEFAULT_COST;
    const list = p === "video" ? (s?.videoGpuTypes ?? []) : s?.gpuTypes?.length ? s.gpuTypes : s?.gpuType ? [s.gpuType] : [];
    const firstGpu = list[0];
    return {
      profile: p,
      state,
      gpuName: shortGpuName(state?.gpuType ?? firstGpu),
      startTarget: list.length > 1 ? `${shortGpuName(firstGpu)} or the next available GPU` : shortGpuName(firstGpu),
      costPerHr,
      costLabel: knownCost != null ? `~${formatUsd(knownCost)}/h` : `~${formatUsd(costPerHr)}/h or less`,
      idleMinutes: state?.idleMinutes ?? s?.idleMinutes ?? DEFAULT_IDLE,
      activeWork: jobsOf(p) + tasksOf(p),
      live: gpuIsLive(state),
    };
  };
  const profiles: Record<GpuProfile, GpuProfileInfo> = { image: info("image"), video: info("video") };

  // Toast only on transitions, so a re-emitted state doesn't toast twice.
  const apply = useCallback(
    (g: GpuState) => {
      const p: GpuProfile = g.profile === "video" ? "video" : "image";
      const before = prev.current[p];
      prev.current = { ...prev.current, [p]: g };
      setStates((cur) => ({ ...cur, [p]: g }));
      if (!before || before.status === g.status) return;
      const what = p === "video" ? "video GPU" : "GPU";
      const What = p === "video" ? "Video GPU" : "GPU";
      if (g.status === "stopped" && g.stopReason === "idle" && before.status === "error") {
        toast.info(`${What} pod stopped automatically`, "It was left over from a GPU problem, so the app stopped it to end billing.");
      } else if (g.status === "stopped" && g.stopReason === "idle") {
        toast.info(`${What} stopped after ${g.idleMinutes} idle minutes`, "Start it again any time — generating starts it too.");
      } else if (g.status === "stopped" && g.stopReason === "external") {
        toast.info(`The ${what} pod stopped`, "It was stopped outside the app — by its own idle watchdog or in the RunPod console.");
      } else if (g.status === "error") {
        toast.error(`${What} problem`, g.error ?? undefined);
      }
    },
    [toast],
  );

  useEffect(() => {
    let alive = true;
    // Seed each profile once; an event may already have delivered something newer.
    const seed = (g: GpuState, p: GpuProfile) => {
      if (!alive || prev.current[p]) return;
      const st = { ...g, profile: p };
      prev.current = { ...prev.current, [p]: st };
      setStates((cur) => ({ ...cur, [p]: st }));
    };
    api
      .listGpuStates()
      .then((list) => list.forEach((g, i) => seed(g, g.profile ?? PROFILES[i] ?? "image")))
      .catch(() =>
        // Older core without list_gpu_states: the image profile only.
        api
          .getGpuState("image")
          .then((g) => seed(g, "image"))
          .catch((e) => toast.error("Couldn't read the GPU state", e)),
      );
    const un = api.onEvent("gpu-update", apply);
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [apply, toast]);

  useEffect(() => {
    const un = api.onEvent("quit-requested", (payload) => {
      // Payload: every profile's state (older cores sent a single GpuState).
      const list = Array.isArray(payload) ? payload : [payload as GpuState];
      list.forEach(apply);
      setQuitError(null);
      setQuitAsk(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [apply]);

  const quit = async (stopGpu: boolean) => {
    setQuitBusy(stopGpu ? "stop" : "quit");
    setQuitError(null);
    try {
      await api.confirmQuit(stopGpu);
      // The app exits; in the browser mock nothing happens, so just close.
      setQuitAsk(false);
    } catch (e) {
      setQuitError(api.errorMessage(e));
    } finally {
      setQuitBusy(null);
    }
  };

  // Track active generation jobs (for the Stop confirmation).
  useEffect(() => {
    let alive = true;
    api
      .listJobs()
      .then((js) => {
        if (!alive) return;
        setActiveJobs((cur) => {
          const next = new Map(cur);
          for (const j of js.filter(jobActive)) next.set(j.jobId, jobProfile(j));
          return next;
        });
      })
      .catch(() => {
        /* nothing to track */
      });
    const un = api.onEvent("job-update", (j) => {
      setActiveJobs((cur) => {
        const on = jobActive(j);
        if (on === cur.has(j.jobId)) return cur;
        const next = new Map(cur);
        if (on) next.set(j.jobId, jobProfile(j));
        else next.delete(j.jobId);
        return next;
      });
    });
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  const start = useCallback(
    async (profile: GpuProfile = "image") => {
      try {
        const g = await api.startGpu(profile);
        apply({ ...g, profile: g.profile ?? profile });
      } catch (e) {
        toast.error(profile === "video" ? "Couldn't start the video GPU" : "Couldn't start the GPU", e);
      }
    },
    [apply, toast],
  );

  const doStop = useCallback(
    async (profile: GpuProfile) => {
      setStopping(true);
      try {
        const g = await api.stopGpu(profile);
        apply({ ...g, profile: g.profile ?? profile });
      } catch (e) {
        toast.error(profile === "video" ? "Couldn't stop the video GPU" : "Couldn't stop the GPU", e);
      } finally {
        setStopping(false);
        setStopAsk(null);
      }
    },
    [apply, toast],
  );

  const workRef = useRef({ image: 0, video: 0 });
  workRef.current = { image: profiles.image.activeWork, video: profiles.video.activeWork };
  const stop = useCallback(
    (profile: GpuProfile = "image") => {
      if (workRef.current[profile] > 0) setStopAsk(profile);
      else void doStop(profile);
    },
    [doStop],
  );

  const statesRef = useRef(states);
  statesRef.current = states;
  const podModeRef = useRef(podMode);
  podModeRef.current = podMode;
  const confirmStart = useCallback((action?: string, profile: GpuProfile = "image") => {
    if (!podModeRef.current || !gpuIsOff(statesRef.current[profile])) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setStartAsk({ action, profile, resolve }));
  }, []);

  const answerStart = (ok: boolean) => {
    startAsk?.resolve(ok);
    setStartAsk(null);
  };

  const img = profiles.image;
  const value: Gpu = {
    state: img.state,
    gpuName: img.gpuName,
    startTarget: img.startTarget,
    costPerHr: img.costPerHr,
    costLabel: img.costLabel,
    idleMinutes: img.idleMinutes,
    activeWork: img.activeWork + profiles.video.activeWork,
    profiles,
    podMode,
    start,
    stop,
    confirmStart,
  };

  const workText = (p: GpuProfile) => {
    const jobs = jobsOf(p);
    const tasks = tasksOf(p);
    const noun = p === "video" ? "video" : "generation";
    return [jobs ? `${jobs} ${noun}${jobs === 1 ? "" : "s"}` : null, tasks ? `${tasks} download/delete task${tasks === 1 ? "" : "s"}` : null]
      .filter(Boolean)
      .join(" and ");
  };

  const stopInfo = stopAsk ? profiles[stopAsk] : null;
  const startInfo = startAsk ? profiles[startAsk.profile] : null;
  const quitList = PROFILES.map((p) => profiles[p]).filter((x) => x.live);
  const quitWork = PROFILES.map(workText).filter(Boolean).join("; ");
  const allArmed = quitList.every((x) => x.state?.watchdogArmed === true);
  const anyUnarmed = quitList.some((x) => x.state?.watchdogArmed === false);
  const idleShown = img.idleMinutes;

  return (
    <Ctx.Provider value={value}>
      {children}

      <Dialog
        open={!!stopAsk}
        onClose={stopping ? () => {} : () => setStopAsk(null)}
        title={stopAsk === "video" ? "Stop the video GPU?" : "Stop the GPU?"}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setStopAsk(null)} disabled={stopping} autoFocus>
              Keep running
            </button>
            <button type="button" className="btn btn--danger" onClick={() => stopAsk && void doStop(stopAsk)} disabled={stopping}>
              <Icon name="stop" /> {stopping ? "Stopping…" : "Stop GPU"}
            </button>
          </>
        }
      >
        {stopInfo && (
          <p className="gpu-dialog__lede">
            {workText(stopInfo.profile) || "Work"} {stopInfo.activeWork === 1 ? "is" : "are"} still running on the{" "}
            {stopInfo.profile === "video" ? "video GPU" : "GPU"}. Stopping the pod ends {stopInfo.activeWork === 1 ? "it" : "them"} now — unfinished{" "}
            {stopInfo.profile === "video" ? "videos" : "images"} and downloads are lost.
          </p>
        )}
      </Dialog>

      <Dialog
        open={quitAsk}
        onClose={quitBusy ? () => {} : () => setQuitAsk(false)}
        title="Quit Image Studio?"
        footer={
          quitError ? (
            <>
              <button type="button" className="btn" onClick={() => setQuitAsk(false)} disabled={!!quitBusy}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger-text" onClick={() => void quit(false)} disabled={!!quitBusy}>
                Quit anyway
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void quit(true)} disabled={!!quitBusy} autoFocus>
                <Icon name="refresh" /> {quitBusy === "stop" ? "Stopping GPU…" : "Try again"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setQuitAsk(false)} disabled={!!quitBusy}>
                Cancel
              </button>
              <button type="button" className="btn" onClick={() => void quit(false)} disabled={!!quitBusy}>
                Quit anyway
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void quit(true)} disabled={!!quitBusy} autoFocus>
                <Icon name="stop" /> {quitBusy === "stop" ? (quitList.length > 1 ? "Stopping GPUs…" : "Stopping GPU…") : quitList.length > 1 ? "Stop GPUs & Quit" : "Stop GPU & Quit"}
              </button>
            </>
          )
        }
      >
        <p className="gpu-dialog__lede">
          {quitList.length > 1 ? "These GPU pods may be billing:" : "This GPU pod may be billing:"}
        </p>
        <QuitPodList items={quitList} />
        <p className="gpu-dialog__lede">
          {quitWork ? `${quitWork} still running. ` : ""}
          Stop {quitList.length > 1 ? "them" : "it"} before quitting so {quitList.length > 1 ? "they don't" : "it doesn't"} keep billing?
        </p>
        {quitError ? (
          <p className="notice notice--error" role="alert">
            <Icon name="alert" /> Couldn't stop the GPU, so the app is still open: {quitError}
          </p>
        ) : (
          <p className="hint">
            {allArmed
              ? `If you quit anyway, each pod stops itself after ${idleShown} idle minutes.`
              : anyUnarmed
                ? "If you quit anyway, nothing stops a pod that can't stop itself while the app is closed. Stop it later from the app or the RunPod console."
                : `If you quit anyway, each pod's own watchdog may stop it after ${idleShown} idle minutes; otherwise stop it later from the app or the RunPod console.`}
          </p>
        )}
      </Dialog>

      <Dialog
        open={!!startAsk}
        onClose={() => answerStart(false)}
        title={
          startAsk?.profile === "video"
            ? startAsk.action
              ? `Start the video GPU to ${startAsk.action}?`
              : "Start the video GPU?"
            : startAsk?.action
              ? `Start the GPU to ${startAsk.action}?`
              : "Start the GPU?"
        }
        footer={
          <>
            <button type="button" className="btn" onClick={() => answerStart(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => answerStart(true)} autoFocus>
              <Icon name="bolt" /> Start GPU &amp; continue
            </button>
          </>
        }
      >
        {startInfo && (
          <p className="gpu-dialog__lede">
            This starts the {startInfo.profile === "video" ? "video GPU pod in Canada" : "GPU pod"} ({startInfo.startTarget}, {startInfo.costLabel}). It auto-stops
            after {startInfo.idleMinutes} idle minutes.
          </p>
        )}
        <p className="hint">Starting takes a few minutes; the action waits in the queue until the GPU is ready.</p>
      </Dialog>
    </Ctx.Provider>
  );
}

/** One row per billing pod: "Images · RTX PRO 4500 · running 12 min · ~$0.50". */
function QuitPodList({ items }: { items: GpuProfileInfo[] }) {
  const now = useNow(items.length > 0, 15_000);
  return (
    <ul className="plain quit-pods">
      {items.map((x) => {
        const g = x.state!;
        const started = toDate(g.startedAt);
        const ms = started ? Math.max(0, now - started.getTime()) : 0;
        const status =
          g.status === "starting" ? `starting${g.phase ? ` (${g.phase})` : ""}` : g.status === "stopping" ? "stopping" : g.status === "error" ? "error — may still be billing" : "running";
        return (
          <li key={x.profile} className="quit-pods__row">
            <span className={`quit-pods__dot quit-pods__dot--${g.status}`} aria-hidden />
            <strong>{PROFILE_LABEL[x.profile]}</strong>
            <span>· {x.gpuName}</span>
            <span>· {status}</span>
            {started && (
              <span className="mono">
                · {formatElapsed(ms)} · ~{formatUsd((ms / 3_600_000) * x.costPerHr)}
              </span>
            )}
            <span className="hint mono">({x.costLabel})</span>
          </li>
        );
      })}
    </ul>
  );
}
