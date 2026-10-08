import { useEffect, useRef, useState } from "react";
import { fileSrc, isJobActive, type Job, type JobProgress } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatDuration, pct } from "../../lib/format";

export interface JobView extends Job {
  modelName: string;
  prompt: string;
  startedAt: number;
}

/** v1 phases, used when the worker doesn't report stages. */
const PHASE: Record<string, string> = {
  loading: "Loading model",
  sampling: "Sampling",
  saving: "Saving image",
  downloading: "Fetching files",
};

const STAGE_LABEL: Record<string, string> = {
  loading_text_encoder: "Loading text encoder",
  encoding_prompt: "Encoding prompt",
  loading_model: "Loading model",
  preparing_init_image: "Preparing start image",
  preparing_references: "Preparing references",
  sampling: "Generating",
  decoding: "Decoding",
  saving: "Saving",
};

const LOADER_STAGES = new Set(["loading_text_encoder", "loading_model"]);

/** The pod start phases (mirror of app/src-tauri/src/pod.rs PHASE_*). */
const POD_PHASES = ["Creating pod", "Waiting for machine", "Pulling image", "Booting ComfyUI"];

/** Models that finished an image in this session (their weights are likely in GPU memory). */
const warmModels = new Set<string>();

/** How many recent step updates the seconds-per-step estimate is smoothed over. */
const ETA_WINDOW = 5;

type StepState = "done" | "current" | "pending";
interface StepItem {
  key: string;
  label: string;
  state: StepState;
  /** Time shown next to the label: duration when done, live elapsed when current. */
  time: string | null;
}

/** 0:07, 1:42, 12:05 — a ticking clock reads better than "8.0 s". */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Stage durations: "0.4 s", "8.2 s", "42.0 s", "2 min 5 s". */
function secs(ms: number): string {
  const v = Math.max(0, ms);
  return v < 60_000 ? `${(v / 1000).toFixed(1)} s` : formatDuration(v);
}

function etaText(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  return s < 60 ? `~${s} s left` : `~${Math.floor(s / 60)} min ${s % 60} s left`;
}

export function JobCard({
  job,
  podMode,
  onCancel,
  onDismiss,
  onOpenImage,
}: {
  job: JobView;
  /** Dedicated GPU pod backend (vs legacy serverless): changes what "starting" means. */
  podMode: boolean;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenImage: (id: string) => void;
}) {
  const active = isJobActive(job);
  const [tick, setNow] = useState(Date.now());
  // The ticker only drives re-renders; read the real clock so timers never lag a fresh update.
  const now = Math.max(tick, Date.now());
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [active]);

  useEffect(() => {
    if (job.completed > 0 && job.modelName) warmModels.add(job.modelName);
  }, [job.completed, job.modelName]);

  const k = Math.min(job.completed + 1, job.total);
  const p = job.progress;
  const staged = job.status === "running" && !!p?.stage;
  const podPhase = job.status === "starting" && p?.phase ? p.phase : null;

  // When the latest progress payload arrived (stage timers count on from there).
  const recv = useRef<{ key: string; at: number }>({ key: "", at: Date.now() });
  const pKey = p ? `${k}|${p.stage ?? p.phase}|${p.elapsedMs ?? ""}|${p.step ?? ""}` : "";
  if (recv.current.key !== pKey) recv.current = { key: pKey, at: Date.now() };
  const sinceUpdate = Math.max(0, now - recv.current.at);

  // First time each pod phase was seen, for the done-phase durations.
  const podSeen = useRef(new Map<string, number>());
  if (podPhase && !podSeen.current.has(podPhase)) podSeen.current.set(podPhase, Date.now());

  // Recent (time, step) samples while sampling, for the ETA.
  const samples = useRef<{ k: number; list: { t: number; step: number }[] }>({ k: 0, list: [] });
  const eta = updateEta(samples.current, k, p, staged);

  let title: string;
  let bar: { value: number; indeterminate: boolean; tone?: "accent" | "warn" | "muted" } | null;
  let caption: { left: string; right?: string } | null = null;
  let steps: StepItem[] | null = null;
  let hint: string | null = null;

  switch (job.status) {
    case "queued":
      title = "Queued…";
      bar = { value: 0, indeterminate: true, tone: "muted" };
      break;
    case "starting":
      if (podPhase) {
        title = "Starting GPU";
        steps = podSteps(podPhase, podSeen.current, now);
        bar = null;
        hint = "First start on a new machine downloads the image (~3–8 min).";
      } else {
        title = podMode ? "Queued on the GPU…" : "Starting GPU… (cold start can take a minute)";
        bar = { value: 0, indeterminate: true, tone: podMode ? "muted" : "warn" };
      }
      break;
    case "running":
      if (staged) {
        const prog = p!;
        title = job.total > 1 ? `Generating image ${k} of ${job.total}` : "Generating image";
        steps = stageSteps(prog, sinceUpdate);
        const step = prog.step ?? 0;
        const total = prog.totalSteps ?? 0;
        if (prog.stage === "sampling" && total) {
          const percent = pct(step, total);
          bar = { value: percent, indeterminate: false };
          caption = {
            left: `Step ${step} of ${total} · ${Math.round(percent)}%`,
            right: eta == null ? "estimating…" : etaText(eta),
          };
        } else if (prog.stage === "decoding" || prog.stage === "saving") {
          bar = { value: 100, indeterminate: false };
        } else {
          bar = { value: 0, indeterminate: true };
        }
        const loading = LOADER_STAGES.has(String(prog.stage));
        if (loading && !prog.cached && job.completed === 0 && !warmModels.has(job.modelName)) {
          hint = "First use loads the model into GPU memory.";
        }
      } else {
        // Older worker without stages: phase + step bar.
        const phase = p?.phase ?? null;
        const hasSteps = p?.step != null && !!p?.totalSteps;
        title = phase
          ? `${PHASE[phase] ?? phase}${hasSteps && phase === "sampling" ? ` — step ${p!.step}/${p!.totalSteps}` : "…"}`
          : hasSteps
            ? `Step ${p!.step}/${p!.totalSteps}`
            : "Running…";
        bar = { value: hasSteps ? pct(p!.step!, p!.totalSteps!) : 0, indeterminate: !hasSteps || phase === "loading" };
      }
      break;
    case "completed":
      title = `Done — ${job.total} image${job.total > 1 ? "s" : ""}`;
      bar = { value: 100, indeterminate: false };
      break;
    case "cancelled":
      title = "Cancelled";
      bar = { value: 0, indeterminate: false, tone: "muted" };
      break;
    default:
      title = "Failed";
      bar = { value: 100, indeterminate: false, tone: "warn" };
  }

  const showCountTag = job.total > 1 && active && !staged;
  const promptLine = `${job.modelName}${job.prompt ? ` · ${job.prompt}` : ""}`;

  return (
    <article className={`job-card job-card--${job.status}`} aria-label={`Generation: ${job.prompt}`}>
      <div className="job-card__head">
        <div className="job-card__status">
          {active ? <span className="pulse" aria-hidden /> : <Icon name={job.status === "completed" ? "check" : job.status === "failed" ? "alert" : "stop"} />}
          <span className="job-card__title" aria-live="polite">
            {title}
          </span>
        </div>
        <div className="job-card__meta">
          {showCountTag && (
            <span className="tag mono">
              image {k} of {job.total}
            </span>
          )}
          {active && (
            <span className="hint mono" title="Elapsed">
              {clock(now - job.startedAt)}
            </span>
          )}
          {active ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
              <Icon name="stop" /> Cancel
            </button>
          ) : (
            <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss" onClick={onDismiss}>
              <Icon name="x" />
            </button>
          )}
        </div>
      </div>

      {steps && (
        <ol className="stages" aria-label={podPhase ? "GPU start progress" : "Generation steps"}>
          {steps.map((s) => (
            <li key={s.key} className={`stage stage--${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
              <span className="stage__icon" aria-hidden>
                {s.state === "done" ? <Icon name="check" /> : s.state === "current" ? <span className="stage__spin" /> : <span className="stage__dot" />}
              </span>
              <span className="stage__label">{s.label}</span>
              {s.time && <span className="stage__time">{s.time}</span>}
              <span className="visually-hidden">{s.state === "done" ? " (done)" : s.state === "current" ? " (in progress)" : " (pending)"}</span>
            </li>
          ))}
        </ol>
      )}

      {bar && (
        <div className="job-card__progress">
          <ProgressBar label="Generation progress" value={bar.value} indeterminate={bar.indeterminate} tone={bar.tone} />
          {caption && (
            <div className="job-card__caption mono">
              <span>{caption.left}</span>
              {caption.right && <span className="job-card__eta">{caption.right}</span>}
            </div>
          )}
        </div>
      )}

      {hint && (
        <p className="job-card__hint">
          <Icon name="info" /> <span>{hint}</span>
        </p>
      )}

      <div className="job-card__foot">
        <p className="job-card__prompt" title={promptLine}>
          <strong>{job.modelName}</strong>
          {job.prompt ? ` · ${job.prompt}` : ""}
        </p>
        {job.images.length > 0 && (
          <div className="job-card__thumbs">
            {job.images.map((im) => (
              <button key={im.id} type="button" className="job-thumb" onClick={() => onOpenImage(im.id)} aria-label={`Open image seed ${im.seed}`}>
                <img src={fileSrc(im.path)} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>
      {job.error && <p className="job-card__error">{job.error}</p>}
    </article>
  );
}

/** The worker's stage checklist: done (time taken or "cached"), current (live elapsed), pending. */
function stageSteps(p: JobProgress, sinceUpdate: number): StepItem[] {
  const current = String(p.stage);
  const list = p.stages?.length ? [...p.stages] : [current];
  if (!list.includes(current)) list.push(current);
  const times = p.stageTimes ?? {};
  const cached = new Set(p.cachedStages ?? []);
  return list.map((s) => {
    const label = STAGE_LABEL[s] ?? s.replace(/_/g, " ");
    if (s === current) {
      return { key: s, label, state: "current", time: secs((p.stageElapsedMs ?? 0) + sinceUpdate) };
    }
    if (cached.has(s)) return { key: s, label, state: "done", time: "cached" };
    if (s in times) return { key: s, label, state: "done", time: secs(times[s]) };
    return { key: s, label, state: "pending", time: null };
  });
}

/** The pod start phases as a checklist; durations from when each phase was first seen. */
function podSteps(phase: string, seen: Map<string, number>, now: number): StepItem[] {
  const idx = POD_PHASES.indexOf(phase);
  if (idx < 0) {
    const t = seen.get(phase);
    return [{ key: phase, label: phase, state: "current", time: t ? secs(now - t) : null }];
  }
  return POD_PHASES.map((ph, i) => {
    const t = seen.get(ph);
    if (i < idx) {
      const next = seen.get(POD_PHASES[i + 1]);
      return { key: ph, label: ph, state: "done", time: t && next ? secs(next - t) : null };
    }
    if (i === idx) return { key: ph, label: ph, state: "current", time: t ? secs(now - t) : null };
    return { key: ph, label: ph, state: "pending", time: null };
  });
}

/**
 * Seconds left in sampling: remaining steps × seconds per step, smoothed over
 * the last few step updates. Uses the worker's elapsedMs when present (exact),
 * else the arrival time. Step 0 is skipped: the first step includes moving the
 * model onto the GPU. Returns null until two updates have been seen.
 */
function updateEta(
  st: { k: number; list: { t: number; step: number }[] },
  k: number,
  p: JobProgress | null,
  staged: boolean,
): number | null {
  if (st.k !== k) {
    st.k = k;
    st.list = [];
  }
  if (!staged || !p || p.stage !== "sampling" || !p.step || !p.totalSteps) return null;
  const last = st.list[st.list.length - 1];
  if (last && p.step < last.step) st.list = [];
  if (!last || p.step > last.step) {
    st.list.push({ t: p.elapsedMs ?? Date.now(), step: p.step });
    if (st.list.length > ETA_WINDOW) st.list.shift();
  }
  if (st.list.length < 2) return null;
  const a = st.list[0];
  const b = st.list[st.list.length - 1];
  const perStep = (b.t - a.t) / 1000 / (b.step - a.step);
  if (!isFinite(perStep) || perStep <= 0) return null;
  return (p.totalSteps - p.step) * perStep;
}
