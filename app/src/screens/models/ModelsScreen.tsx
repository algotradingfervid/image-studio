import { useEffect, useState } from "react";
import * as api from "../../api";
import { isTaskActive, type DeletePreview, type ModelView } from "../../api";
import { Dialog, ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, formatRelative, pct, toDate } from "../../lib/format";
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
  const vol = lib.status?.volume;
  const used = vol ? vol.totalBytes - vol.freeBytes : 0;
  const checked = toDate(lib.status?.checkedAt);

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <div>
            <h1 className="page__title">Models</h1>
            <p className="page__lede">Weights live on your RunPod network volume, not on this Mac.</p>
          </div>
        </header>

        <section className="card volume" aria-labelledby="vol-title">
          <div className="volume__top">
            <div>
              <h2 id="vol-title" className="card__title">
                <Icon name="cloud" /> Network volume
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
                Last checked {formatRelative(lib.status?.checkedAt)}
              </span>
              <button type="button" className="btn" onClick={() => void lib.refreshStatus()} disabled={lib.refreshing} aria-describedby="refresh-note">
                <Icon name="refresh" className={lib.refreshing ? "spin" : ""} />
                {lib.refreshing ? "Checking…" : "Refresh"}
              </button>
            </div>
          </div>
          <ProgressBar label="Volume usage" value={vol ? pct(used, vol.totalBytes) : 0} tone={vol && vol.freeBytes < 10 * 1024 ** 3 ? "warn" : undefined} />
          <p id="refresh-note" className="hint">
            <Icon name="bolt" size={12} /> Refresh briefly starts a GPU worker to list the volume (a few cents). It also runs after every download or delete.
          </p>
        </section>

        <div className="model-list">
          {lib.models.map((m) => (
            <ModelCard key={m.id} model={m} all={lib.models} />
          ))}
          {lib.models.length === 0 && <div className="skeleton skeleton--block" aria-label="Loading models" />}
        </div>

        <LoraLibrary />
      </div>
    </div>
  );
}

function ModelCard({ model: m, all }: { model: ModelView; all: ModelView[] }) {
  const lib = useLibrary();
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
            <li>
              <span className="meta-row__k">References</span> {m.maxReferences || "—"}
            </li>
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
              {task.kind === "delete" ? "Deleting" : task.status === "queued" ? "Queued — waiting for a worker" : "Downloading"}
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

      <DeleteDialog model={m} open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </article>
  );
}

function DeleteDialog({ model: m, open, onClose }: { model: ModelView; open: boolean; onClose: () => void }) {
  const lib = useLibrary();
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
            <Icon name="trash" /> {busy ? "Deleting…" : preview ? `Delete ${preview.deleteFiles.length} file${preview.deleteFiles.length === 1 ? "" : "s"}` : "Delete"}
          </button>
        </>
      }
    >
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
