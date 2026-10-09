import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import * as api from "../../api";
import {
  DENOISE_DEFAULT,
  DENOISE_MAX,
  DENOISE_MIN,
  gpuIsOff,
  isConfigured,
  isJobActive,
  isVaultUrl,
  type Destination,
  type GenerateInput,
  type ImageRecord,
  type Job,
} from "../../api";
import { Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import type { Tab } from "../../App";
import {
  Advanced,
  advancedDefaults,
  AspectPicker,
  CountPicker,
  LoraPicker,
  MAX_LORAS,
  ModelPicker,
  ModeSwitch,
  References,
  StartImage,
  type AdvancedValues,
  type CreateMode,
  type LoraPick,
  type RefItem,
} from "./Controls";
import { Gallery } from "./Gallery";
import { GalleryPicker } from "./GalleryPicker";
import { JobCard, type JobView } from "./JobCard";
import { Lightbox } from "./Lightbox";
import { VideoPanel, type VideoPanelHandle } from "./VideoPanel";
import { MigrationView, SaveToSwitch, VaultCreate, VaultLockScreen } from "./VaultViews";

const PAGE = 24;
const LAST_MODEL_KEY = "imagestudio.lastModel";
const MODE_KEY = "imagestudio.createMode";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;

function readLastModel(): string {
  try {
    return localStorage.getItem(LAST_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function readMode(): CreateMode {
  try {
    return localStorage.getItem(MODE_KEY) === "video" ? "video" : "image";
  } catch {
    return "image";
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export type GalleryFilter = "all" | "image" | "video";
export type GalleryTab = "general" | "vault";
const isVideo = (im: ImageRecord) => im.kind === "video";
const applyFilter = (list: ImageRecord[], f: GalleryFilter) => (f === "all" ? list : list.filter((im) => (f === "video") === isVideo(im)));

/** img2img start image: imported (`refId`) or a vault item used in place (`vaultId`, spec v6). */
type StartPick = RefItem & { vaultId?: string };

export function CreateScreen({ active, onNavigate }: { active: boolean; onNavigate: (t: Tab) => void }) {
  const lib = useLibrary();
  const toast = useToast();
  const configured = isConfigured(lib.settings);
  const gpu = useGpu();
  const vault = useVault();
  // Pod backend with the GPU off: Generate auto-starts it first.
  const startsGpu = gpu.podMode && gpuIsOff(gpu.state);
  const imageModels = lib.imageModels;

  // ---------- Image | Video ----------
  const [mode, setModeState] = useState<CreateMode>(readMode);
  const setMode = useCallback((m: CreateMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);
  const videoRef = useRef<VideoPanelHandle>(null);
  const modeSwitch = <ModeSwitch value={mode} onChange={setMode} />;

  // ---------- Save to: General | Vault (spec v6; remembered for the session) ----------
  const [saveChoice, setSaveChoice] = useState<Destination | null>(null);
  /** Video mode's start image is vault content (reported by VideoPanel). */
  const [videoVaultStart, setVideoVaultStart] = useState(false);

  // ---------- form state ----------
  const [modelId, setModelId] = useState<string>(readLastModel);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [refBusy, setRefBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [loraPicks, setLoraPicks] = useState<LoraPick[]>([]);
  // img2img start image (models with supportsImg2Img) and its strength.
  const [startImage, setStartImage] = useState<StartPick | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [denoise, setDenoise] = useState(DENOISE_DEFAULT);
  const [aspect, setAspect] = useState("1:1");
  const [count, setCount] = useState(1);
  const [adv, setAdv] = useState<AdvancedValues>(() => advancedDefaults(undefined));
  const [advOpen, setAdvOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const startFileInput = useRef<HTMLInputElement>(null);

  const model = imageModels.find((m) => m.id === modelId);
  const maxRefs = model?.maxReferences ?? 0;
  const img2img = !!model?.supportsImg2Img;
  const startActive = img2img && !!startImage;

  // A vault start image or reference keeps the output in the vault (the core refuses "general").
  const vaultInputs =
    mode === "video"
      ? videoVaultStart
      : (startActive && !!startImage && (!!startImage.vaultId || isVaultUrl(startImage.refId))) || refs.slice(0, maxRefs).some((r) => isVaultUrl(r.refId));
  // Until the user picks: Vault while unlocked, else General. Vault while locked is allowed (outputs are sealed).
  const saveTo: Destination = !vault.exists ? "general" : vaultInputs ? "vault" : (saveChoice ?? (vault.unlocked ? "vault" : "general"));
  const saveToSwitch = (
    <SaveToSwitch
      value={saveTo}
      onChange={setSaveChoice}
      forcedReason={vaultInputs ? "The start image or a reference comes from the vault, so the output stays in the vault." : null}
      onCreateVault={() => {
        setGalleryTabState("vault");
        setLightboxId(null);
      }}
    />
  );
  const modelNames = useMemo(() => Object.fromEntries(lib.models.map((m) => [m.id, m.name])), [lib.models]);

  // Pick an initial model once the registry arrives.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || imageModels.length === 0) return;
    initialised.current = true;
    const m = imageModels.find((x) => x.id === modelId) ?? imageModels.find((x) => x.installed) ?? imageModels[0];
    setModelId(m.id);
    setAdv(advancedDefaults(m));
  }, [imageModels, modelId]);

  useEffect(() => {
    try {
      if (modelId) localStorage.setItem(LAST_MODEL_KEY, modelId);
    } catch {
      /* ignore */
    }
  }, [modelId]);

  // Drop LoRAs that disappeared from the library (deleted in Models).
  useEffect(() => {
    setLoraPicks((ps) => {
      const keep = ps.filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present));
      return keep.length === ps.length ? ps : keep;
    });
  }, [lib.loras]);

  const selectModel = (id: string) => {
    if (id === modelId) return;
    const next = imageModels.find((m) => m.id === id);
    if (!next) return;
    const droppedRefs = Math.max(0, refs.length - next.maxReferences);
    const keptLoras = loraPicks.filter((p) => lib.loras.find((l) => l.id === p.loraId)?.modelId === id);
    const droppedLoras = loraPicks.length - keptLoras.length;
    const droppedStart = !!startImage && !next.supportsImg2Img;
    setModelId(id);
    setAdv(advancedDefaults(next));
    if (droppedRefs) setRefs((r) => r.slice(0, next.maxReferences));
    if (droppedLoras) setLoraPicks(keptLoras);
    if (droppedStart) setStartImage(null);
    if (droppedRefs || droppedLoras) {
      const parts = [
        droppedRefs && plural(droppedRefs, "reference"),
        droppedLoras && plural(droppedLoras, "LoRA"),
        droppedStart && "the start image",
      ].filter(Boolean);
      toast.info(`Removed ${parts.join(" and ")}`, `${next.name} doesn't support ${droppedRefs && !next.maxReferences ? "reference images" : "them"}.`);
    } else if (droppedStart) {
      toast.info("Removed the start image", `${next.name} doesn't support start images (img2img).`);
    }
  };

  // ---------- references ----------
  const addFiles = async (files: File[]) => {
    const slots = maxRefs - refs.length;
    if (slots <= 0) return toast.info(`${model?.name} takes at most ${maxRefs} references`);
    if (files.length > slots) toast.info(`Only ${plural(slots, "more reference")} allowed`, `${model?.name} takes at most ${maxRefs}.`);
    setRefBusy(true);
    try {
      for (const f of files.slice(0, slots)) {
        const b64 = await api.blobToBase64(f);
        const r = await api.importReferenceBytes(b64, f.type || "image/png", saveTo);
        setRefs((rs) => [...rs, r]);
      }
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setRefBusy(false);
    }
  };

  const addPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (imgs.length < paths.length) toast.info("Some files were skipped", "Only image files can be references.");
    const slots = maxRefs - refs.length;
    if (!imgs.length) return;
    if (slots <= 0) return toast.info(`${model?.name} takes at most ${maxRefs} references`);
    if (imgs.length > slots) toast.info(`Only ${plural(slots, "more reference")} allowed`, `${model?.name} takes at most ${maxRefs}.`);
    setRefBusy(true);
    try {
      for (const p of imgs.slice(0, slots)) {
        const r = await api.importReference(p, saveTo);
        setRefs((rs) => [...rs, r]);
      }
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setRefBusy(false);
    }
  };

  const pickRefs = async () => {
    try {
      const paths = await api.pickImagePaths();
      if (paths === null) fileInput.current?.click();
      else if (paths.length) await addPaths(paths);
    } catch (e) {
      toast.error("Couldn't open the file picker", e);
    }
  };

  // ---------- start image (img2img) ----------
  // Same import pipeline as references (downscaled to ≤1 MP); one image, replaced on re-add.
  const setStartFrom = async (load: () => Promise<StartPick>) => {
    setStartBusy(true);
    try {
      setStartImage(await load());
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
      if (paths === null) startFileInput.current?.click();
      else if (paths.length) await addStartPaths(paths.slice(0, 1));
    } catch (e) {
      toast.error("Couldn't open the file picker", e);
    }
  };

  // Latest handlers for long-lived listeners. Pasted/dropped images go to the
  // references when the model takes them, else to the start image.
  const toStart = maxRefs === 0 && img2img;
  const onPastedFiles = toStart ? addStartFiles : addFiles;
  const onDroppedPaths = toStart ? addStartPaths : addPaths;
  const handlers = useRef({ onPastedFiles, onDroppedPaths });
  handlers.current = { onPastedFiles, onDroppedPaths };
  const refsEnabled = active && mode === "image" && (maxRefs > 0 || img2img);

  useEffect(() => {
    if (!refsEnabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void handlers.current.onPastedFiles(files);
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
          void handlers.current.onDroppedPaths(e.paths);
        }
      })
      .then((f) => (dead ? f() : (un = f)));
    return () => {
      dead = true;
      document.removeEventListener("paste", onPaste);
      un?.();
    };
  }, [refsEnabled]);

  // ---------- prompt helpers ----------
  const insertWord = (w: string) => {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const pre = before && !/[\s,]$/.test(before) ? ", " : before && !/\s$/.test(before) ? " " : "";
    const post = after && !/^[\s,]/.test(after) ? ", " : "";
    const next = before + pre + w + post + after;
    setPrompt(next);
    const caret = (before + pre + w).length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  // ---------- jobs ----------
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingImages, setLoadingImages] = useState(false);
  const loadingRef = useRef(false);
  /** The open lightbox item, by id (the list it belongs to is the visible gallery tab). */
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  const imagesRef = useRef(images);
  imagesRef.current = images;
  const unlockedRef = useRef(vault.unlocked);
  unlockedRef.current = vault.unlocked;
  const addVaultLocal = vault.addLocal;

  const prependImages = useCallback((recs: ImageRecord[]) => {
    // Vault outputs never enter the General list.
    const fresh = recs.filter((r) => !r.vault && !imagesRef.current.some((p) => p.id === r.id));
    if (!fresh.length) return;
    imagesRef.current = [...fresh.reverse(), ...imagesRef.current];
    setImages(imagesRef.current);
  }, []);

  useEffect(() => {
    const un = api.onEvent("job-update", (job: Job) => {
      // A vault job while locked: keep no prompt or outputs in memory.
      const sealed = (job.destination === "vault" || job.images.some((r) => r.vault)) && !unlockedRef.current;
      const payload: Job = sealed ? { ...job, images: [] } : job;
      setJobs((js) => {
        const ex = js.find((j) => j.jobId === job.jobId);
        if (!ex) return [...js, { ...payload, modelName: "", prompt: "", startedAt: Date.now() }];
        return js.map((j) => (j.jobId === job.jobId ? { ...j, ...payload, ...(sealed ? { prompt: "" } : {}) } : j));
      });
      if (payload.images.length) {
        prependImages(payload.images);
        addVaultLocal(payload.images.filter((r) => r.vault));
      }
      if (job.status === "failed") toast.error("Generation failed", job.error ?? undefined);
    });
    return () => void un.then((f) => f());
  }, [prependImages, addVaultLocal, toast]);

  // Restore cards for jobs that were already running (e.g. after a reload).
  useEffect(() => {
    let alive = true;
    api
      .listJobs()
      .then((active) => {
        if (!alive || !active.length) return;
        setJobs((js) => {
          const known = new Set(js.map((j) => j.jobId));
          const restored = active
            .filter((j) => !known.has(j.jobId))
            .map((j) => ({ ...j, modelName: "Earlier job", prompt: "", startedAt: Date.now() }));
          return [...js, ...restored];
        });
      })
      .catch(() => {
        /* nothing to restore */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Fade out finished job cards (failed ones stay until dismissed).
  const scheduled = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs) {
      if ((j.status === "completed" || j.status === "cancelled") && !scheduled.current.has(j.jobId)) {
        scheduled.current.add(j.jobId);
        window.setTimeout(() => setJobs((js) => js.filter((x) => x.jobId !== j.jobId)), j.status === "completed" ? 4000 : 2000);
      }
    }
  }, [jobs]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingImages(true);
    try {
      const page = await api.listImages({ limit: PAGE, before: nextBefore });
      setImages((prev) => [...prev, ...page.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextBefore(page.nextBefore);
      setHasMore(page.nextBefore != null && page.items.length > 0);
    } catch (e) {
      toast.error("Couldn't load the gallery", e);
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoadingImages(false);
    }
  }, [nextBefore, toast]);

  const firstLoad = useRef(false);
  useEffect(() => {
    if (firstLoad.current) return;
    firstLoad.current = true;
    void loadMore();
  }, [loadMore]);

  // Vault work changed the General gallery (the migration moved it into the vault): reload page one.
  const generalEpoch = useRef(vault.generalEpoch);
  useEffect(() => {
    if (generalEpoch.current === vault.generalEpoch) return;
    generalEpoch.current = vault.generalEpoch;
    void (async () => {
      try {
        const page = await api.listImages({ limit: PAGE, before: null });
        imagesRef.current = page.items;
        setImages(page.items);
        setNextBefore(page.nextBefore);
        setHasMore(page.nextBefore != null && page.items.length > 0);
      } catch (e) {
        toast.error("Couldn't reload the gallery", e);
      }
    })();
  }, [vault.generalEpoch, toast]);

  // On lock: drop every vault record this screen holds (open lightbox, start image, job card prompts/outputs).
  const lockEpoch = useRef(vault.lockEpoch);
  useEffect(() => {
    if (lockEpoch.current === vault.lockEpoch) return;
    lockEpoch.current = vault.lockEpoch;
    setLightboxId((id) => (id && imagesRef.current.some((x) => x.id === id) ? id : null));
    setStartImage((s) => (s && (s.vaultId || isVaultUrl(s.refId)) ? null : s));
    setRefs((rs) => (rs.some((r) => isVaultUrl(r.refId)) ? rs.filter((r) => !isVaultUrl(r.refId)) : rs));
    setStartPickerOpen(false);
    setJobs((js) => js.map((j) => (j.destination === "vault" ? { ...j, prompt: "", images: [] } : j)));
  }, [vault.lockEpoch]);

  // ---------- generate ----------
  const blocker = !model
    ? "Choose a model"
    : !configured
      ? "Connect RunPod in Settings first"
      : !model.installed
        ? `${model.name} isn't installed`
        : !prompt.trim()
          ? "Write a prompt"
          : refBusy
            ? "Adding references…"
            : startBusy
              ? "Adding the start image…"
              : null;

  const doGenerate = async () => {
    if (submitting) return;
    if (blocker) {
      if (!prompt.trim()) promptRef.current?.focus();
      else toast.info(blocker);
      return;
    }
    if (!model) return;
    const input: GenerateInput = {
      model: model.id,
      prompt: prompt.trim(),
      aspectRatio: aspect,
      count,
      referenceIds: refs.slice(0, maxRefs).map((r) => r.refId),
      loras: loraPicks.slice(0, MAX_LORAS),
    };
    if (model.supportsNegativePrompt && adv.negativePrompt.trim()) input.negativePrompt = adv.negativePrompt.trim();
    if (!adv.randomSeed && adv.seed !== "") input.seed = Number(adv.seed);
    if (adv.steps !== "" && Number(adv.steps) > 0) input.steps = Math.round(Number(adv.steps));
    if (adv.cfg !== "" && !isNaN(Number(adv.cfg))) input.cfg = Number(adv.cfg);
    if (startActive && startImage) {
      if (startImage.vaultId) input.initImageVaultId = startImage.vaultId;
      else input.initImageId = startImage.refId;
      input.denoise = denoise;
    }
    input.destination = saveTo;

    setSubmitting(true);
    try {
      const { jobId } = await api.generate(input);
      const meta = { modelName: model.name, prompt: input.prompt, destination: saveTo };
      setJobs((js) =>
        js.some((j) => j.jobId === jobId)
          ? js.map((j) => (j.jobId === jobId ? { ...j, ...meta } : j))
          : [...js, { jobId, status: "queued", total: count, completed: 0, progress: null, images: [], error: null, startedAt: Date.now(), ...meta }],
      );
    } catch (e) {
      toast.error("Couldn't start the generation", e);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await api.cancelJob(jobId);
    } catch (e) {
      toast.error("Couldn't cancel", e);
    }
  };

  // ---------- restore ----------
  const applySettings = async (im: ImageRecord) => {
    // Settings from a vault item keep the new outputs in the vault.
    if (im.vault) setSaveChoice("vault");
    const dest: Destination = im.vault ? "vault" : saveTo;
    if (isVideo(im)) {
      setLightboxId(null);
      setMode("video");
      // A start frame taken from the gallery (or vault) is re-selected in place (matched by its file path).
      const pool = im.vault ? vault.items : imagesRef.current;
      const galleryStart = im.initImage ? (pool.find((x) => x.kind !== "video" && x.path === im.initImage) ?? null) : null;
      await videoRef.current?.applySettings(im, galleryStart);
      return;
    }
    const m = imageModels.find((x) => x.id === im.model);
    if (!m) return toast.error("That model is no longer available", im.model);
    setLightboxId(null);
    setMode("image");
    setModelId(m.id);
    setPrompt(im.prompt);
    setAspect(im.aspectRatio);
    setAdv({
      seed: String(im.seed),
      randomSeed: false,
      steps: String(im.steps),
      cfg: String(im.cfg),
      negativePrompt: m.supportsNegativePrompt ? im.negativePrompt : "",
    });
    setAdvOpen(true);

    const missing: string[] = [];
    const picks: LoraPick[] = [];
    for (const l of im.loras.slice(0, MAX_LORAS)) {
      const found = lib.loras.find((x) => x.name === l.name && x.modelId === m.id && x.present);
      if (found) picks.push({ loraId: found.id, strength: l.strength });
      else missing.push(l.name);
    }
    setLoraPicks(picks);

    // img2img: re-import the stored start image (the original file may be gone).
    setStartImage(null);
    setDenoise(DENOISE_DEFAULT);
    let startFailed = false;
    if (im.initImage && m.supportsImg2Img) {
      setDenoise(Math.min(DENOISE_MAX, Math.max(DENOISE_MIN, im.denoise ?? DENOISE_DEFAULT)));
      setStartBusy(true);
      try {
        setStartImage(await api.importReference(im.initImage, dest));
      } catch {
        startFailed = true;
      } finally {
        setStartBusy(false);
      }
    }

    setRefs([]);
    let refFails = 0;
    if (m.maxReferences > 0 && im.references.length) {
      setRefBusy(true);
      const restored: RefItem[] = [];
      for (const p of im.references.slice(0, m.maxReferences)) {
        try {
          restored.push(await api.importReference(p, dest));
        } catch {
          refFails++;
        }
      }
      setRefs(restored);
      setRefBusy(false);
    }
    const problems = [
      missing.length && `LoRA not in library: ${missing.join(", ")}`,
      refFails && plural(refFails, "reference") + " couldn't be restored",
      startFailed && "The start image couldn't be restored",
    ].filter(Boolean);
    if (problems.length) toast.info("Settings restored, with gaps", problems.join(". "));
    else toast.success("Settings restored", `${m.name} · seed ${im.seed}`);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  /** An item left the visible list (deleted, or moved to the other tab): show its neighbour. */
  const onRemoved = (id: string) => {
    const i = shown.findIndex((x) => x.id === id);
    const neighbour = i >= 0 ? (shown[i + 1] ?? shown[i - 1]) : undefined;
    setLightboxId((cur) => (cur === id ? (neighbour?.id ?? null) : cur));
    if (galleryTab === "vault") {
      vault.removeLocal(id);
    } else {
      const next = imagesRef.current.filter((x) => x.id !== id);
      imagesRef.current = next;
      setImages(next);
    }
  };

  /** A vault item moved to General: slot it into the loaded General list by date. */
  const onMovedToGeneral = (rec: ImageRecord) => {
    onRemoved(rec.id);
    const list = imagesRef.current;
    if (list.some((x) => x.id === rec.id)) return;
    const t = Date.parse(rec.createdAt);
    const at = list.findIndex((x) => Date.parse(x.createdAt) < t);
    if (at < 0 && hasMore) return; // older than what's loaded: arrives with a later page
    const next = at < 0 ? [...list, rec] : [...list.slice(0, at), rec, ...list.slice(at)];
    imagesRef.current = next;
    setImages(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doGenerate();
    }
  };

  const activeJobs = jobs.filter((j) => isJobActive(j) && j.kind !== "video").length;
  const activeVideoJobs = jobs.filter((j) => isJobActive(j) && j.kind === "video").length;

  const onVideoQueued = useCallback((job: JobView) => {
    setJobs((js) =>
      js.some((j) => j.jobId === job.jobId)
        ? js.map((j) => (j.jobId === job.jobId ? { ...j, modelName: job.modelName, prompt: job.prompt, kind: "video", destination: job.destination } : j))
        : [...js, job],
    );
  }, []);

  // ---------- gallery tabs (General | Vault) and filters ----------
  const [galleryTab, setGalleryTabState] = useState<GalleryTab>("general");
  const [filters, setFilters] = useState<Record<GalleryTab, GalleryFilter>>({ general: "all", vault: "all" });
  const filter = filters[galleryTab];
  const setFilter = (f: GalleryFilter, tab: GalleryTab = galleryTab) => setFilters((x) => ({ ...x, [tab]: f }));
  const setGalleryTab = (t: GalleryTab) => {
    setGalleryTabState(t);
    setLightboxId(null);
  };
  // Vault items are listed only while unlocked (the provider empties them on lock).
  const tabItems = galleryTab === "vault" ? (vault.unlocked ? vault.items : []) : images;
  const shown = useMemo(() => applyFilter(tabItems, filter), [tabItems, filter]);
  const videoCount = useMemo(() => tabItems.filter(isVideo).length, [tabItems]);
  const tabHasMore = galleryTab === "vault" ? false : hasMore;
  const migrating = !!vault.migration && vault.migration.phase !== "done" && vault.migration.phase !== "error";
  const lightboxIndex = lightboxId ? shown.findIndex((x) => x.id === lightboxId) : -1;

  /** Job card thumbnail → open it in the right tab (clearing a filter that hides it). */
  const openFromJob = (id: string) => {
    const inVault = vault.unlocked && vault.items.some((x) => x.id === id);
    const tab: GalleryTab = inVault ? "vault" : "general";
    const list = inVault ? vault.items : images;
    if (!list.some((x) => x.id === id)) return;
    setGalleryTabState(tab);
    if (!applyFilter(list, filters[tab]).some((x) => x.id === id)) setFilter("all", tab);
    setLightboxId(id);
  };

  /** The video GPU's start note on video job cards while that GPU is off or starting. */
  const vgpu = gpu.profiles.video;
  const videoGpuNote =
    gpu.podMode && (gpuIsOff(vgpu.state) || vgpu.state?.status === "starting")
      ? `Starting the video GPU (${vgpu.startTarget}, ${vgpu.costLabel}) — it auto-stops after ${vgpu.idleMinutes} idle minutes.`
      : null;

  return (
    <div className="create">
      <VideoPanel
        ref={videoRef}
        hidden={mode !== "video"}
        active={active && mode === "video"}
        modeSwitch={modeSwitch}
        saveTo={saveTo}
        saveToSwitch={saveToSwitch}
        onVaultStart={setVideoVaultStart}
        onNavigate={onNavigate}
        onQueued={onVideoQueued}
        activeJobs={activeVideoJobs}
        modelNames={modelNames}
      />
      <form
        className="panel"
        aria-label="Generation settings"
        hidden={mode !== "image"}
        onKeyDown={onKeyDown}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void doGenerate();
        }}
      >
        <div className="panel__scroll">
          {modeSwitch}
          <section className="section">
            <h2 className="section__title">Model</h2>
            {imageModels.length === 0 ? (
              <div className="skeleton skeleton--cards" aria-label="Loading models" />
            ) : (
              <ModelPicker models={imageModels} value={modelId} onChange={selectModel} />
            )}
            {model && !model.installed && (
              <div className="notice notice--inline">
                <Icon name="cube" />
                <span>
                  {model.task ? `${model.name} is downloading to your volume.` : `${model.name} isn't on your RunPod volume yet.`}
                </span>
                <button type="button" className="link-btn" onClick={() => onNavigate("models")}>
                  {model.task ? "View progress" : "Install in Models"} →
                </button>
              </div>
            )}
          </section>

          <section className="section">
            <div className="section__head">
              <label className="section__title" htmlFor="prompt">
                Prompt
              </label>
              <span className="hint">
                <kbd>⌘</kbd>
                <kbd>↵</kbd> to generate
              </span>
            </div>
            <textarea
              id="prompt"
              ref={promptRef}
              className="input textarea prompt"
              rows={5}
              placeholder="Describe the image — subject, setting, light, lens, mood…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck
            />
          </section>

          {maxRefs > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">References</h2>
                <span className="hint mono">
                  {refs.length}/{maxRefs}
                </span>
              </div>
              <References
                max={maxRefs}
                refs={refs}
                busy={refBusy}
                dragActive={dragActive}
                onRemove={(id) => setRefs((rs) => rs.filter((r) => r.refId !== id))}
                onFiles={addFiles}
                onPick={pickRefs}
              />
            </section>
          )}

          {img2img && (
            <section className="section" aria-labelledby="start-image-title">
              <div className="section__head">
                <h2 className="section__title" id="start-image-title">
                  Start image <span className="section__aside">(optional) — the model redraws this image</span>
                </h2>
              </div>
              <StartImage
                image={startImage}
                denoise={denoise}
                busy={startBusy}
                dragActive={dragActive && toStart}
                onDenoise={setDenoise}
                onRemove={() => setStartImage(null)}
                onFiles={addStartFiles}
                onPick={pickStart}
                onPickGallery={() => setStartPickerOpen(true)}
              />
            </section>
          )}

          <section className="section">
            <h2 className="section__title">LoRAs</h2>
            <LoraPicker
              model={model}
              library={lib.loras}
              picks={loraPicks}
              onChange={setLoraPicks}
              onInsertWord={insertWord}
              onOpenLibrary={() => onNavigate("models")}
            />
          </section>

          <section className="section">
            <h2 className="section__title">Aspect ratio</h2>
            <AspectPicker value={aspect} onChange={setAspect} disabled={startActive} describedBy={startActive ? "aspect-note" : undefined} />
            {startActive && (
              <p className="hint section__note" id="aspect-note">
                <Icon name="info" size={12} /> Size follows the start image
              </p>
            )}
          </section>

          <section className="section section--row">
            <h2 className="section__title">Images</h2>
            <CountPicker value={count} onChange={setCount} />
          </section>

          <Advanced model={model} values={adv} onChange={setAdv} open={advOpen} onToggle={() => setAdvOpen((o) => !o)} />
        </div>

        <div className="panel__foot">
          {saveToSwitch}
          <button type="submit" className="btn btn--generate" disabled={submitting || (!!blocker && blocker !== "Write a prompt")} aria-describedby="gen-hint">
            <Icon name="spark" size={18} />
            <span>
              {submitting
                ? "Queuing…"
                : `${startsGpu ? "Start GPU & Generate" : "Generate"}${count > 1 ? ` ${count}` : ""}`}
            </span>
            <span className="kbd-group" aria-hidden>
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </span>
          </button>
          <p id="gen-hint" className="hint panel__hint">
            {blocker && blocker !== "Write a prompt" ? blocker : activeJobs
                ? `${plural(activeJobs, "job")} running`
                : startsGpu
                  ? `Starts the GPU pod first (${gpu.startTarget}, ${gpu.costLabel}; a few minutes). It auto-stops after ${gpu.idleMinutes} idle min.`
                  : gpu.podMode
                    ? "Runs on your GPU pod."
                    : "Each image is one RunPod job."}
          </p>
        </div>
      </form>

      <main className="canvas" ref={scrollRef} aria-label="Results">
        {jobs.length > 0 && (
          <div className="jobs" aria-label="Generations in progress">
            {jobs.map((j) => (
              <JobCard
                key={j.jobId}
                job={j}
                sealed={j.destination === "vault" && !vault.unlocked}
                podMode={gpu.podMode}
                gpuNote={j.kind === "video" && (j.status === "queued" || j.status === "starting") ? videoGpuNote : null}
                onCancel={() => cancelJob(j.jobId)}
                onDismiss={() => setJobs((js) => js.filter((x) => x.jobId !== j.jobId))}
                onOpenImage={openFromJob}
              />
            ))}
          </div>
        )}
        <div className="canvas__head">
          <h2 className="canvas__title">Gallery</h2>
          <GalleryTabs value={galleryTab} onChange={setGalleryTab} unlocked={vault.unlocked} />
          {(galleryTab === "general" || (vault.unlocked && !migrating)) && (
            <GalleryFilterChips
              value={filter}
              onChange={(f) => {
                setFilter(f);
                setLightboxId(null);
              }}
            />
          )}
          <span className="hint canvas__count">
            {tabItems.length && !(galleryTab === "vault" && migrating)
              ? filter === "all"
                ? `${tabItems.length}${tabHasMore ? "+" : ""} item${tabItems.length === 1 ? "" : "s"}${videoCount ? ` · ${videoCount} video${videoCount === 1 ? "" : "s"}` : ""}`
                : `${shown.length}${tabHasMore ? "+" : ""} ${filter === "video" ? (shown.length === 1 ? "video" : "videos") : shown.length === 1 ? "image" : "images"}`
              : ""}
          </span>
          {vault.unlocked && (
            <button type="button" className="btn btn--sm vault-lock-btn" onClick={() => void vault.lock()} title="Lock the vault now — its items disappear until you unlock">
              <Icon name="lock" size={14} /> Lock vault
            </button>
          )}
        </div>
        <div id="gallery-panel" role="tabpanel" aria-labelledby={`gallery-tab-${galleryTab}`}>
          {galleryTab === "general" ? (
            <Gallery
              items={shown}
              filter={filter}
              loadedCount={images.length}
              modelNames={modelNames}
              loading={loadingImages}
              hasMore={hasMore}
              onLoadMore={loadMore}
              onOpen={(i) => setLightboxId(shown[i]?.id ?? null)}
              scrollRoot={scrollRef}
            />
          ) : (
            <>
              {vault.migration && (vault.unlocked || migrating) && (
                <MigrationView progress={vault.migration} onDone={vault.dismissMigration} />
              )}
              {!vault.status ? (
                <div className="gallery__loading" role="status">
                  <Icon name="refresh" className="spin" /> Loading…
                </div>
              ) : !vault.exists ? (
                <VaultCreate generalCount={images.length} generalMore={hasMore} />
              ) : !vault.unlocked ? (
                <VaultLockScreen />
              ) : !migrating ? (
                <Gallery
                  items={shown}
                  filter={filter}
                  loadedCount={vault.items.length}
                  modelNames={modelNames}
                  loading={vault.loading && vault.items.length === 0}
                  hasMore={false}
                  onLoadMore={() => {}}
                  onOpen={(i) => setLightboxId(shown[i]?.id ?? null)}
                  scrollRoot={scrollRef}
                  empty={
                    filter === "video"
                      ? { icon: "video", title: "No videos in the vault", text: "Set Save to: Vault before generating a video, or move one in from General." }
                      : filter === "image"
                        ? { icon: "image", title: "No images in the vault", text: "Set Save to: Vault before generating, or move images in from General." }
                        : { icon: "lock", title: "Your vault is empty", text: "Set Save to: Vault on the Create panel, or open an item in General and choose Move to vault." }
                  }
                />
              ) : null}
            </>
          )}
        </div>
      </main>

      <Lightbox
        items={shown}
        index={lightboxIndex >= 0 ? lightboxIndex : null}
        onIndex={(i) => setLightboxId(shown[i]?.id ?? null)}
        onClose={() => setLightboxId(null)}
        onDeleted={onRemoved}
        onMovedToVault={onRemoved}
        onMovedToGeneral={onMovedToGeneral}
        vaultExists={vault.exists}
        vaultUnlocked={vault.unlocked}
        onUseSettings={applySettings}
        onMakeVideo={
          lib.videoModels.some((m) => m.modes?.includes("i2v"))
            ? (im) => {
                setLightboxId(null);
                if (im.vault) setSaveChoice("vault");
                setMode("video");
                videoRef.current?.startFromImage(im);
              }
            : undefined
        }
        modelNames={modelNames}
      />

      <GalleryPicker
        open={startPickerOpen}
        preferVault={saveTo === "vault"}
        modelNames={modelNames}
        onClose={() => setStartPickerOpen(false)}
        onPick={(rec) => {
          setStartPickerOpen(false);
          // A vault item is used in place (decrypted in memory by the backend, `initImageVaultId`).
          if (rec.vault) {
            setSaveChoice("vault");
            setStartImage({ refId: "", thumbPath: rec.thumbPath || rec.path, vaultId: rec.id });
            return;
          }
          // Image mode has no gallery-id argument: import the gallery file like any other start image.
          void setStartFrom(() => api.importReference(rec.path, saveTo));
        }}
      />

      <input
        ref={startFileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addStartFiles(files);
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addFiles(files);
        }}
      />
    </div>
  );
}

const GALLERY_TABS: GalleryTab[] = ["general", "vault"];

function GalleryTabs({ value, onChange, unlocked }: { value: GalleryTab; onChange: (t: GalleryTab) => void; unlocked: boolean }) {
  return (
    <div className="gallery-tabs" role="tablist" aria-label="Gallery" onKeyDown={radioKeys(GALLERY_TABS, value, onChange)}>
      {GALLERY_TABS.map((t) => (
        <button
          key={t}
          id={`gallery-tab-${t}`}
          type="button"
          role="tab"
          aria-selected={t === value}
          aria-controls="gallery-panel"
          tabIndex={t === value ? 0 : -1}
          className={`gallery-tab ${t === value ? "is-active" : ""}`}
          onClick={() => onChange(t)}
        >
          {t === "general" ? (
            "General"
          ) : (
            <>
              <Icon name={unlocked ? "unlock" : "lock"} size={14} />
              Vault
              <span className="visually-hidden">{unlocked ? " (unlocked)" : " (locked)"}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

const FILTERS: { id: GalleryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
];

function GalleryFilterChips({ value, onChange }: { value: GalleryFilter; onChange: (f: GalleryFilter) => void }) {
  return (
    <div
      className="chips chips--filter"
      role="radiogroup"
      aria-label="Show"
      onKeyDown={radioKeys(
        FILTERS.map((f) => f.id),
        value,
        onChange,
      )}
    >
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={f.id === value}
          tabIndex={f.id === value ? 0 : -1}
          className={`chip chip--filter ${f.id === value ? "is-selected" : ""}`}
          onClick={() => onChange(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
