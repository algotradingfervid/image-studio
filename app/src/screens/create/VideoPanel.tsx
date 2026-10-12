// Create screen, Video mode (spec v5): video model, optional start image (i2v), prompt,
// duration / resolution / fps, audio, seed + advanced, Generate → `generate_video`.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { requestModelFocus } from "../models/ModelsScreen";
import * as api from "../../api";
import { isConfigured, isVaultUrl, resolutionId, type Destination, type GenerateVideoInput, type ImageRecord, type ModelView, type VideoDefaults, type VideoResolutionOption } from "../../api";
import { AspectShape, Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { formatUsd, pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import type { Tab } from "../../App";
import {
  Advanced,
  advancedDefaults,
  advBlocker,
  measureImage,
  NOT_AN_IMAGE,
  orientationOf,
  PanelNoticeView,
  ratioLabel,
  readDraft,
  realImageFiles,
  StartImage,
  usePanelNotice,
  useMoreBelow,
  useVaultLockCycle,
  writeDraft,
  type AdvancedValues,
  type RefItem,
} from "./Controls";
import { GalleryPicker } from "./GalleryPicker";
import type { JobView } from "./JobCard";

const LAST_VIDEO_MODEL_KEY = "imagestudio.lastVideoModel";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
/** A second Generate within this long of the last one is ignored (double-click guard; 1.5 s covers a hesitant double tap, UI-078). */
const GENERATE_GUARD_MS = 1500;
/** The same video sent again within this long gets a "Queued again · Undo" notice (UI-078). */
const REPEAT_WINDOW_MS = 4000;
/** The non-vault Video form draft (UX-058): restored after a reload, never holds vault content. */
const DRAFT_KEY = "imagestudio.draft.video";

const MODEL_GLYPH: Record<string, string> = { h3: "H3", ltx25: "LX" };
const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Licence / placement notes shown under the video model picker. */
function modelNotes(m: ModelView): { tone: "warn" | "info"; text: string }[] {
  const notes: { tone: "warn" | "info"; text: string }[] = [];
  if (m.id === "h3") {
    notes.push({ tone: "warn", text: "Runs in Canada — licence excludes EU/UK/KR/US" });
    notes.push({ tone: "info", text: "MiniMax H3 · MiniMax H3 Community licence (commercial use over $20M revenue needs permission)" });
  } else if (m.id === "ltx25") {
    notes.push({ tone: "info", text: "Runs in Canada on the video volume" });
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

/**
 * The model's resolution closest to a w×h frame: same orientation first, then the closest aspect ratio,
 * then the closest pixel count (to `pixels`, default w×h). Null when the model lists no sizes.
 */
function closestResolution(options: VideoResolutionOption[], w: number, h: number, pixels = w * h): string | null {
  const sized = options.map((r) => ({ id: resolutionId(r), sz: resSize(r) })).filter((x): x is { id: string; sz: [number, number] } => !!x.sz);
  if (!sized.length) return null;
  const o = orientationOf(w, h);
  const same = sized.filter((x) => orientationOf(x.sz[0], x.sz[1]) === o);
  const pool = same.length ? same : sized;
  const target = Math.log(w / h);
  pool.sort(
    (a, b) =>
      Math.abs(Math.log(a.sz[0] / a.sz[1]) - target) - Math.abs(Math.log(b.sz[0] / b.sz[1]) - target) ||
      Math.abs(a.sz[0] * a.sz[1] - pixels) - Math.abs(b.sz[0] * b.sz[1] - pixels),
  );
  return pool[0].id;
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
 * `w`/`h` = its size once known; `label` = one line about where it came from.
 */
export interface VideoStart {
  refId: string | null;
  galleryId: string | null;
  vaultId?: string | null;
  thumbPath: string;
  w?: number;
  h?: number;
  label?: string;
}

const fromRef = (r: RefItem, label?: string): VideoStart => ({ refId: r.refId, galleryId: null, thumbPath: r.thumbPath, label });
const fromGallery = (rec: ImageRecord, modelName?: string): VideoStart => {
  const label = `${rec.vault ? "From your vault" : "From gallery"} · ${clip(rec.prompt)}${modelName ? ` · ${modelName}` : ""}`;
  const size = rec.width && rec.height ? { w: rec.width, h: rec.height } : {};
  return rec.vault
    ? { refId: null, galleryId: null, vaultId: rec.id, thumbPath: rec.thumbPath || rec.path, label, ...size }
    : { refId: null, galleryId: rec.id, thumbPath: rec.path, label, ...size };
};
/** The start image is vault content (a vault item, or a reference sealed into the vault). */
export const startIsVault = (s: VideoStart | null) => !!s && (!!s.vaultId || isVaultUrl(s.refId));
const startKey = (s: VideoStart | null) => (s ? (s.vaultId ?? s.galleryId ?? s.refId ?? s.thumbPath) : "");

/** What each video model remembers while you use another one (UX-005; memory only). */
interface VideoMemory {
  form: VideoForm;
  adv: AdvancedValues;
  startImage: VideoStart | null;
  vault: boolean;
}

/** Vault-derived values set aside while the vault is locked (memory only). */
interface VideoStash {
  form: boolean;
  prompt: string;
  modelId: string;
  adv: AdvancedValues;
  startImage: VideoStart | null;
  sourcePrompt: { text: string; vault: boolean } | null;
  tainted: boolean;
  memory: [string, VideoMemory][];
}

export interface VideoPanelHandle {
  /** "Use these settings" for a video record; `galleryStart` = the gallery image its start frame came from, if known. */
  applySettings(rec: ImageRecord, galleryStart?: ImageRecord | null, opts?: { undoMode?: () => void }): Promise<void>;
  /** Lightbox "Make video": this gallery image becomes the start image (an i2v model is selected if needed). */
  startFromImage(rec: ImageRecord, opts?: { undoMode?: () => void }): void;
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
    /** Gallery records, for the GPU-time estimate from past video runs. */
    history?: ImageRecord[];
  }
>(function VideoPanel({ active, hidden, modeSwitch, saveTo, saveToSwitch, onVaultStart, onNavigate, onQueued, activeJobs, modelNames, history = [] }, ref) {
  const lib = useLibrary();
  const vault = useVault();
  const toast = useToast();
  const gpu = useGpu();
  const vgpu = gpu.profiles.video;
  const configured = isConfigured(lib.settings);
  const startsGpu = vgpu.needsStart;
  const models = lib.videoModels;
  const { notice, show: showNotice, clear: clearNotice, hold: holdNotice } = usePanelNotice();

  const draft = useRef(readDraft<{ modelId: string; prompt: string; form: VideoForm; adv: AdvancedValues }>(DRAFT_KEY)).current;
  const [modelId, setModelId] = useState(() => draft?.modelId || readLast());
  const [prompt, setPromptState] = useState(() => (typeof draft?.prompt === "string" ? draft.prompt : ""));
  const [promptError, setPromptError] = useState(false);
  const setPrompt = (p: string) => {
    setPromptState(p);
    if (p.trim()) setPromptError(false);
  };
  const [form, setForm] = useState<VideoForm>(() => formDefaults(undefined));
  const [startImage, setStartImage] = useState<VideoStart | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [adv, setAdv] = useState<AdvancedValues>(() => advancedDefaults(undefined));
  const [advOpen, setAdvOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The prompt of the image picked with "Make video" (offered as a chip while the prompt is empty). */
  const [sourcePrompt, setSourcePrompt] = useState<{ text: string; vault: boolean } | null>(null);
  /** Prompt / seed came from the vault (restored from a vault item, or sent with a vault job). */
  const [tainted, setTainted] = useState(false);
  /** The resolution was picked automatically to match the start image. */
  const [matched, setMatched] = useState<string | null>(null);
  const memory = useRef(new Map<string, VideoMemory>());
  const autoMatchedFor = useRef<string>("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startSectionRef = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const lastSubmit = useRef(0);
  /** The last queued video's settings, to spot an accidental repeat (UI-078). */
  const lastQueued = useRef<{ key: string; at: number } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Report vault start images upward.
  const vaultStart = startIsVault(startImage);
  useEffect(() => onVaultStart(vaultStart), [vaultStart, onVaultStart]);

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
    const fromDraft = draft?.modelId === m.id;
    const d = formDefaults(m);
    const resIds = (m.limits?.resolutions ?? []).map(resolutionId);
    const df = fromDraft ? draft?.form : undefined;
    setForm(
      df
        ? {
            durationS: typeof df.durationS === "number" ? Math.min(m.limits?.maxDurationS ?? 10, Math.max(Math.ceil(m.limits?.minDurationS ?? 1), df.durationS)) : d.durationS,
            fps: df.fps && (m.limits?.fpsOptions ?? []).includes(df.fps) ? df.fps : d.fps,
            resolution: df.resolution && resIds.includes(df.resolution) ? df.resolution : d.resolution,
            audio: !!m.audio && df.audio !== false,
          }
        : d,
    );
    setAdv(fromDraft && draft?.adv ? { ...advancedDefaults(m), ...draft.adv } : advancedDefaults(m));
  }, [models, modelId, draft]);

  useEffect(() => {
    try {
      if (modelId) localStorage.setItem(LAST_VIDEO_MODEL_KEY, modelId);
    } catch {
      /* ignore */
    }
  }, [modelId]);

  // The start image's size: from its record, else measured from the thumbnail.
  useEffect(() => {
    const s = startImage;
    if (!s || s.w) return;
    let alive = true;
    void measureImage(api.fileSrc(s.thumbPath)).then((sz) => {
      if (alive && sz) setStartImage((cur) => (cur === s ? { ...s, w: sz[0], h: sz[1] } : cur));
    });
    return () => {
      alive = false;
    };
  }, [startImage]);

  // Owner decision (UX-010): a new start image picks the closest resolution of the same orientation.
  // Once per start image and model; the user can still change it.
  useEffect(() => {
    if (!startImage?.w || !startImage.h || !model || !i2v) return;
    const key = `${startKey(startImage)}:${model.id}`;
    if (autoMatchedFor.current === key) return;
    autoMatchedFor.current = key;
    const best = closestResolution(model.limits?.resolutions ?? [], startImage.w, startImage.h);
    if (best) {
      setForm((f) => ({ ...f, resolution: best }));
      setMatched(ratioLabel(startImage.w, startImage.h));
    }
  }, [startImage, model, i2v]);
  useEffect(() => {
    if (!startImage) setMatched(null);
  }, [startImage]);

  // Save the draft; anything vault-derived removes it instead (never persisted).
  useEffect(() => {
    if (!initialised.current) return;
    writeDraft(DRAFT_KEY, tainted || startIsVault(startImage) || !!sourcePrompt?.vault ? null : { modelId, prompt, form, adv });
  }, [modelId, prompt, form, adv, tainted, startImage, sourcePrompt]);

  useMoreBelow(scrollRef);

  const currentMemory = (): VideoMemory => ({ form, adv, startImage, vault: tainted || startIsVault(startImage) });

  const selectModel = (id: string) => {
    if (id === modelId) return;
    const next = models.find((m) => m.id === id);
    if (!next) return;
    const cur = model;
    memory.current.set(modelId, currentMemory());
    const mem = memory.current.get(id);
    setModelId(id);
    if (mem) {
      setForm(mem.form);
      setAdv(mem.adv);
      if (mem.vault) setTainted(true);
    } else {
      // Carry the duration over, clamped to the new model's limits.
      const d = formDefaults(next);
      const nMin = Math.max(1, Math.ceil(next.limits?.minDurationS ?? 1));
      const nMax = Math.max(nMin, next.limits?.maxDurationS ?? 10);
      setForm({ ...d, durationS: Math.min(nMax, Math.max(nMin, form.durationS)) });
      setAdv({ ...advancedDefaults(next), seed: adv.seed, randomSeed: adv.randomSeed });
    }
    const takesStart = !!next.modes?.includes("i2v");
    const nextStart = takesStart ? (startImage ?? mem?.startImage ?? null) : null;
    // A remembered form keeps its own resolution choice.
    if (mem && nextStart) autoMatchedFor.current = `${startKey(nextStart)}:${id}`;
    setStartImage(nextStart);
    if (startImage && !takesStart && cur) {
      showNotice({ tone: "info", title: `Kept the start image for ${cur.name}`, detail: `${next.name} only does text → video. Switch back to ${cur.name} to get it back.` });
    } else if (mem) {
      showNotice({ tone: "ok", title: `Restored your ${next.name} settings`, detail: "Duration, resolution, audio, seed and steps as you left them." });
    } else {
      clearNotice();
    }
  };

  // ---------- vault lock: clear every vault-derived value, restore it on unlock (UX-003 / UX-015) ----------
  const { stashNow } = useVaultLockCycle<VideoStash>(
    (submitted) => {
      setPickerOpen(false);
      const isTainted = tainted || submitted;
      const vStart = startIsVault(startImage);
      const vSource = !!sourcePrompt?.vault;
      const formHas = isTainted || vStart || vSource;
      const memVault = [...memory.current].filter(([, m]) => m.vault);
      for (const [k] of memVault) memory.current.delete(k);
      if (notice?.vault || !submitted) clearNotice();
      if (!formHas && !memVault.length) return null;
      const stash: VideoStash = { form: formHas, prompt, modelId, adv, startImage, sourcePrompt, tainted: isTainted, memory: memVault };
      if (formHas) {
        setPrompt("");
        if (isTainted) setAdv({ ...advancedDefaults(model), steps: adv.steps, cfg: adv.cfg });
        if (vStart) setStartImage(null);
        if (vSource) setSourcePrompt(null);
        setTainted(false);
        showNotice(
          submitted
            ? { tone: "info", title: "Sent to the vault — prompt cleared", detail: "The vault is locked, so nothing from this job stays on screen. Unlock to get the prompt back.", sticky: true, vault: true }
            : { tone: "info", title: "Vault locked — vault start image and prompt cleared", detail: "Unlock the vault to restore them.", sticky: true, vault: true },
        );
      }
      return stash;
    },
    (s) => {
      for (const [k, m] of s.memory) if (!memory.current.has(k)) memory.current.set(k, m);
      if (!s.form) return;
      const typedMeanwhile = prompt.trim() !== "";
      if (!typedMeanwhile) setPrompt(s.prompt);
      if (s.modelId === modelId) {
        if (s.tainted) setAdv(s.adv);
        if (!startImage && s.startImage) {
          // Keep the resolution the user had (don't re-match).
          autoMatchedFor.current = `${startKey(s.startImage)}:${modelId}`;
          setStartImage(s.startImage);
        }
      } else {
        memory.current.set(s.modelId, { form, adv: s.adv, startImage: s.startImage, vault: true });
      }
      if (s.sourcePrompt) setSourcePrompt(s.sourcePrompt);
      if (s.tainted || !typedMeanwhile) setTainted(true);
      showNotice({
        tone: "ok",
        title: "Vault unlocked — restored what was cleared",
        detail: typedMeanwhile ? "Kept the prompt you typed while it was locked." : undefined,
        vault: true,
      });
    },
    // Erased vault: drop the "unlock to restore" notice (nothing can come back).
    () => {
      if (notice?.vault) clearNotice();
    },
  );

  // ---------- start image (i2v): same import pipeline as the image start image ----------
  const setStartFrom = async (load: () => Promise<RefItem>, label?: string) => {
    setStartBusy(true);
    try {
      setStartImage(fromRef(await load(), label));
    } catch (e) {
      toast.error("Couldn't add the start image", e);
    } finally {
      setStartBusy(false);
    }
  };
  const addStartFiles = async (picked: File[]) => {
    const files = await realImageFiles(picked);
    const f = files[0];
    if (!f) return showNotice({ tone: "warn", title: NOT_AN_IMAGE });
    if (picked.length > 1) toast.info("Only one start image is used", "The first image was added.");
    await setStartFrom(async () => api.importReferenceBytes(await api.blobToBase64(f), f.type || "image/png", saveTo), `From your computer · ${clip(f.name)}`);
  };
  const addStartPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (!imgs.length) return showNotice({ tone: "warn", title: NOT_AN_IMAGE });
    if (imgs.length > 1) toast.info("Only one start image is used", "The first image was added.");
    await setStartFrom(() => api.importReference(imgs[0], saveTo), `From your computer · ${clip(imgs[0].split(/[\\/]/).pop() ?? "")}`);
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
  const removeStart = () => {
    const prev = startImage;
    const prevRes = form.resolution;
    setStartImage(null);
    if (prev)
      showNotice({
        tone: "info",
        title: "Start image removed",
        undo: () => {
          autoMatchedFor.current = `${startKey(prev)}:${modelId}`;
          setStartImage(prev);
          setForm((f) => ({ ...f, resolution: prevRes }));
        },
        vault: startIsVault(prev),
      });
  };

  const handlers = useRef({ addStartFiles, addStartPaths });
  handlers.current = { addStartFiles, addStartPaths };
  const listen = active && i2v;
  useEffect(() => {
    if (!listen) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
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
    startFromImage(rec: ImageRecord, opts?: { undoMode?: () => void }) {
      const snap = { modelId, form, adv, startImage, sourcePrompt };
      const cur = models.find((x) => x.id === modelId);
      let switchedTo: string | null = null;
      if (!cur?.modes?.includes("i2v")) {
        const capable = models.filter((x) => x.modes?.includes("i2v"));
        const next = capable.find((x) => x.installed) ?? capable[0];
        if (!next) {
          toast.info("No video model takes a start image", "Image → video needs a model with the i2v mode.");
          return;
        }
        memory.current.set(modelId, currentMemory());
        setModelId(next.id);
        setForm(memory.current.get(next.id)?.form ?? formDefaults(next));
        setAdv((a) => ({ ...advancedDefaults(next), seed: a.seed, randomSeed: a.randomSeed }));
        switchedTo = next.name;
      }
      setStartImage(fromGallery(rec, modelNames[rec.model]));
      setSourcePrompt(rec.prompt ? { text: rec.prompt, vault: !!rec.vault } : null);
      const detail = [
        opts?.undoMode ? "Switched to Video" : "",
        switchedTo ? `chose ${switchedTo} (it takes a start image)` : "",
        snap.startImage ? "replaced your earlier start image" : "",
      ]
        .filter(Boolean)
        .join(", ");
      showNotice({
        tone: "ok",
        title: "Start image set",
        detail: detail ? detail.charAt(0).toUpperCase() + detail.slice(1) + "." : undefined,
        undo: () => {
          setModelId(snap.modelId);
          setForm(snap.form);
          setAdv(snap.adv);
          autoMatchedFor.current = snap.startImage ? `${startKey(snap.startImage)}:${snap.modelId}` : "";
          setStartImage(snap.startImage);
          setSourcePrompt(snap.sourcePrompt);
          opts?.undoMode?.();
        },
        vault: !!rec.vault,
      });
      requestAnimationFrame(() => {
        startSectionRef.current?.scrollIntoView({ block: "nearest" });
        promptRef.current?.focus({ preventScroll: true });
      });
    },
    async applySettings(rec: ImageRecord, galleryStart?: ImageRecord | null, opts?: { undoMode?: () => void }) {
      // A vault record's start image re-imports into the vault (its vault:// path always does).
      const dest: Destination = rec.vault ? "vault" : saveTo;
      const m = models.find((x) => x.id === rec.model);
      if (!m) {
        toast.error("That video model is no longer available", rec.model);
        return;
      }
      const snap = { modelId, prompt, form, adv, startImage, tainted };
      const d = formDefaults(m);
      const resOpts = m.limits?.resolutions ?? [];
      const resIds = resOpts.map(resolutionId);
      const fpsOpts = m.limits?.fpsOptions ?? [];
      // UX-012: an unavailable resolution maps to the same orientation and the nearest size, and says so.
      let resolution = d.resolution;
      let resNote = "";
      if (rec.aspectRatio && (resIds.length === 0 || resIds.includes(rec.aspectRatio))) resolution = rec.aspectRatio;
      else if (rec.aspectRatio) {
        const sz = resSize(rec.aspectRatio) ?? (rec.width && rec.height ? ([rec.width, rec.height] as [number, number]) : null);
        const best = sz ? closestResolution(resOpts, sz[0], sz[1]) : null;
        if (best) resolution = best;
        // Say why and what was picked instead (UI-069): the closest size of the same shape.
        resNote = best
          ? `${m.name} no longer offers ${resLabel(rec.aspectRatio)}, so it uses the closest ${sz ? `${orientationOf(sz[0], sz[1])} ` : ""}size, ${resLabel(resolution)}`
          : `${m.name} no longer offers ${resLabel(rec.aspectRatio)}, so it uses its default, ${resLabel(resolution)}`;
      }
      if (m.id !== modelId) memory.current.set(modelId, currentMemory());
      setModelId(m.id);
      setPrompt(rec.prompt);
      setForm({
        durationS: Math.min(m.limits?.maxDurationS ?? 10, Math.max(Math.ceil(m.limits?.minDurationS ?? 1), Math.round(rec.durationS ?? d.durationS ?? 5))),
        fps: rec.fps && (fpsOpts.length === 0 || fpsOpts.includes(rec.fps)) ? rec.fps : d.fps,
        resolution,
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
      if (rec.vault) setTainted(true);
      setSourcePrompt(null);
      scrollRef.current?.scrollTo({ top: 0 });
      let startFailed = false;
      let next: VideoStart | null = null;
      if (rec.initImage && m.modes?.includes("i2v") && galleryStart && galleryStart.kind !== "video") {
        // The start frame was a gallery image: re-select it in place.
        next = fromGallery(galleryStart, modelNames[galleryStart.model]);
      } else if (rec.initImage && m.modes?.includes("i2v")) {
        setStartImage(null);
        setStartBusy(true);
        try {
          next = fromRef(await api.importReference(rec.initImage, dest), `Start image of the ${rec.vault ? "vault video" : "video"} you restored`);
        } catch {
          startFailed = true;
        } finally {
          setStartBusy(false);
        }
      }
      // The source has no start frame: the form's start image goes too, so the form matches the source.
      // The restored resolution wins over auto-matching.
      autoMatchedFor.current = next ? `${startKey(next)}:${m.id}` : "";
      setStartImage(next);
      setMatched(null);
      const parts = [
        opts?.undoMode ? "Switched to Video" : "",
        snap.prompt.trim() && snap.prompt !== rec.prompt ? "Replaced your prompt" : "",
        snap.startImage && !next && !startFailed ? (rec.initImage ? `Removed your start image (${m.name} doesn't take one)` : "Removed your start image (the restored video had none)") : "",
        !m.installed ? `${m.name} isn't installed — install it in Models to generate` : "",
        resNote,
        startFailed ? "The start image couldn't be restored" : "",
      ].filter(Boolean);
      showNotice({
        tone: startFailed || resNote || !m.installed ? "warn" : "ok",
        title: `Settings restored · ${m.name} · seed ${rec.seed}`,
        detail: parts.join(". ") || undefined,
        undo: () => {
          setModelId(snap.modelId);
          setPrompt(snap.prompt);
          setForm(snap.form);
          setAdv(snap.adv);
          autoMatchedFor.current = snap.startImage ? `${startKey(snap.startImage)}:${snap.modelId}` : "";
          setStartImage(snap.startImage);
          setTainted(snap.tainted);
          opts?.undoMode?.();
        },
        vault: !!rec.vault,
      });
      requestAnimationFrame(() => promptRef.current?.focus());
    },
  }));

  // ---------- generate ----------
  const videoGpuStatus = vgpu.state?.status;
  // Every reason Generate can't run, in form order (UI-009): the button is aria-disabled while any is
  // left, the hint lists them all, and a click goes to the first one without starting the GPU.
  const advProblem = advBlocker(adv, model);
  const blockers =
    models.length === 0
      ? ["No video models in this build"]
      : !model
        ? ["Choose a video model"]
        : [
            !configured ? "Connect RunPod in Settings first" : "",
            !model.installed ? `${model.name} isn't installed` : "",
            gpu.podMode && videoGpuStatus === "stopping" ? "The video GPU is stopping — Generate is available again once it has stopped" : "",
            startBusy ? "Adding the start image…" : "",
            !prompt.trim() ? "Write a prompt" : "",
            !form.resolution ? "Choose a resolution" : "",
            advProblem ?? "",
          ].filter(Boolean);
  const blocker = blockers[0] ?? null;

  const doGenerate = async () => {
    // Double-click guard (UX-011): ignore while a submit is in flight and just after one.
    if (submitting || inFlight.current || Date.now() - lastSubmit.current < GENERATE_GUARD_MS) return;
    if (blocker) {
      if (model && !model.installed) {
        formRef.current?.querySelector<HTMLElement>(".model-missing .link-btn")?.focus();
      } else if (!prompt.trim()) {
        setPromptError(true);
        promptRef.current?.focus();
      } else if (advProblem) {
        setAdvOpen(true);
        requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('.advanced [aria-invalid="true"]')?.focus());
      } else toast.info(blocker);
      return;
    }
    if (!model) return;
    inFlight.current = true;
    lastSubmit.current = Date.now();
    try {
      // Owner's rule: confirm before starting a billed GPU. Cancel queues nothing.
      // The model's region / licence restriction is restated in the paid confirmation (UI-054).
      const licence = modelNotes(model).find((n) => n.tone === "warn")?.text;
      if (!(await gpu.confirmStart("generate a video", "video", licence ? { licence } : undefined))) return;
      const input: GenerateVideoInput = {
        model: model.id,
        prompt: prompt.trim(),
        durationS: form.durationS,
        fps: form.fps,
        resolution: form.resolution,
        audio: !!model.audio && form.audio,
      };
      if (model.supportsNegativePrompt && adv.negativePrompt.trim()) input.negativePrompt = adv.negativePrompt.trim();
      if (!adv.randomSeed && adv.seed.trim() !== "") input.seed = Number(adv.seed.trim());
      if (adv.steps.trim() !== "" && Number(adv.steps) > 0) input.steps = Math.round(Number(adv.steps));
      if (adv.cfg.trim() !== "" && !isNaN(Number(adv.cfg))) input.cfg = Number(adv.cfg);
      if (i2v && startImage?.vaultId) input.initImageVaultId = startImage.vaultId;
      else if (i2v && startImage?.galleryId) input.initImageGalleryId = startImage.galleryId;
      else if (i2v && startImage?.refId) input.initImageId = startImage.refId;
      input.destination = saveTo;

      setSubmitting(true);
      try {
        const { jobId } = await api.generateVideo(input);
        // The same settings again within a few seconds: most likely a double tap, so say so with Undo (UI-078).
        const key = JSON.stringify({ ...input, seed: input.seed ?? "random" });
        const prev = lastQueued.current;
        lastQueued.current = { key, at: Date.now() };
        if (prev && prev.key === key && Date.now() - prev.at < REPEAT_WINDOW_MS)
          showNotice({
            tone: "info",
            title: "Queued again — same settings as the video before",
            detail: "Undo cancels this copy; the first video keeps running.",
            undo: () => void api.cancelJob(jobId).catch((e) => toast.error("Couldn't cancel", e)),
            vault: saveTo === "vault",
          });
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
          durationS: input.durationS,
          resolution: input.resolution,
          audio: model.audio ? input.audio : null,
        });
        // A prompt sent to the vault is vault content from now on (cleared on lock; at once while locked).
        if (saveTo === "vault") {
          setTainted(true);
          if (!vault.unlocked) stashNow();
        }
      } catch (e) {
        toast.error("Couldn't start the video", e);
      } finally {
        setSubmitting(false);
      }
    } finally {
      inFlight.current = false;
      lastSubmit.current = Date.now();
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
  const selSize = resSize(form.resolution);
  const startOrient = startImage?.w && startImage.h ? orientationOf(startImage.w, startImage.h) : null;
  const cropWarn =
    i2v && startImage && startOrient && selSize && orientationOf(selSize[0], selSize[1]) !== startOrient
      ? `The start image is ${startOrient}; this video will be cropped to ${ratioLabel(selSize[0], selSize[1])} (${resLabel(form.resolution)}).`
      : null;

  // UX-054: GPU time and cost from past video runs (median time per pixel-frame), scaled to this form.
  const estimate = useMemo(() => {
    if (!selSize || !frames) return null;
    const rates: number[] = [];
    for (const r of history) {
      if (r.kind !== "video" || !r.durationMs || !r.durationS) continue;
      const sz = resSize(r.aspectRatio) ?? (r.width && r.height ? ([r.width, r.height] as [number, number]) : null);
      if (!sz) continue;
      const work = sz[0] * sz[1] * r.durationS * (r.fps ?? 24);
      if (work > 0) rates.push(r.durationMs / work);
    }
    if (!rates.length) return null;
    rates.sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    const ms = median * selSize[0] * selSize[1] * frames;
    const min = ms / 60000;
    return { min, cost: (min / 60) * vgpu.costPerHr, runs: rates.length };
  }, [history, selSize?.[0], selSize?.[1], frames, vgpu.costPerHr]); // eslint-disable-line react-hooks/exhaustive-deps

  const footHint = blocker
    ? `${blockers.join(" · ")}${blockers.length === 1 && blocker === "Write a prompt" ? " to generate" : ""}.`.replace(/(…|\.)\.$/, "$1")
    : activeJobs
      ? `${activeJobs} video${activeJobs === 1 ? "" : "s"} running`
      : startsGpu
        ? `Starts the video GPU in Canada first (${vgpu.startTarget}, ${vgpu.costLabel}; a few minutes). It auto-stops after ${vgpu.idleMinutes} idle min.`
        : `Runs on the video GPU (${vgpu.gpuName}, ${vgpu.costLabel}).`;
  const soundWord = model?.audio && form.audio;

  return (
    <form
      ref={formRef}
      className="panel"
      aria-label="Video settings"
      hidden={hidden}
      onKeyDown={onKeyDown}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void doGenerate();
      }}
    >
      <div className="panel__scroll" ref={scrollRef}>
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
            <div className="notice notice--inline model-missing">
              <Icon name="cube" />
              <span>{model.task ? `${model.name} is downloading to the video volume.` : `${model.name} isn't on the video volume yet.`}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  requestModelFocus(model.id);
                  onNavigate("models");
                }}
              >
                {model.task ? `View ${model.name} progress` : `Install ${model.name} in Models`} →
              </button>
            </div>
          )}
        </section>

        {i2v && (
          <section className="section" aria-labelledby="video-start-title" ref={startSectionRef}>
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
                  : "The video starts from this frame."
              }
              caption={startImage?.label}
              onRemove={removeStart}
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
            className={`input textarea prompt ${promptError ? "is-invalid" : ""}`}
            rows={5}
            placeholder={
              startImage
                ? `Describe the motion — what happens, how the camera moves${soundWord ? ", the sound" : ""}…`
                : `Describe the shot — subject, action, camera move, light${soundWord ? ", sound" : ""}…`
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            aria-invalid={promptError || undefined}
            aria-describedby={promptError ? "video-prompt-err" : undefined}
            spellCheck
          />
          {promptError && (
            <p className="field-error" id="video-prompt-err" role="alert">
              Describe the motion{soundWord ? " and the sound" : ""} first.
            </p>
          )}
          {!prompt.trim() && sourcePrompt && startImage && (
            // The label is its own span so the ellipsis shows (bare text in a flex button only clips, UI-033);
            // the full prompt is the accessible name, not only a mouse tooltip.
            <button
              type="button"
              className="chip chip--word source-prompt"
              onClick={() => setPrompt(sourcePrompt.text)}
              title={sourcePrompt.text}
              aria-label={`Use the image's prompt: ${sourcePrompt.text}`}
            >
              <Icon name="plus" size={11} />
              <span className="source-prompt__label">Use the image's prompt: {sourcePrompt.text}</span>
            </button>
          )}
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
              aria-describedby="video-estimate"
              onChange={(e) => setForm((f) => ({ ...f, durationS: Number(e.target.value) }))}
            />
            <output className="mono duration__value" htmlFor="video-duration">
              {form.durationS} s
            </output>
          </div>
          <div className="strength__ends" aria-hidden>
            <span>{minDur} s</span>
            <span>{maxDur} s</span>
          </div>
          <p id="video-estimate" className={`hint video-estimate ${estimate && estimate.min > 5 ? "video-estimate--long" : ""}`}>
            {estimate
              ? `≈ ${estimate.min < 1 ? "under 1" : Math.round(estimate.min)} min on the GPU · ≈ ${formatUsd(Math.max(0.01, estimate.cost))} at ${vgpu.costLabel} (from ${estimate.runs} past video${estimate.runs === 1 ? "" : "s"}; plus start-up if the GPU is off)`
              : `Longer and larger videos take more GPU time (${vgpu.costLabel}). An estimate appears after your first video.`}
          </p>
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
              onKeyDown={radioKeys(resolutions.map(resolutionId), form.resolution, (r) => {
                setMatched(null);
                setForm((f) => ({ ...f, resolution: r }));
              })}
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
                    onClick={() => {
                      setMatched(null);
                      setForm((f) => ({ ...f, resolution: id }));
                    }}
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
          {cropWarn ? (
            <p className="hint section__note field-warn" role="status">
              <Icon name="alert" size={12} /> {cropWarn}
            </p>
          ) : (
            matched &&
            startImage && (
              <p className="hint section__note" role="status">
                <Icon name="check" size={12} /> Matched to your start image ({matched})
              </p>
            )
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
        <PanelNoticeView notice={notice} onDismiss={clearNotice} onHold={holdNotice} />
        {saveToSwitch}
        {/* Never `disabled` (also not while queuing): after the GPU confirmation focus comes back here (UI-006). */}
        <button type="submit" className={`btn btn--generate ${vault.setupActive ? "is-quiet" : ""}`} aria-disabled={!!blocker || submitting || undefined} aria-describedby="video-gen-hint">
          {/* Blocked: a plain "!" mark instead of the action icon. */}
          <Icon name={blocker ? "alert" : "video"} size={18} />
          <span>{submitting ? "Queuing…" : startsGpu ? "Start GPU & Generate video" : "Generate video"}</span>
          <span className="kbd-group" aria-hidden>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </span>
        </button>
        <p id="video-gen-hint" className={`hint panel__hint ${blocker ? "panel__hint--block" : ""}`}>
          {footHint}
        </p>
      </div>

      <GalleryPicker
        open={pickerOpen}
        preferVault={saveTo === "vault"}
        modelNames={modelNames}
        currentId={startImage?.vaultId ?? startImage?.galleryId ?? undefined}
        returnFocusRef={promptRef}
        onClose={() => setPickerOpen(false)}
        onPick={(rec) => {
          setPickerOpen(false);
          setStartImage(fromGallery(rec, modelNames[rec.model]));
          setSourcePrompt(rec.prompt ? { text: rec.prompt, vault: !!rec.vault } : null);
          // The picker's opener ("From gallery") is replaced by the thumbnail: continue at the prompt (UI-006).
          requestAnimationFrame(() => promptRef.current?.focus());
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
        const biggest = (m.limits?.resolutions ?? [])
          .map(resSize)
          .filter((s): s is [number, number] => !!s)
          .reduce((mx, s) => Math.max(mx, Math.min(s[0], s[1])), 0);
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
                ) : (
                  !m.installed && <span className="badge badge--muted">Not installed</span>
                )}
                {m.modes?.includes("i2v") && <span className="tag">i2v</span>}
                {m.audio && <span className="tag">audio</span>}
                {m.limits?.maxDurationS ? <span className="tag">≤{m.limits.maxDurationS} s</span> : null}
                {biggest >= 1080 ? <span className="tag">1080p</span> : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
