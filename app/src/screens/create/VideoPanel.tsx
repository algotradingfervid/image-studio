// Create screen, Video mode (spec v5): video model, optional start image (i2v), prompt,
// duration / resolution / fps, audio, seed + advanced, Generate → `generate_video`.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import * as api from "../../api";
import { isConfigured, isVaultUrl, resolutionId, type Destination, type GenerateVideoInput, type ImageRecord, type ModelView, type VideoDefaults, type VideoResolutionOption } from "../../api";
import { AspectShape, Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import type { Tab } from "../../App";
import { Advanced, advancedDefaults, StartImage, type AdvancedValues, type RefItem } from "./Controls";
import { GalleryPicker } from "./GalleryPicker";
import type { JobView } from "./JobCard";

const LAST_VIDEO_MODEL_KEY = "imagestudio.lastVideoModel";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;

const MODEL_GLYPH: Record<string, string> = { h3: "H3", ltx25: "LX" };

/** Licence / placement notes shown under the video model picker. */
function modelNotes(m: ModelView): { tone: "warn" | "info"; text: string }[] {
  const notes: { tone: "warn" | "info"; text: string }[] = [];
  if (m.id === "h3") {
    notes.push({ tone: "warn", text: "Runs in Canada — license excludes EU/UK/KR/US" });
    notes.push({ tone: "info", text: "MiniMax H3 · MiniMax H3 Community licence (commercial use over $20M revenue needs permission)" });
  } else if (m.id === "ltx25") {
    notes.push({ tone: "info", text: `${m.name} · LTX-2.x Community licence (free under $10M revenue)` });
  } else {
    notes.push({ tone: "info", text: `${m.name} · ${m.license}` });
  }
  return notes;
}

const vdefaults = (m: ModelView | undefined): VideoDefaults => (m?.defaults ?? {}) as VideoDefaults;

function resSize(r: VideoResolutionOption): [number, number] | null {
  if (typeof r !== "string") return r.width && r.height ? [r.width, r.height] : null;
  const m = r.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function resLabel(r: VideoResolutionOption): string {
  if (typeof r !== "string" && r.label) return r.label;
  const sz = resSize(r);
  return sz ? `${sz[0]}×${sz[1]}` : resolutionId(r);
}

/** "1280x720" → "1280×720" for display; other ids as they are. */
export function resolutionLabel(id: string): string {
  return resLabel(id);
}

interface VideoForm {
  durationS: number;
  fps: number;
  resolution: string;
  audio: boolean;
}

function formDefaults(m: ModelView | undefined): VideoForm {
  const d = vdefaults(m);
  const lim = m?.limits;
  const resIds = (lim?.resolutions ?? []).map(resolutionId);
  const fpsOpts = lim?.fpsOptions ?? [];
  const max = lim?.maxDurationS ?? 10;
  const min = Math.ceil(lim?.minDurationS ?? 1);
  return {
    durationS: Math.min(max, Math.max(min, Math.round(d.durationS ?? 5))),
    fps: d.fps && (fpsOpts.length === 0 || fpsOpts.includes(d.fps)) ? d.fps : (fpsOpts[0] ?? 24),
    resolution: d.resolution && (resIds.length === 0 || resIds.includes(d.resolution)) ? d.resolution : (resIds[0] ?? ""),
    audio: !!m?.audio,
  };
}

function readLast(): string {
  try {
    return localStorage.getItem(LAST_VIDEO_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The i2v start image: imported (`refId` → initImageId), a gallery image used in place
 * (`galleryId` → initImageGalleryId) or a vault item used in place (`vaultId` → initImageVaultId, spec v6).
 */
export interface VideoStart {
  refId: string | null;
  galleryId: string | null;
  vaultId?: string | null;
  thumbPath: string;
}

const fromRef = (r: RefItem): VideoStart => ({ refId: r.refId, galleryId: null, thumbPath: r.thumbPath });
const fromGallery = (rec: ImageRecord): VideoStart =>
  rec.vault ? { refId: null, galleryId: null, vaultId: rec.id, thumbPath: rec.thumbPath || rec.path } : { refId: null, galleryId: rec.id, thumbPath: rec.path };
/** The start image is vault content (a vault item, or a reference sealed into the vault). */
export const startIsVault = (s: VideoStart | null) => !!s && (!!s.vaultId || isVaultUrl(s.refId));

export interface VideoPanelHandle {
  /** "Use these settings" for a video record; `galleryStart` = the gallery image its start frame came from, if known. */
  applySettings(rec: ImageRecord, galleryStart?: ImageRecord | null): Promise<void>;
  /** Lightbox "Make video": this gallery image becomes the start image (an i2v model is selected if needed). */
  startFromImage(rec: ImageRecord): void;
}

export const VideoPanel = forwardRef<
  VideoPanelHandle,
  {
    /** The Create screen is visible and in Video mode (paste/drop go to the start image). */
    active: boolean;
    hidden: boolean;
    modeSwitch: ReactNode;
    /** Where outputs go (spec v6) and the shared Save-to switch. */
    saveTo: Destination;
    saveToSwitch: ReactNode;
    /** Reports whether the start image is vault content (forces Save to = Vault). */
    onVaultStart: (vault: boolean) => void;
    onNavigate: (t: Tab) => void;
    onQueued: (job: JobView) => void;
    activeJobs: number;
    modelNames: Record<string, string>;
  }
>(function VideoPanel({ active, hidden, modeSwitch, saveTo, saveToSwitch, onVaultStart, onNavigate, onQueued, activeJobs, modelNames }, ref) {
  const lib = useLibrary();
  const vault = useVault();
  const toast = useToast();
  const gpu = useGpu();
  const vgpu = gpu.profiles.video;
  const configured = isConfigured(lib.settings);
  const startsGpu = gpu.podMode && api.gpuIsOff(vgpu.state);
  const models = lib.videoModels;

  const [modelId, setModelId] = useState(readLast);
  const [prompt, setPrompt] = useState("");
  const [form, setForm] = useState<VideoForm>(() => formDefaults(undefined));
  const [startImage, setStartImage] = useState<VideoStart | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [adv, setAdv] = useState<AdvancedValues>(() => advancedDefaults(undefined));
  const [advOpen, setAdvOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Report vault start images upward; drop them when the vault locks.
  const vaultStart = startIsVault(startImage);
  useEffect(() => onVaultStart(vaultStart), [vaultStart, onVaultStart]);
  const lockEpoch = useRef(vault.lockEpoch);
  useEffect(() => {
    if (lockEpoch.current === vault.lockEpoch) return;
    lockEpoch.current = vault.lockEpoch;
    setPickerOpen(false);
    setStartImage((s) => (startIsVault(s) ? null : s));
  }, [vault.lockEpoch]);

  const model = models.find((m) => m.id === modelId);
  const i2v = !!model?.modes?.includes("i2v");
  const lim = model?.limits;
  const minDur = Math.max(1, Math.ceil(lim?.minDurationS ?? 1));
  const maxDur = Math.max(minDur, lim?.maxDurationS ?? 10);

  // Pick an initial model once the registry arrives.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || models.length === 0) return;
    initialised.current = true;
    const m = models.find((x) => x.id === modelId) ?? models.find((x) => x.installed) ?? models[0];
    setModelId(m.id);
    setForm(formDefaults(m));
    setAdv(advancedDefaults(m));
  }, [models, modelId]);

  useEffect(() => {
    try {
      if (modelId) localStorage.setItem(LAST_VIDEO_MODEL_KEY, modelId);
    } catch {
      /* ignore */
    }
  }, [modelId]);

  const selectModel = (id: string) => {
    if (id === modelId) return;
    const next = models.find((m) => m.id === id);
    if (!next) return;
    setModelId(id);
    setForm(formDefaults(next));
    setAdv((a) => ({ ...advancedDefaults(next), seed: a.seed, randomSeed: a.randomSeed }));
    if (startImage && !next.modes?.includes("i2v")) {
      setStartImage(null);
      toast.info("Removed the start image", `${next.name} only does text → video.`);
    }
  };

  // ---------- start image (i2v): same import pipeline as the image start image ----------
  const setStartFrom = async (load: () => Promise<RefItem>) => {
    setStartBusy(true);
    try {
      setStartImage(fromRef(await load()));
    } catch (e) {
      toast.error("Couldn't add the start image", e);
    } finally {
      setStartBusy(false);
    }
  };
  const addStartFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (files.length > 1) toast.info("Only one start image is used", "The first image was added.");
    await setStartFrom(async () => api.importReferenceBytes(await api.blobToBase64(f), f.type || "image/png", saveTo));
  };
  const addStartPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (!imgs.length) return toast.info("That isn't an image file", "The start image must be a PNG, JPEG, WebP or similar.");
    if (imgs.length > 1) toast.info("Only one start image is used", "The first image was added.");
    await setStartFrom(() => api.importReference(imgs[0], saveTo));
  };
  const pickStart = async () => {
    try {
      const paths = await api.pickImagePaths();
      if (paths === null) fileInput.current?.click();
      else if (paths.length) await addStartPaths(paths.slice(0, 1));
    } catch (e) {
      toast.error("Couldn't open the file picker", e);
    }
  };

  const handlers = useRef({ addStartFiles, addStartPaths });
  handlers.current = { addStartFiles, addStartPaths };
  const listen = active && i2v;
  useEffect(() => {
    if (!listen) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void handlers.current.addStartFiles(files);
    };
    document.addEventListener("paste", onPaste);
    let un: (() => void) | undefined;
    let dead = false;
    void api
      .onFileDrop((e) => {
        if (e.type === "enter") setDragActive(true);
        else if (e.type === "leave") setDragActive(false);
        else {
          setDragActive(false);
          void handlers.current.addStartPaths(e.paths);
        }
      })
      .then((f) => (dead ? f() : (un = f)));
    return () => {
      dead = true;
      document.removeEventListener("paste", onPaste);
      un?.();
    };
  }, [listen]);

  // ---------- restore ("Use these settings") / "Make video" ----------
  useImperativeHandle(ref, () => ({
    startFromImage(rec: ImageRecord) {
      const cur = models.find((x) => x.id === modelId);
      if (!cur?.modes?.includes("i2v")) {
        const capable = models.filter((x) => x.modes?.includes("i2v"));
        const next = capable.find((x) => x.installed) ?? capable[0];
        if (!next) {
          toast.info("No video model takes a start image", "Image → video needs a model with the i2v mode.");
          return;
        }
        setModelId(next.id);
        setForm(formDefaults(next));
        setAdv((a) => ({ ...advancedDefaults(next), seed: a.seed, randomSeed: a.randomSeed }));
      }
      setStartImage(fromGallery(rec));
      requestAnimationFrame(() => promptRef.current?.focus());
    },
    async applySettings(rec: ImageRecord, galleryStart?: ImageRecord | null) {
      // A vault record's start image re-imports into the vault (its vault:// path always does).
      const dest: Destination = rec.vault ? "vault" : saveTo;
      const m = models.find((x) => x.id === rec.model);
      if (!m) {
        toast.error("That video model is no longer available", rec.model);
        return;
      }
      const d = formDefaults(m);
      const resIds = (m.limits?.resolutions ?? []).map(resolutionId);
      const fpsOpts = m.limits?.fpsOptions ?? [];
      setModelId(m.id);
      setPrompt(rec.prompt);
      setForm({
        durationS: Math.min(
          m.limits?.maxDurationS ?? 10,
          Math.max(Math.ceil(m.limits?.minDurationS ?? 1), Math.round(rec.durationS ?? d.durationS ?? 5)),
        ),
        fps: rec.fps && (fpsOpts.length === 0 || fpsOpts.includes(rec.fps)) ? rec.fps : d.fps,
        resolution: rec.aspectRatio && (resIds.length === 0 || resIds.includes(rec.aspectRatio)) ? rec.aspectRatio : d.resolution,
        audio: !!m.audio && (rec.hasAudio ?? true),
      });
      setAdv({
        seed: String(rec.seed),
        randomSeed: false,
        steps: String(rec.steps),
        cfg: String(rec.cfg),
        negativePrompt: m.supportsNegativePrompt ? rec.negativePrompt : "",
      });
      setAdvOpen(true);
      setStartImage(null);
      let startFailed = false;
      if (rec.initImage && m.modes?.includes("i2v") && galleryStart && galleryStart.kind !== "video") {
        // The start frame was a gallery image: re-select it in place.
        setStartImage(fromGallery(galleryStart));
      } else if (rec.initImage && m.modes?.includes("i2v")) {
        setStartBusy(true);
        try {
          setStartImage(fromRef(await api.importReference(rec.initImage, dest)));
        } catch {
          startFailed = true;
        } finally {
          setStartBusy(false);
        }
      }
      if (startFailed) toast.info("Settings restored, with gaps", "The start image couldn't be restored");
      else toast.success("Settings restored", `${m.name} · seed ${rec.seed}`);
      requestAnimationFrame(() => promptRef.current?.focus());
    },
  }));

  // ---------- generate ----------
  const blocker =
    models.length === 0
      ? "No video models in this build"
      : !model
        ? "Choose a video model"
        : !configured
          ? "Connect RunPod in Settings first"
          : !model.installed
            ? `${model.name} isn't installed`
            : !prompt.trim()
              ? "Write a prompt"
              : startBusy
                ? "Adding the start image…"
                : !form.resolution
                  ? "Choose a resolution"
                  : null;

  const doGenerate = async () => {
    if (submitting) return;
    if (blocker) {
      if (blocker === "Write a prompt") promptRef.current?.focus();
      else toast.info(blocker);
      return;
    }
    if (!model) return;
    const input: GenerateVideoInput = {
      model: model.id,
      prompt: prompt.trim(),
      durationS: form.durationS,
      fps: form.fps,
      resolution: form.resolution,
      audio: !!model.audio && form.audio,
    };
    if (model.supportsNegativePrompt && adv.negativePrompt.trim()) input.negativePrompt = adv.negativePrompt.trim();
    if (!adv.randomSeed && adv.seed !== "") input.seed = Number(adv.seed);
    if (adv.steps !== "" && Number(adv.steps) > 0) input.steps = Math.round(Number(adv.steps));
    if (adv.cfg !== "" && !isNaN(Number(adv.cfg))) input.cfg = Number(adv.cfg);
    if (i2v && startImage?.vaultId) input.initImageVaultId = startImage.vaultId;
    else if (i2v && startImage?.galleryId) input.initImageGalleryId = startImage.galleryId;
    else if (i2v && startImage?.refId) input.initImageId = startImage.refId;
    input.destination = saveTo;

    setSubmitting(true);
    try {
      const { jobId } = await api.generateVideo(input);
      onQueued({
        jobId,
        kind: "video",
        status: "queued",
        total: 1,
        completed: 0,
        progress: null,
        images: [],
        error: null,
        startedAt: Date.now(),
        modelName: model.name,
        prompt: input.prompt,
        destination: saveTo,
      });
    } catch (e) {
      toast.error("Couldn't start the video", e);
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doGenerate();
    }
  };

  const resolutions = lim?.resolutions ?? [];
  const fpsOptions = lim?.fpsOptions ?? [];
  const frames = form.durationS * form.fps;

  return (
    <form
      className="panel"
      aria-label="Video settings"
      hidden={hidden}
      onKeyDown={onKeyDown}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void doGenerate();
      }}
    >
      <div className="panel__scroll">
        {modeSwitch}

        <section className="section">
          <h2 className="section__title">Video model</h2>
          {!lib.loaded ? (
            <div className="skeleton skeleton--cards" aria-label="Loading models" />
          ) : models.length === 0 ? (
            <div className="notice notice--inline video-empty">
              <Icon name="video" />
              <span>No video models in this build. They appear here once the model registry lists them.</span>
            </div>
          ) : (
            <VideoModelPicker models={models} value={modelId} onChange={selectModel} />
          )}
          {model && (
            <ul className="plain model-notes" aria-label={`${model.name} licence notes`}>
              {modelNotes(model).map((n) => (
                <li key={n.text} className={`model-note model-note--${n.tone}`}>
                  <Icon name={n.tone === "warn" ? "globe" : "info"} size={13} />
                  <span>{n.text}</span>
                </li>
              ))}
            </ul>
          )}
          {model && !model.installed && (
            <div className="notice notice--inline">
              <Icon name="cube" />
              <span>{model.task ? `${model.name} is downloading to the video volume.` : `${model.name} isn't on the video volume yet.`}</span>
              <button type="button" className="link-btn" onClick={() => onNavigate("models")}>
                {model.task ? "View progress" : "Install in Models"} →
              </button>
            </div>
          )}
        </section>

        {i2v && (
          <section className="section" aria-labelledby="video-start-title">
            <div className="section__head">
              <h2 className="section__title" id="video-start-title">
                Start image <span className="section__aside">(optional) — makes it image → video</span>
              </h2>
            </div>
            <StartImage
              image={startImage}
              busy={startBusy}
              dragActive={dragActive}
              note={
                startImage?.vaultId
                  ? "From your vault — the video starts from this frame and is saved to the vault."
                  : startImage?.galleryId
                    ? "From your gallery — the video starts from this frame."
                    : "The video starts from this frame."
              }
              onRemove={() => setStartImage(null)}
              onFiles={addStartFiles}
              onPick={pickStart}
              onPickGallery={() => setPickerOpen(true)}
            />
          </section>
        )}

        <section className="section">
          <div className="section__head">
            <label className="section__title" htmlFor="video-prompt">
              Prompt
            </label>
            <span className="hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> to generate
            </span>
          </div>
          <textarea
            id="video-prompt"
            ref={promptRef}
            className="input textarea prompt"
            rows={5}
            placeholder={startImage ? "Describe the motion — what happens, how the camera moves, the sound…" : "Describe the shot — subject, action, camera move, light, sound…"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck
          />
        </section>

        <section className="section">
          <div className="section__head">
            <label className="section__title" htmlFor="video-duration">
              Duration
            </label>
            <span className="hint mono">{frames > 0 ? `${frames} frames` : ""}</span>
          </div>
          <div className="duration">
            <input
              id="video-duration"
              type="range"
              min={minDur}
              max={maxDur}
              step={1}
              value={form.durationS}
              disabled={!model}
              aria-valuetext={`${form.durationS} seconds`}
              onChange={(e) => setForm((f) => ({ ...f, durationS: Number(e.target.value) }))}
            />
            <output className="mono duration__value" htmlFor="video-duration">
              {form.durationS} s
            </output>
          </div>
          <div className="strength__ends" aria-hidden>
            <span>1 s</span>
            <span>{maxDur} s max</span>
          </div>
        </section>

        <section className="section">
          <h2 className="section__title" id="video-res-title">
            Resolution
          </h2>
          {resolutions.length ? (
            <div
              className="chips"
              role="radiogroup"
              aria-labelledby="video-res-title"
              onKeyDown={radioKeys(resolutions.map(resolutionId), form.resolution, (r) => setForm((f) => ({ ...f, resolution: r })))}
            >
              {resolutions.map((r) => {
                const id = resolutionId(r);
                const sz = resSize(r);
                const on = id === form.resolution;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    className={`chip chip--aspect ${on ? "is-selected" : ""}`}
                    onClick={() => setForm((f) => ({ ...f, resolution: id }))}
                  >
                    {sz && <AspectShape w={sz[0]} h={sz[1]} />}
                    {resLabel(r)}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="hint">{model ? "This model doesn't list resolutions." : "Choose a model first."}</p>
          )}
        </section>

        <section className="section section--row">
          <h2 className="section__title" id="video-fps-title">
            Frame rate
          </h2>
          {fpsOptions.length > 0 && (
            <div
              className="segmented segmented--wide"
              role="radiogroup"
              aria-labelledby="video-fps-title"
              onKeyDown={radioKeys(fpsOptions, form.fps, (n) => setForm((f) => ({ ...f, fps: n })))}
            >
              {fpsOptions.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === form.fps}
                  tabIndex={n === form.fps ? 0 : -1}
                  className={n === form.fps ? "is-selected" : ""}
                  onClick={() => setForm((f) => ({ ...f, fps: n }))}
                >
                  {n} fps
                </button>
              ))}
            </div>
          )}
        </section>

        {model?.audio && (
          <section className="section section--row">
            <h2 className="section__title" id="video-audio-title">
              Audio
            </h2>
            <label className="switch">
              <input
                type="checkbox"
                checked={form.audio}
                aria-labelledby="video-audio-title"
                aria-describedby="video-audio-hint"
                onChange={(e) => setForm((f) => ({ ...f, audio: e.target.checked }))}
              />
              <span className="switch__track" aria-hidden />
              <span id="video-audio-hint">{form.audio ? "Sound and speech from the prompt" : "Silent video"}</span>
            </label>
          </section>
        )}

        <Advanced model={model} values={adv} onChange={setAdv} open={advOpen} onToggle={() => setAdvOpen((o) => !o)} />
      </div>

      <div className="panel__foot">
        {saveToSwitch}
        <button
          type="submit"
          className="btn btn--generate"
          disabled={submitting || (!!blocker && blocker !== "Write a prompt")}
          aria-describedby="video-gen-hint"
        >
          <Icon name="video" size={18} />
          <span>{submitting ? "Queuing…" : startsGpu ? "Start GPU & Generate video" : "Generate video"}</span>
          <span className="kbd-group" aria-hidden>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </span>
        </button>
        <p id="video-gen-hint" className="hint panel__hint">
          {blocker && blocker !== "Write a prompt"
            ? blocker
            : activeJobs
              ? `${activeJobs} video${activeJobs === 1 ? "" : "s"} running`
              : startsGpu
                ? `Starts the video GPU in Canada first (${vgpu.startTarget}, ${vgpu.costLabel}; a few minutes). It auto-stops after ${vgpu.idleMinutes} idle min.`
                : `Runs on the video GPU (${vgpu.gpuName}).`}
        </p>
      </div>

      <GalleryPicker
        open={pickerOpen}
        preferVault={saveTo === "vault"}
        modelNames={modelNames}
        onClose={() => setPickerOpen(false)}
        onPick={(rec) => {
          setPickerOpen(false);
          setStartImage(fromGallery(rec));
        }}
      />

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addStartFiles(files);
        }}
      />
    </form>
  );
});

function VideoModelPicker({ models, value, onChange }: { models: ModelView[]; value: string; onChange: (id: string) => void }) {
  return (
    <div
      className="model-grid"
      role="radiogroup"
      aria-label="Video model"
      onKeyDown={radioKeys(
        models.map((m) => m.id),
        value,
        onChange,
      )}
    >
      {models.map((m) => {
        const selected = m.id === value;
        const task = api.isTaskActive(m.task) ? m.task : null;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!value && m === models[0]) ? 0 : -1}
            className={`model-card ${selected ? "is-selected" : ""} ${m.installed ? "" : "is-missing"}`}
            onClick={() => onChange(m.id)}
            title={`${m.name} · ${m.license}`}
          >
            <span className="model-card__glyph" aria-hidden>
              {MODEL_GLYPH[m.id] ?? m.name.slice(0, 2)}
            </span>
            <span className="model-card__text">
              <span className="model-card__name">{m.name}</span>
              <span className="model-card__meta">
                {task ? (
                  <span className="badge badge--accent">Downloading {Math.round(pct(task.bytes, task.totalBytes))}%</span>
                ) : m.installed ? (
                  <>
                    {m.modes?.includes("i2v") && <span className="tag">i2v</span>}
                    {m.audio && <span className="tag">audio</span>}
                    {m.limits?.maxDurationS ? <span className="tag">≤{m.limits.maxDurationS} s</span> : null}
                  </>
                ) : (
                  <span className="badge badge--muted">Not installed</span>
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
