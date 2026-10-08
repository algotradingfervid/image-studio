import { useEffect, useState } from "react";
import * as api from "../../api";
import { gpuIsOff, isTaskActive, type DeletePreview, type GpuProfile, type ModelView } from "../../api";
import { Dialog, ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, formatRelative, pct, toDate } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { LoraLibrary } from "./LoraLibrary";

export function ModelsScreen({ active }: { active: boolean }) {
  const lib = useLibrary();
  const { reloadStatus } = lib;
  // Cached status only (no GPU) each time the tab opens.
  useEffect(() => {
    if (active) void reloadStatus();
  }, [active, reloadStatus]);
  const [, tick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(h);
  }, []);

  const videoVolume = lib.videoModels.find((m) => m.volume)?.volume ?? lib.settings?.videoVolumeNames?.[0] ?? "image-studio-video";

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <div>
            <h1 className="page__title">Models</h1>
            <p className="page__lede">Weights live on your RunPod network volumes, not on this Mac.</p>
          </div>
        </header>

        <VolumeCard profile="image" />

        <div className="model-list">
          {lib.imageModels.map((m) => (
            <ModelCard key={m.id} model={m} all={lib.models} profile="image" />
          ))}
          {lib.imageModels.length === 0 && <div className="skeleton skeleton--block" aria-label="Loading models" />}
        </div>

        <LoraLibrary />

        <section className="video-models" aria-labelledby="video-models-title">
          <header className="video-models__head">
            <h2 id="video-models-title" className="page__subtitle">
              <Icon name="video" /> Video models (Canada)
            </h2>
            <p className="page__lede">
              On their own volume <span className="mono">{videoVolume}</span> in <strong>{VIDEO_REGION}</strong>, with their own GPU pod. MiniMax H3's
              licence excludes running it in the EU, UK, South Korea and USA.
            </p>
          </header>
          <VolumeCard profile="video" />
          <div className="model-list">
            {lib.videoModels.map((m) => (
              <ModelCard key={m.id} model={m} all={lib.models} profile="video" />
            ))}
            {lib.loaded && lib.videoModels.length === 0 && (
              <p className="notice notice--inline">
                <Icon name="info" /> No video models in this build — they appear here once the model registry lists them.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const VIDEO_REGION = "CA-MTL-3 (Canada)";

/** One profile's network volume: usage, last checked, Refresh (starts that profile's GPU). */
function VolumeCard({ profile }: { profile: GpuProfile }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const isVideo = profile === "video";
  const status = isVideo ? lib.videoStatus : lib.status;
  const refreshing = isVideo ? lib.videoRefreshing : lib.refreshing;
  const vol = status?.volume;
  const used = vol ? vol.totalBytes - vol.freeBytes : 0;
  const checked = toDate(status?.checkedAt);
  const name = isVideo
    ? (lib.videoModels.find((m) => m.volume)?.volume ?? lib.settings?.videoVolumeNames?.[0] ?? "image-studio-video")
    : (lib.settings?.volumeNames?.[0] ?? null);
  const refresh = async () => {
    if (await gpu.confirmStart(isVideo ? "refresh the video volume status" : "refresh the volume status", profile)) void lib.refreshStatus(profile);
  };
  const titleId = `vol-title-${profile}`;
  const noteId = `refresh-note-${profile}`;
  return (
    <section className="card volume" aria-labelledby={titleId}>
      <div className="volume__top">
        <div>
          <h2 id={titleId} className="card__title">
            <Icon name="cloud" /> {isVideo ? "Video volume" : "Network volume"}
            {name && <span className="mono hint volume__name">{name}</span>}
            {isVideo && <span className="badge badge--muted">{VIDEO_REGION}</span>}
          </h2>
          <p className="volume__numbers">
            {vol ? (
              <>
                <strong className="mono">{formatBytes(used)}</strong> used of <span className="mono">{formatBytes(vol.totalBytes)}</span> ·{" "}
                <span className="mono">{formatBytes(vol.freeBytes)}</span> free
              </>
            ) : (
              "Not checked yet"
            )}
          </p>
        </div>
        <div className="volume__actions">
          <span className="hint" title={checked ? checked.toLocaleString() : undefined}>
            Last checked {formatRelative(status?.checkedAt)}
          </span>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={refreshing} aria-describedby={noteId}>
            <Icon name="refresh" className={refreshing ? "spin" : ""} />
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      <ProgressBar
        label={isVideo ? "Video volume usage" : "Volume usage"}
        value={vol ? pct(used, vol.totalBytes) : 0}
        tone={vol && vol.freeBytes < 10 * 1024 ** 3 ? "warn" : undefined}
      />
      <p id={noteId} className="hint">
        <Icon name="bolt" size={12} />{" "}
        {isVideo
          ? `Refresh lists the video volume on the video GPU pod (${gpu.profiles.video.startTarget}, ${gpu.profiles.video.costLabel}) — it starts that pod first if it's stopped. It also runs after every video-model download or delete.`
          : gpu.podMode
            ? "Refresh lists the volume on the GPU pod — it starts the pod first if it's stopped. It also runs after every download or delete."
            : "Refresh briefly starts a GPU worker to list the volume (a few cents). It also runs after every download or delete."}
      </p>
    </section>
  );
}

function ModelCard({ model: m, all, profile }: { model: ModelView; all: ModelView[]; profile: GpuProfile }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const pg = gpu.profiles[profile];
  const isVideo = profile === "video";
  const toast = useToast();
  const task = isTaskActive(m.task) ? m.task : null;
  const [starting, setStarting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const missingBytes = m.totalBytes - m.presentBytes;
  const presentCount = m.files.filter((f) => f.present).length;
  const gated = m.files.some((f) => f.gated);
  const state = m.installed ? "installed" : presentCount > 0 ? "partial" : "missing";

  const nameOf = (id: string) => all.find((o) => o.id === id)?.name ?? id;

  const download = async () => {
    if (!(await gpu.confirmStart(`download ${m.name}`, profile))) return;
    setStarting(true);
    try {
      const t = await api.downloadModel(m.id);
      lib.applyTask(t);
    } catch (e) {
      toast.error(`Couldn't start downloading ${m.name}`, e);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!task) return;
    try {
      await api.cancelTask(task.taskId);
    } catch (e) {
      toast.error("Couldn't cancel", e);
    }
  };

  return (
    <article className={`card model-panel model-panel--${state}`} aria-labelledby={`m-${m.id}`}>
      <header className="model-panel__head">
        <div>
          <div className="model-panel__title-row">
            <h2 id={`m-${m.id}`} className="card__title">
              {m.name}
            </h2>
            <span className={`badge ${state === "installed" ? "badge--ok" : state === "partial" ? "badge--warn" : "badge--muted"}`}>
              {state === "installed" ? "Installed" : state === "partial" ? `${presentCount} of ${m.files.length} files` : "Not installed"}
            </span>
          </div>
          <p className="model-panel__desc">{m.description}</p>
          <ul className="meta-row" aria-label="Model details">
            <li>
              <span className="meta-row__k">Licence</span> {m.license}
            </li>
            <li>
              <span className="meta-row__k">Precision</span> {m.precision}
            </li>
            <li>
              <span className="meta-row__k">Size</span> <span className="mono">{formatBytes(m.totalBytes)}</span>
            </li>
            {isVideo ? (
              <>
                <li>
                  <span className="meta-row__k">Modes</span> {(m.modes ?? []).map((x) => (x === "t2v" ? "text → video" : x === "i2v" ? "image → video" : x)).join(", ") || "—"}
                </li>
                <li>
                  <span className="meta-row__k">Audio</span> {m.audio ? "yes" : "no"}
                </li>
                <li>
                  <span className="meta-row__k">Region</span> {VIDEO_REGION}
                  {m.volume ? <span className="mono hint"> · {m.volume}</span> : null}
                </li>
              </>
            ) : (
              <li>
                <span className="meta-row__k">References</span> {m.maxReferences || "—"}
              </li>
            )}
          </ul>
        </div>
        <div className="model-panel__actions">
          {task ? (
            task.kind === "download" ? (
              <button type="button" className="btn btn--ghost" onClick={cancel}>
                <Icon name="stop" /> Cancel
              </button>
            ) : null
          ) : (
            <>
              {!m.installed && (
                <button type="button" className="btn btn--primary" onClick={download} disabled={starting}>
                  <Icon name="download" /> {starting ? "Starting…" : `Download ${formatBytes(missingBytes)}`}
                </button>
              )}
              {presentCount > 0 && (
                <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setDeleteOpen(true)}>
                  <Icon name="trash" /> Delete
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {gated && (
        <p className="notice notice--warn">
          <Icon name="lock" /> Requires HF_TOKEN and licence acceptance on Hugging Face before it can download.
        </p>
      )}

      {task && (
        <div className="task-progress" aria-live="polite">
          <div className="task-progress__label">
            <span>
              {task.kind === "delete"
                ? task.status === "queued"
                  ? "Queued to delete"
                  : "Deleting"
                : task.status === "queued"
                  ? gpu.podMode && pg.state?.status === "starting"
                    ? `Queued — starting the ${isVideo ? "video " : ""}GPU${pg.state.phase ? ` · ${pg.state.phase}` : ""}`
                    : "Queued — waiting for a worker"
                  : "Downloading"}
              {task.file ? <span className="mono hint"> · {task.file}</span> : null}
            </span>
            <span className="mono">
              {formatBytes(task.bytes)} / {formatBytes(task.totalBytes)} · {Math.round(pct(task.bytes, task.totalBytes))}%
            </span>
          </div>
          <ProgressBar label={`${m.name} download`} value={pct(task.bytes, task.totalBytes)} indeterminate={task.status === "queued"} />
        </div>
      )}

      <ul className="file-list" aria-label={`${m.name} files`}>
        {m.files.map((f) => {
          const shared = (f.sharedWith ?? []).map(nameOf);
          const isCurrent = task?.file === f.filename;
          return (
            <li key={f.filename} className={`file-row ${f.present ? "is-present" : ""}`}>
              <span className={`file-row__state ${isCurrent ? "is-active" : ""}`} aria-label={f.present ? "Present" : isCurrent ? "Downloading" : "Missing"}>
                <Icon name={f.present ? "check" : isCurrent ? "download" : "x"} size={13} />
              </span>
              <span className="tag tag--folder">{f.folder}</span>
              <span className="file-row__name mono" title={f.url}>
                {f.filename}
              </span>
              {shared.length > 0 && <span className="badge badge--shared">shared with {shared.join(", ")}</span>}
              {f.gated && <span className="badge badge--warn">gated</span>}
              <span className="file-row__size mono">{formatBytes(f.sizeBytes)}</span>
            </li>
          );
        })}
      </ul>

      {isVideo && m.id === "h3" && (
        <p className="notice notice--warn">
          <Icon name="globe" /> Runs in Canada — license excludes EU/UK/KR/US. Commercial UIs must display “MiniMax H3”.
        </p>
      )}

      <DeleteDialog model={m} profile={profile} open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </article>
  );
}

function DeleteDialog({ model: m, profile, open, onClose }: { model: ModelView; profile: GpuProfile; open: boolean; onClose: () => void }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const pg = gpu.profiles[profile];
  // This dialog is already a confirmation, so the GPU-start notice lives inside it.
  const startsGpu = gpu.podMode && gpuIsOff(pg.state);
  const toast = useToast();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError(null);
    let alive = true;
    api
      .deletePreview(m.id)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(api.errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [open, m.id]);

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.deleteModel(m.id);
      onClose();
      if (r.task) {
        // Progress and the final toast come from task-update.
        lib.applyTask(r.task);
        toast.info(`Deleting ${m.name}`, `Frees ${formatBytes(r.freedBytes)}${r.keptFiles.length ? ` · keeps ${r.keptFiles.length} shared file(s)` : ""}`);
      } else {
        toast.info("Nothing to delete", "Every file is shared with another installed model.");
        void lib.reloadModels();
      }
    } catch (e) {
      toast.error(`Couldn't delete ${m.name}`, e);
    } finally {
      setBusy(false);
    }
  };

  const nothing = preview && preview.deleteFiles.length === 0;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Delete ${m.name}?`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={confirm} disabled={!preview || !!nothing || busy}>
            <Icon name="trash" />{" "}
            {busy
              ? "Deleting…"
              : `${startsGpu ? "Start GPU & delete" : "Delete"}${preview ? ` ${preview.deleteFiles.length} file${preview.deleteFiles.length === 1 ? "" : "s"}` : ""}`}
          </button>
        </>
      }
    >
      {startsGpu && preview && !nothing && (
        <p className="notice notice--warn">
          <Icon name="bolt" /> This starts the {profile === "video" ? "video GPU in Canada" : "GPU pod"} ({pg.startTarget}, {pg.costLabel}) if it isn't running. It
          auto-stops after {pg.idleMinutes} idle minutes.
        </p>
      )}
      {error && <p className="notice notice--error">{error}</p>}
      {!preview && !error && (
        <p className="hint">
          <Icon name="refresh" className="spin" /> Working out which files can go…
        </p>
      )}
      {preview && (
        <div className="delete-preview">
          <p className="delete-preview__freed">
            Frees <strong className="mono">{formatBytes(preview.freedBytes)}</strong> on the volume.
          </p>
          {preview.deleteFiles.length > 0 && (
            <>
              <h3 className="mini-title">Will be deleted</h3>
              <ul className="plain file-mini">
                {preview.deleteFiles.map((f) => (
                  <li key={f}>
                    <Icon name="trash" size={12} /> <span className="mono">{f}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.keptFiles.length > 0 && (
            <>
              <h3 className="mini-title">Kept</h3>
              <ul className="plain file-mini">
                {preview.keptFiles.map((k) => (
                  <li key={k.filename}>
                    <Icon name="lock" size={12} /> <span className="mono">{k.filename}</span>
                    <span className="hint"> — {k.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {nothing && <p className="hint">Nothing to delete: every file is shared with another installed model.</p>}
          <p className="hint">You can download it again any time.</p>
        </div>
      )}
    </Dialog>
  );
}
