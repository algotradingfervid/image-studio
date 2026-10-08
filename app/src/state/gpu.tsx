// The dedicated GPU pod: live state from `gpu-update`, Start/Stop, and the two
// confirmations that go with it (stopping while work runs, starting a billed pod
// for a Models-screen action).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { gpuIsOff, isTaskActive, type GpuState, type Job } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { formatUsd, shortGpuName } from "../lib/format";
import { useLibrary } from "./library";
import { useToast } from "./toast";

const DEFAULT_COST = 2.49;
const DEFAULT_IDLE = 30;

interface Gpu {
  /** null until the first get_gpu_state answers. */
  state: GpuState | null;
  /** The pod backend is selected (false for legacy serverless: no pill, no prompts). */
  podMode: boolean;
  /** Short name of the pod's actual GPU ("RTX PRO 6000"); before a pod exists, the first-priority GPU. */
  gpuName: string;
  /** What a start will try: "RTX PRO 6000" or "RTX PRO 6000 or the next available GPU". */
  startTarget: string;
  /** The pod's price when known, else the settings fallback. */
  costPerHr: number;
  /** "~$2.49/h" when the pod reports its price, else "~$2.49/h or less" (the GPU isn't chosen yet). */
  costLabel: string;
  idleMinutes: number;
  /** Jobs + model/LoRA tasks that are queued or running. */
  activeWork: number;
  start(): Promise<void>;
  /** Stops the pod; asks first (in-app) when a job or task is active. */
  stop(): void;
  /**
   * Before an action that auto-starts the GPU: resolves true at once when the GPU is
   * starting/running (or in serverless mode); otherwise asks and resolves with the answer.
   */
  confirmStart(action?: string): Promise<boolean>;
}

const Ctx = createContext<Gpu | null>(null);

export function useGpu(): Gpu {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGpu outside provider");
  return v;
}

const jobActive = (j: Job) => api.isJobActive(j);

export function GpuProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const lib = useLibrary();
  const [state, setState] = useState<GpuState | null>(null);
  const prev = useRef<GpuState | null>(null);
  const [activeJobIds, setActiveJobIds] = useState<Set<string>>(() => new Set());
  const [stopAsk, setStopAsk] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startAsk, setStartAsk] = useState<{ action?: string; resolve: (ok: boolean) => void } | null>(null);

  const podMode = (lib.settings?.backend ?? "pod") === "pod";
  const knownCost = state?.costPerHr ?? null;
  const costPerHr = knownCost ?? lib.settings?.fallbackCostPerHr ?? DEFAULT_COST;
  const costLabel = knownCost != null ? `~${formatUsd(knownCost)}/h` : `~${formatUsd(costPerHr)}/h or less`;
  const idleMinutes = state?.idleMinutes ?? lib.settings?.idleMinutes ?? DEFAULT_IDLE;
  const firstGpu = lib.settings?.gpuTypes?.[0] ?? lib.settings?.gpuType;
  const gpuName = shortGpuName(state?.gpuType ?? firstGpu);
  const startTarget = (lib.settings?.gpuTypes?.length ?? 0) > 1 ? `${shortGpuName(firstGpu)} or the next available GPU` : shortGpuName(firstGpu);
  const activeTasks = lib.models.filter((m) => isTaskActive(m.task)).length + lib.loras.filter((l) => isTaskActive(l.task)).length;
  const activeWork = activeJobIds.size + activeTasks;

  // Toast only on transitions, so a re-emitted state doesn't toast twice.
  const apply = useCallback(
    (g: GpuState) => {
      const before = prev.current;
      prev.current = g;
      setState(g);
      if (!before || before.status === g.status) return;
      if (g.status === "stopped" && g.stopReason === "idle") {
        toast.info(`GPU stopped after ${g.idleMinutes} idle minutes`, "Start it again any time — generating starts it too.");
      } else if (g.status === "stopped" && g.stopReason === "external") {
        toast.info("The GPU pod stopped", "It was stopped outside the app — by its own idle watchdog or in the RunPod console.");
      } else if (g.status === "error") {
        toast.error("GPU problem", g.error ?? undefined);
      }
    },
    [toast],
  );

  useEffect(() => {
    let alive = true;
    api
      .getGpuState()
      .then((g) => {
        // An event may already have delivered something newer.
        if (alive && !prev.current) {
          prev.current = g;
          setState(g);
        }
      })
      .catch((e) => toast.error("Couldn't read the GPU state", e));
    const un = api.onEvent("gpu-update", apply);
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, [apply, toast]);

  // Track active generation jobs (for the Stop confirmation).
  useEffect(() => {
    let alive = true;
    api
      .listJobs()
      .then((js) => {
        if (!alive) return;
        setActiveJobIds((cur) => new Set([...cur, ...js.filter(jobActive).map((j) => j.jobId)]));
      })
      .catch(() => {
        /* nothing to track */
      });
    const un = api.onEvent("job-update", (j) => {
      setActiveJobIds((cur) => {
        const on = jobActive(j);
        if (on === cur.has(j.jobId)) return cur;
        const next = new Set(cur);
        if (on) next.add(j.jobId);
        else next.delete(j.jobId);
        return next;
      });
    });
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  const start = useCallback(async () => {
    try {
      apply(await api.startGpu());
    } catch (e) {
      toast.error("Couldn't start the GPU", e);
    }
  }, [apply, toast]);

  const doStop = useCallback(async () => {
    setStopping(true);
    try {
      apply(await api.stopGpu());
    } catch (e) {
      toast.error("Couldn't stop the GPU", e);
    } finally {
      setStopping(false);
      setStopAsk(false);
    }
  }, [apply, toast]);

  const activeWorkRef = useRef(activeWork);
  activeWorkRef.current = activeWork;
  const stop = useCallback(() => {
    if (activeWorkRef.current > 0) setStopAsk(true);
    else void doStop();
  }, [doStop]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const podModeRef = useRef(podMode);
  podModeRef.current = podMode;
  const confirmStart = useCallback((action?: string) => {
    if (!podModeRef.current || !gpuIsOff(stateRef.current)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => setStartAsk({ action, resolve }));
  }, []);

  const answerStart = (ok: boolean) => {
    startAsk?.resolve(ok);
    setStartAsk(null);
  };

  const value = useMemo<Gpu>(
    () => ({ state, podMode, gpuName, startTarget, costPerHr, costLabel, idleMinutes, activeWork, start, stop, confirmStart }),
    [state, podMode, gpuName, startTarget, costPerHr, costLabel, idleMinutes, activeWork, start, stop, confirmStart],
  );

  const work = [
    activeJobIds.size ? `${activeJobIds.size} generation${activeJobIds.size === 1 ? "" : "s"}` : null,
    activeTasks ? `${activeTasks} download/delete task${activeTasks === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <Ctx.Provider value={value}>
      {children}

      <Dialog
        open={stopAsk}
        onClose={stopping ? () => {} : () => setStopAsk(false)}
        title="Stop the GPU?"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setStopAsk(false)} disabled={stopping} autoFocus>
              Keep running
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void doStop()} disabled={stopping}>
              <Icon name="stop" /> {stopping ? "Stopping…" : "Stop GPU"}
            </button>
          </>
        }
      >
        <p className="gpu-dialog__lede">
          {work || "Work"} {activeWork === 1 ? "is" : "are"} still running on the GPU. Stopping the pod ends {activeWork === 1 ? "it" : "them"} now —
          unfinished images and downloads are lost.
        </p>
      </Dialog>

      <Dialog
        open={!!startAsk}
        onClose={() => answerStart(false)}
        title={startAsk?.action ? `Start the GPU to ${startAsk.action}?` : "Start the GPU?"}
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
        <p className="gpu-dialog__lede">
          This starts the GPU pod ({startTarget}, {costLabel}). It auto-stops after {idleMinutes} idle minutes.
        </p>
        <p className="hint">Starting takes a few minutes; the action waits in the queue until the GPU is ready.</p>
      </Dialog>
    </Ctx.Provider>
  );
}
