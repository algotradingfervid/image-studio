// The dedicated GPU pods — one per profile ("image" in EU-RO-1, "video" in CA-MTL-3, spec v5):
// live state from `gpu-update`, Start/Stop, and the confirmations that go with them
// (stopping while work runs, starting a billed pod for a Models-screen action, quitting
// while any pod may still be billing).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { isTaskActive, type GpuProfile, type GpuState, type Job } from "../api";
import { useNow } from "../lib/useNow";
import { Dialog } from "../components/Dialog";
import { StartGpuDialog } from "../components/StartGpuDialog";
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
  /** Pod mode and the pod isn't starting/running: an action on this profile starts it (after confirmStart). */
  needsStart: boolean;
  /**
   * Running with nothing to do: when the app's idle auto-stop will stop it (ms epoch, from the
   * moment its work last ended or it became ready). null while busy or not running.
   */
  autoStopAt: number | null;
}

/** Extra lines for the start confirmation (UX-031): what the action does, and its button label. */
export interface StartDetails {
  /** One line each, e.g. "Downloads 17.2 GB to image-studio-models · 26.2 GB free afterwards". */
  details?: string[];
  /** Replaces "Start GPU (~$2.49/h)", e.g. "Start GPU & download 17.2 GB". */
  confirmLabel?: string;
}

interface Gpu extends Omit<GpuProfileInfo, "profile" | "live" | "needsStart" | "autoStopAt"> {
  /** The image profile's fields are spread at the top level (state, gpuName, costLabel, …) for older callers. */
  profiles: Record<GpuProfile, GpuProfileInfo>;
  /** Always true: the legacy serverless backend was removed (UX-016). Kept for older callers. */
  podMode: boolean;
  /** Approximate cost so far of every running pod together (USD), and how many are billing. */
  runningTotal: { cost: number; count: number };
  /** Starts that profile's pod — after the start confirmation when it isn't already starting/running. */
  start(profile?: GpuProfile): Promise<void>;
  /** Stops that profile's pod; asks first (in-app) when a job or task is active on it. */
  stop(profile?: GpuProfile): void;
  /**
   * THE confirmation before anything that would start a billed GPU pod (owner's rule: always
   * confirm). Resolves true at once when that profile's GPU is already starting/running (or in
   * serverless mode); otherwise shows the start dialog and resolves with the answer. Callers must
   * not touch the backend when it resolves false.
   */
  confirmStart(action?: string, profile?: GpuProfile, extra?: StartDetails): Promise<boolean>;
}

const Ctx = createContext<Gpu | null>(null);

export function useGpu(): Gpu {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGpu outside provider");
  return v;
}

const jobActive = (j: Job) => api.isJobActive(j);
const jobProfile = (j: Job): GpuProfile => (j.kind === "video" ? "video" : "image");
interface ActiveJob {
  profile: GpuProfile;
  total: number;
  completed: number;
}
const activeJob = (j: Job): ActiveJob => ({ profile: jobProfile(j), total: j.total, completed: j.completed });

/** A pod may exist (and bill) in this state. */
export const gpuIsLive = (g: GpuState | null | undefined): boolean =>
  !!g && (g.status === "starting" || g.status === "running" || g.status === "stopping" || (g.status === "error" && !!g.podId));

/** Work on this pod would (re)start it: anything but starting/running — stopped, stopping, error, or not known yet. */
export const gpuNeedsStart = (g: GpuState | null | undefined): boolean => !g || (g.status !== "starting" && g.status !== "running");

const emptyStates: Record<GpuProfile, GpuState | null> = { image: null, video: null };

export function GpuProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const lib = useLibrary();
  const [states, setStates] = useState<Record<GpuProfile, GpuState | null>>(emptyStates);
  const prev = useRef<Record<GpuProfile, GpuState | null>>({ ...emptyStates });
  /** The last known start time / price of each pod, for the "ran 3 min · ~$0.12" stop toast. */
  const runInfo = useRef<Record<GpuProfile, { startedAt: string; costPerHr: number } | null>>({ image: null, video: null });
  /** Active generation jobs by id → the profile they run on, and their progress (for the Stop dialog). */
  const [activeJobs, setActiveJobs] = useState<Map<string, ActiveJob>>(() => new Map());
  const [stopAsk, setStopAsk] = useState<GpuProfile | null>(null);
  const [stopping, setStopping] = useState(false);
  const [startAsk, setStartAsk] = useState<{ action?: string; profile: GpuProfile; extra?: StartDetails; resolve: (ok: boolean) => void } | null>(null);
  /** When each running pod last became idle (ready, or its last job/task ended); null while busy. */
  const [idleSince, setIdleSince] = useState<Record<GpuProfile, number | null>>({ image: null, video: null });
  // Quit confirmation (the backend emits `quit-requested` on ⌘Q / window close).
  const [quitAsk, setQuitAsk] = useState(false);
  const [quitBusy, setQuitBusy] = useState<null | "stop" | "quit">(null);
  const [quitError, setQuitError] = useState<string | null>(null);

  const s = lib.settings;
  // Serverless (legacy) was removed (UX-016): every profile runs on its own billed pod.
  const podMode = true;
  const usesPod = (_p: GpuProfile) => true;

  const videoModelIds = useMemo(() => new Set(lib.videoModels.map((m) => m.id)), [lib.videoModels]);
  const tasksOf = (p: GpuProfile) =>
    lib.models.filter((m) => isTaskActive(m.task) && (videoModelIds.has(m.id) ? "video" : "image") === p).length +
    (p === "image" ? lib.loras.filter((l) => isTaskActive(l.task)).length : 0);
  const jobsOf = (p: GpuProfile) => [...activeJobs.values()].filter((x) => x.profile === p).length;

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
      needsStart: usesPod(p) && gpuNeedsStart(state),
      autoStopAt:
        state?.status === "running" && jobsOf(p) + tasksOf(p) === 0 && idleSince[p] != null
          ? idleSince[p]! + (state?.idleMinutes ?? s?.idleMinutes ?? DEFAULT_IDLE) * 60_000
          : null,
    };
  };
  const profiles: Record<GpuProfile, GpuProfileInfo> = { image: info("image"), video: info("video") };

  // Idle countdown: a pod is idle from when it became ready or its last job/task ended.
  const busyKey = `${profiles.image.state?.status}:${profiles.image.activeWork}|${profiles.video.state?.status}:${profiles.video.activeWork}`;
  useEffect(() => {
    setIdleSince((cur) => {
      const next = { ...cur };
      for (const p of PROFILES) {
        const running = states[p]?.status === "running";
        const busy = profiles[p].activeWork > 0;
        if (!running || busy) next[p] = null;
        else if (cur[p] == null) next[p] = Date.now();
      }
      return next.image === cur.image && next.video === cur.video ? cur : next;
    });
  }, [busyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toast only on transitions, so a re-emitted state doesn't toast twice.
  const apply = useCallback(
    (g: GpuState) => {
      const p: GpuProfile = g.profile === "video" ? "video" : "image";
      const before = prev.current[p];
      prev.current = { ...prev.current, [p]: g };
      setStates((cur) => ({ ...cur, [p]: g }));
      // Remember the run's start/price while the pod exists (the stop event no longer has them).
      if (g.status !== "stopped" && g.startedAt) runInfo.current[p] = { startedAt: g.startedAt, costPerHr: g.costPerHr ?? DEFAULT_COST };
      if (!before || before.status === g.status) return;
      const what = p === "video" ? "video GPU" : "GPU";
      const What = p === "video" ? "Video GPU" : "Images GPU";
      // Run time and cost of the pod that just went away (from the last state that had them).
      const ranFrom = runInfo.current[p];
      const ran = (() => {
        const t = ranFrom ? toDate(ranFrom.startedAt) : null;
        if (!t || !ranFrom) return "";
        const ms = Math.max(0, Date.now() - t.getTime());
        return ` · ran ${formatElapsed(ms)} · ~${formatUsd((ms / 3_600_000) * ranFrom.costPerHr)}`;
      })();
      if (g.status === "stopped") runInfo.current[p] = null;
      if (g.status === "stopped" && g.stopReason === "cancelled") {
        toast.info(`${What} stopped${ran}`, "It was starting only for the job you cancelled, so the app stopped it to end billing.");
      } else if (g.status === "stopped" && g.stopReason === "finished") {
        toast.info(`${What} stopped${ran}`, "It was started only for a Models-screen task (Refresh, download or delete), which has finished.");
      } else if (g.status === "stopped" && g.stopReason === "user") {
        toast.info(`${What} stopped${ran}`, "Billing has ended for this pod.");
      } else if (g.status === "stopped" && g.stopReason === "idle" && before.status === "error") {
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
          for (const j of js.filter(jobActive)) next.set(j.jobId, activeJob(j));
          return next;
        });
      })
      .catch(() => {
        /* nothing to track */
      });
    const un = api.onEvent("job-update", (j) => {
      setActiveJobs((cur) => {
        const on = jobActive(j);
        const had = cur.get(j.jobId);
        if (!on && !had) return cur;
        if (on && had && had.completed === j.completed && had.total === j.total) return cur;
        const next = new Map(cur);
        if (on) next.set(j.jobId, activeJob(j));
        else next.delete(j.jobId);
        return next;
      });
    });
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  const statesRef = useRef(states);
  statesRef.current = states;
  const podModeRef = useRef(podMode);
  podModeRef.current = podMode;
  const usesPodRef = (p: GpuProfile) => p === "video" || podModeRef.current;
  const pendingAsk = useRef<((ok: boolean) => void) | null>(null);
  const confirmStart = useCallback((action?: string, profile: GpuProfile = "image", extra?: StartDetails) => {
    if (!usesPodRef(profile) || !gpuNeedsStart(statesRef.current[profile])) return Promise.resolve(true);
    // A newer request replaces an open one; the older caller gets "no".
    pendingAsk.current?.(false);
    return new Promise<boolean>((resolve) => {
      pendingAsk.current = resolve;
      setStartAsk({ action, profile, extra, resolve });
    });
  }, []);

  const answerStart = (ok: boolean) => {
    const resolve = startAsk?.resolve;
    pendingAsk.current = null;
    setStartAsk(null);
    resolve?.(ok);
  };

  const start = useCallback(
    async (profile: GpuProfile = "image") => {
      if (!(await confirmStart(undefined, profile))) return;
      try {
        const g = await api.startGpu(profile);
        apply({ ...g, profile: g.profile ?? profile });
      } catch (e) {
        toast.error(profile === "video" ? "Couldn't start the video GPU" : "Couldn't start the GPU", e);
      }
    },
    [apply, toast, confirmStart],
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


  const img = profiles.image;
  const nowForTotal = Date.now();
  const runningTotal = PROFILES.reduce(
    (acc, p) => {
      const g = profiles[p].state;
      const t = g?.status === "running" || g?.status === "starting" ? toDate(g.startedAt) : null;
      if (!g || (g.status !== "running" && g.status !== "starting")) return acc;
      const cost = t ? (Math.max(0, nowForTotal - t.getTime()) / 3_600_000) * profiles[p].costPerHr : 0;
      return { cost: acc.cost + cost, count: acc.count + 1 };
    },
    { cost: 0, count: 0 },
  );
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
    runningTotal,
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
  /** "3 of 4 images done" for the image jobs of profile p (finished outputs are kept on Stop). */
  const doneText = (p: GpuProfile) => {
    const js = [...activeJobs.values()].filter((j) => j.profile === p);
    if (!js.length) return "";
    const total = js.reduce((a, j) => a + j.total, 0);
    const done = js.reduce((a, j) => a + j.completed, 0);
    const unit = p === "video" ? "video" : "image";
    const lost = total - done;
    return ` ${done} of ${total} ${unit}${total === 1 ? "" : "s"} done — stopping now keeps the finished ${unit}s and loses ${lost}.`;
  };

  const stopInfo = stopAsk ? profiles[stopAsk] : null;
  const startInfo = startAsk ? profiles[startAsk.profile] : null;
  const quitList = PROFILES.map((p) => profiles[p]).filter((x) => x.live);
  const quitWork = PROFILES.map(workText).filter(Boolean).join("; ");
  // Self-stop off in Settings: no pod can stop itself once the app is closed (UX-004).
  const selfStopOff = s?.passApiKeyToPod === false;
  const allArmed = !selfStopOff && quitList.every((x) => x.state?.watchdogArmed === true);
  const anyUnarmed = selfStopOff || quitList.some((x) => x.state?.watchdogArmed === false);
  const idleShown = img.idleMinutes;

  return (
    <Ctx.Provider value={value}>
      {children}

      <Dialog
        open={!!stopAsk}
        onClose={stopping ? () => {} : () => setStopAsk(null)}
        title={stopAsk === "video" ? "Stop the video GPU?" : "Stop the Images GPU?"}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setStopAsk(null)} disabled={stopping} autoFocus>
              Keep running
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => stopAsk && void doStop(stopAsk)}
              disabled={stopping}
              aria-label={stopAsk === "video" ? "Stop the video GPU" : "Stop the Images GPU"}
            >
              <Icon name="stop" /> {stopping ? "Stopping…" : "Stop GPU"}
            </button>
          </>
        }
      >
        {stopInfo &&
          (stopInfo.activeWork === 0 ? (
            <p className="gpu-dialog__lede">Nothing is running on the {stopInfo.profile === "video" ? "video" : "Images"} GPU now. Stop it?</p>
          ) : (
            <p className="gpu-dialog__lede">
              {workText(stopInfo.profile)} {stopInfo.activeWork === 1 ? "is" : "are"} still running on the {stopInfo.profile === "video" ? "video" : "Images"} GPU.
              {doneText(stopInfo.profile) || ` Stopping the pod ends ${stopInfo.activeWork === 1 ? "it" : "them"} now.`} Unfinished downloads are lost too.
            </p>
          ))}
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

      <StartGpuDialog
        open={!!startAsk}
        action={startAsk?.action}
        details={startAsk?.extra?.details}
        confirmLabel={startAsk?.extra?.confirmLabel}
        selfStopOff={selfStopOff}
        onAnswer={answerStart}
        info={
          startInfo && {
            profile: startInfo.profile,
            gpu: startInfo.state?.gpuType ? startInfo.gpuName : startInfo.startTarget,
            costPerHr: startInfo.costPerHr,
            costKnown: startInfo.state?.costPerHr != null,
            idleMinutes: startInfo.idleMinutes,
          }
        }
      />
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
