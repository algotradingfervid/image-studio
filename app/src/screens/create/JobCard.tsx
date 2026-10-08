import { useEffect, useState } from "react";
import { fileSrc, isJobActive, type Job } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatDuration, pct } from "../../lib/format";

export interface JobView extends Job {
  modelName: string;
  prompt: string;
  startedAt: number;
}

const PHASE: Record<string, string> = {
  loading: "Loading model",
  sampling: "Sampling",
  saving: "Saving image",
  downloading: "Fetching files",
};

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
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(h);
  }, [active]);

  const k = Math.min(job.completed + 1, job.total);
  const p = job.progress;
  let title: string;
  let bar: { value: number; indeterminate: boolean; tone?: "accent" | "warn" | "muted" };
  switch (job.status) {
    case "queued":
      title = "Queued…";
      bar = { value: 0, indeterminate: true, tone: "muted" };
      break;
    case "starting":
      // Pod backend: progress.phase = the pod's boot phase; no progress = queued on the pod.
      title = p?.phase
        ? `Starting GPU · ${p.phase}`
        : podMode
          ? "Queued on the GPU…"
          : "Starting GPU… (cold start can take a minute)";
      bar = { value: 0, indeterminate: true, tone: p?.phase || !podMode ? "warn" : "muted" };
      break;
    case "running":
      {
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
          {job.total > 1 && active && (
            <span className="tag mono">
              image {k} of {job.total}
            </span>
          )}
          {active && <span className="hint mono">{formatDuration(now - job.startedAt)}</span>}
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
      <ProgressBar label="Generation progress" value={bar.value} indeterminate={bar.indeterminate} tone={bar.tone} />
      <div className="job-card__foot">
        <span className="job-card__prompt">
          <strong>{job.modelName}</strong>
          {job.prompt ? ` · ${job.prompt}` : ""}
        </span>
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
