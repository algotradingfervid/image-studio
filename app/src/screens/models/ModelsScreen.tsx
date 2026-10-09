import { useEffect, useRef, useState } from "react";
import * as api from "../../api";
import { isTaskActive, type DeletePreview, type GpuProfile, type ModelView } from "../../api";
import { Dialog, ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, formatRelative, pct, toDate } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { LoraLibrary } from "./LoraLibrary";
import "../../styles/gpu-settings.css";

// ---------------------------------------------------------------------------
// "Install in Models →" (UX-026): another screen asks Models to bring a model's card into view.

let pendingFocus: string | null = null;
const FOCUS_EVENT = "models:focus-model";

/**
 * Call right before switching to the Models tab: Models scrolls that model's card into view,
 * pulses its border and focuses its Download (or Cancel) button, and offers "Back to Create".
 */
export function requestModelFocus(modelId: string) {
  pendingFocus = modelId;
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}

const cardId = (id: string) => `model-card-${id}`;

/** The repo page of a Hugging Face file URL ("huggingface.co/org/repo"), for the licence hint. */
function hfRepo(url: string | undefined): string | null {
  const m = url?.match(/huggingface\.co\/([^/]+\/[^/]+)/);
  return m ? `huggingface.co/${m[1]}` : null;
}

const VIDEO_REGION = "CA-MTL-3 (Canada)";

const SECTIONS = [
  { id: "models-image", label: "Image models" },
  { id: "models-video", label: "Video models (Canada)" },
  { id: "lora-title", label: "LoRA library" },
] as const;

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

  // Bring a requested model's card into view once the tab shows and the models are loaded.
  const [focusWant, setFocusWant] = useState<string | null>(pendingFocus);
  const [cameFromCreate, setCameFromCreate] = useState(false);
  useEffect(() => {
    const on = () => setFocusWant(pendingFocus);
    window.addEventListener(FOCUS_EVENT, on);
    return () => window.removeEventListener(FOCUS_EVENT, on);
  }, []);
  useEffect(() => {
    if (!active || !focusWant || !lib.models.length) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(cardId(focusWant));
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("is-pulsing");
      void el.offsetWidth;
      el.classList.add("is-pulsing");
      window.setTimeout(() => el.classList.remove("is-pulsing"), 1600);
      el.querySelector<HTMLButtonElement>("[data-focus-target]")?.focus({ preventScroll: true });
      pendingFocus = null;
      setFocusWant(null);
      setCameFromCreate(true);
    }, 80);
    return () => window.clearTimeout(t);
  }, [active, focusWant, lib.models.length]);
  useEffect(() => {
    if (!active) setCameFromCreate(false);
  }, [active]);

  const videoVolume = lib.videoModels.find((m) => m.volume)?.volume ?? lib.settings?.videoVolumeNames?.[0] ?? "image-studio-video";

  return (
    <div className="page">
      <div className="page__inner">
        <header className="page__head">
          <div>
            <h1 className="page__title">Models</h1>
            <p className="page__lede">Weights live on your RunPod network volumes, not on this Mac. Image and video models each have their own volume and GPU pod.</p>
          </div>
          {cameFromCreate && (
            <button type="button" className="link-btn" onClick={() => (window.location.hash = "create")}>
              ← Back to Create
            </button>
          )}
        </header>
        <nav className="section-nav" aria-label="Models sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="section-nav__link" onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {s.label}
            </button>
          ))}
        </nav>

        <h2 id="models-image" className="page__subtitle">
          <Icon name="image" /> Image models
        </h2>
        <VolumeCard profile="image" />

        <div className="model-list">
          {lib.imageModels.map((m) => (
            <ModelCard key={m.id} model={m} all={lib.models} profile="image" />
          ))}
          {lib.imageModels.length === 0 && <div className="skeleton skeleton--block" aria-label="Loading models" />}
        </div>

        <section className="video-models" aria-labelledby="models-video">
          <header className="video-models__head">
            <h2 id="models-video" className="page__subtitle">
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

        <LoraLibrary />
      </div>
    </div>
  );
}

/** One profile's network volume: usage, last checked, Refresh (starts that profile's GPU). */
function VolumeCard({ profile }: { profile: GpuProfile }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const pg = gpu.profiles[profile];
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
    const ok = await gpu.confirmStart(isVideo ? "refresh the video volume status" : "refresh the volume status", profile, {
      details: [`Lists what is on ${name ?? "the volume"}; the GPU stops again when that's done (unless you start a generation meanwhile).`],
      confirmLabel: "Start GPU & refresh",
    });
    if (ok) void lib.refreshStatus(profile);
  };
  const titleId = `vol-title-${profile}`;
  const noteId = `refresh-note-${profile}`;
  return (
    <section className="card volume" aria-labelledby={titleId}>
      <div className="volume__top">
        <div>
          <h2 id={titleId} className="card__title">
            <Icon name="cloud" /> {isVideo ? "Video volume" : "Image volume"}
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
            <Icon name={pg.needsStart && !refreshing ? "bolt" : "refresh"} className={refreshing ? "spin" : ""} />
            {refreshing ? "Checking…" : pg.needsStart ? "Start GPU & refresh" : "Refresh"}
          </button>
        </div>
      </div>
      <ProgressBar
        label={isVideo ? "Video volume usage" : "Volume usage"}
        value={vol ? pct(used, vol.totalBytes) : 0}
        tone={vol && vol.freeBytes < 10 * 1024 ** 3 ? "warn" : undefined}
      />
      <p id={noteId} className="hint">
        <Icon name="bolt" size={12} /> Refresh lists the {isVideo ? "video volume on the video" : "image volume on the Images"} GPU pod ({pg.startTarget}, {pg.costLabel}) — it
        starts that pod first if it's stopped, and stops it again afterwards. It also runs after every download or delete.
      </p>
    </section>
  );
}

/** Models (other than `self`) that are installed, by id. */
function installedIds(all: ModelView[], self: string): Set<string> {
  return new Set(all.filter((o) => o.id !== self && o.installed).map((o) => o.id));
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
  const others = installedIds(all, m.id);
  const sharedInstalled = (f: (typeof m.files)[number]) => (f.sharedWith ?? []).filter((id) => others.has(id));
  // Files only this model needs: a file kept because an installed model shares it doesn't
  // make this one "partly installed" (UX-044).
  const ownPresent = m.files.filter((f) => f.present && sharedInstalled(f).length === 0);
  const keptShared = m.installed ? [] : m.files.filter((f) => f.present && sharedInstalled(f).length > 0);
  const gated = m.files.some((f) => f.gated);
  const deleting = task?.kind === "delete";
  const state = deleting ? "deleting" : m.installed ? "installed" : ownPresent.length > 0 ? "partial" : "missing";
  const presentCount = m.files.filter((f) => f.present).length;
  const volumeName = isVideo ? (m.volume ?? lib.settings?.videoVolumeNames?.[0] ?? "the video volume") : (lib.settings?.volumeNames?.[0] ?? "the image volume");
  const vol = (isVideo ? lib.videoStatus : lib.status)?.volume;
  const repo = hfRepo(m.files.find((f) => f.gated)?.url);

  const nameOf = (id: string) => all.find((o) => o.id === id)?.name ?? id;
  const gatedLine = `Gated on Hugging Face: the pod needs the RunPod secret image-studio-hf-token, and the licence accepted${repo ? ` on ${repo}` : ""} with that account. The app can't check either from here — a download fails with a clear error if one is missing.`;

  const download = async () => {
    const details = [`Downloads ${formatBytes(missingBytes)} to ${volumeName}${vol ? ` · about ${formatBytes(Math.max(0, vol.freeBytes - missingBytes))} free afterwards` : ""}.`];
    if (gated) details.push(gatedLine);
    if (!(await gpu.confirmStart(`download ${m.name}`, profile, { details, confirmLabel: `Start GPU & download ${formatBytes(missingBytes)}` }))) return;
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

  const deleteFiles = task?.file ? task.file.split(", ").filter(Boolean) : [];

  return (
    <article id={cardId(m.id)} className={`card model-panel model-panel--${state}`} aria-labelledby={`m-${m.id}`}>
      <header className="model-panel__head">
        <div>
          <div className="model-panel__title-row">
            <h2 id={`m-${m.id}`} className="card__title">
              {m.name}
            </h2>
            <span className={`badge ${state === "installed" ? "badge--ok" : state === "partial" || state === "deleting" ? "badge--warn" : "badge--muted"}`}>
              {state === "installed"
                ? "Installed"
                : state === "deleting"
                  ? "Deleting…"
                  : state === "partial"
                    ? `${presentCount} of ${m.files.length} files`
                    : "Not installed"}
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
            task.kind === "download" || task.status === "queued" ? (
              <button type="button" className="btn btn--ghost" onClick={cancel} data-focus-target>
                <Icon name="stop" /> {task.kind === "delete" ? "Cancel delete" : "Cancel"}
              </button>
            ) : null
          ) : (
            <>
              {!m.installed && (
                <button type="button" className="btn btn--primary" onClick={download} disabled={starting} data-focus-target>
                  <Icon name="download" /> {starting ? "Starting…" : `Download ${formatBytes(missingBytes)}`}
                </button>
              )}
              {(m.installed || ownPresent.length > 0) && (
                <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setDeleteOpen(true)} data-focus-target={m.installed ? "" : undefined}>
                  <Icon name="trash" /> Delete
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {gated && !m.installed && (
        <p className="notice notice--warn">
          <Icon name="lock" /> {gatedLine}
        </p>
      )}

      {task &&
        (deleting ? (
          <div className="task-progress" aria-live="polite">
            <div className="task-progress__label">
              <span>
                <Icon name="refresh" size={13} className="spin" />{" "}
                {task.status === "queued"
                  ? `Waiting for the ${isVideo ? "video " : ""}GPU${pg.state?.status === "starting" && pg.state.phase ? ` (${pg.state.phase})` : ""}… will delete ${deleteFiles.length || "the"} file${deleteFiles.length === 1 ? "" : "s"} (${formatBytes(task.totalBytes)})`
                  : `Deleting ${deleteFiles.length || ""} file${deleteFiles.length === 1 ? "" : "s"} (${formatBytes(task.totalBytes)})…`}
              </span>
            </div>
          </div>
        ) : (
          <div className="task-progress" aria-live="polite">
            <div className="task-progress__label">
              <span>
                {task.status === "queued"
                  ? pg.state?.status === "starting"
                    ? `Queued — starting the ${isVideo ? "video " : ""}GPU${pg.state.phase ? ` · ${pg.state.phase}` : ""}`
                    : "Queued — waiting for the GPU"
                  : "Downloading"}
                {task.file ? <span className="mono hint"> · {task.file}</span> : null}
              </span>
              <span className="mono">
                {formatBytes(task.bytes)} / {formatBytes(task.totalBytes)} · {Math.round(pct(task.bytes, task.totalBytes))}%
              </span>
            </div>
            <ProgressBar label={`${m.name} download`} value={pct(task.bytes, task.totalBytes)} indeterminate={task.status === "queued"} />
          </div>
        ))}

      <ul className="file-list" aria-label={`${m.name} files`}>
        {m.files.map((f) => {
          const shared = sharedInstalled(f).map(nameOf);
          const isCurrent = task?.kind === "download" && task?.file === f.filename;
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
      {keptShared.length > 0 && (
        <p className="hint">
          {keptShared.map((f) => `${f.filename} kept — used by ${sharedInstalled(f).map(nameOf).join(", ")}`).join(" · ")}
        </p>
      )}

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
  // Deleting runs on the GPU: when it isn't starting/running, the shared start confirmation follows.
  const startsGpu = pg.needsStart;
  const toast = useToast();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

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

  const n = preview?.deleteFiles.length ?? 0;
  const filesWord = `${n} file${n === 1 ? "" : "s"}`;
  const isVideo = profile === "video";
  // What else stops working (UX-043).
  const loras = lib.loras.filter((l) => l.modelId === m.id);
  const otherVideoInstalled = lib.videoModels.some((v) => v.id !== m.id && v.installed);
  const lastVideo = isVideo && m.installed && !otherVideoInstalled;

  const confirm = async () => {
    // The start confirmation opens over this dialog; Cancel there leaves this one open and deletes nothing.
    const details = [`Deletes ${filesWord} (${formatBytes(preview?.freedBytes ?? 0)}) of ${m.name}; the GPU stops again when that's done.`];
    if (!(await gpu.confirmStart(`delete ${m.name}`, profile, { details, confirmLabel: `Start GPU & delete ${filesWord}` }))) return;
    setBusy(true);
    try {
      const r = await api.deleteModel(m.id);
      onClose();
      if (r.task) {
        // Progress and the final toast come from task-update.
        lib.applyTask(r.task);
        const kept = r.keptFiles.map((k) => `${k.filename} (${k.reason.replace(/^Shared with /, "for ")})`).join(", ");
        toast.info(`Deleting ${m.name}`, `Frees ${formatBytes(r.freedBytes)}${kept ? ` · keeps ${kept}` : ""}`);
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
      initialFocusRef={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={confirm} disabled={!preview || !!nothing || busy}>
            <Icon name="trash" /> {busy ? "Deleting…" : preview ? `Delete ${m.name} (${filesWord})` : "Delete"}
          </button>
        </>
      }
    >
      {startsGpu && preview && !nothing && (
        <p className="notice notice--warn">
          <Icon name="bolt" /> Deleting needs the {isVideo ? "video GPU (Canada)" : "Images GPU (EU-RO-1)"}, which isn't running — you'll confirm starting it ({pg.costLabel}) next.
          It stops again when the delete is done.
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
          {!nothing && (loras.length > 0 || lastVideo) && (
            <>
              <h3 className="mini-title">This also affects</h3>
              <ul className="plain file-mini">
                {loras.map((l) => (
                  <li key={l.id}>
                    <Icon name="alert" size={12} /> LoRA <strong>{l.name}</strong> won't work until {m.name} is reinstalled.
                  </li>
                ))}
                {lastVideo && (
                  <li>
                    <Icon name="alert" size={12} /> This is your only installed video model — Video mode will be unavailable.
                  </li>
                )}
              </ul>
            </>
          )}
          {nothing && <p className="hint">Nothing to delete: every file is shared with another installed model.</p>}
          {!nothing && (
            <p className="hint">
              Re-installing later downloads {formatBytes(m.totalBytes)} on the {isVideo ? "video" : "Images"} GPU ({pg.costLabel}).
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
