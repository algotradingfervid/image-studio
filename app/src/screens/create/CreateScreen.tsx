import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LORA_LIBRARY_TARGET, requestModelFocus } from "../models/ModelsScreen";
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
  type Lora,
} from "../../api";
import { Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { ASPECTS } from "../../lib/aspect";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import type { Tab } from "../../App";
import {
  AddLoraLinkDialog,
  Advanced,
  advancedDefaults,
  advBlocker,
  AspectPicker,
  CountPicker,
  LoraPicker,
  MAX_LORAS,
  measureImage,
  ModelPicker,
  ModeSwitch,
  NOT_AN_IMAGE,
  PanelNoticeView,
  promptHasWord,
  ratioLabel,
  readDraft,
  useMoreBelow,
  writeDraft,
  realImageFiles,
  References,
  removeWordFromPrompt,
  StartImage,
  usePanelNotice,
  useVaultLockCycle,
  type AdvancedValues,
  type CreateMode,
  type LoraPick,
  type RefItem,
} from "./Controls";
import { countGallery, Gallery, totalFor, type GalleryTotals } from "./Gallery";
import { GalleryPicker } from "./GalleryPicker";
import { JobList, type JobView } from "./JobCard";
import { Lightbox } from "./Lightbox";
import { VideoPanel, type VideoPanelHandle } from "./VideoPanel";
import { MigrationView, SaveToSwitch, VaultCreate, VaultLockScreen } from "./VaultViews";

const PAGE = 24;
const LAST_MODEL_KEY = "imagestudio.lastModel";
const MODE_KEY = "imagestudio.createMode";
/** The user's last Save-to choice (UX-009: it never changes by itself). */
const SAVE_TO_KEY = "imagestudio.saveTo";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
/** A second Generate within this long of the last one is ignored (double-click guard; 1.5 s covers a hesitant double tap, UI-078). */
const GENERATE_GUARD_MS = 1500;
/** The same job sent again within this long gets a "Queued again · Undo" notice (UI-078). */
const REPEAT_WINDOW_MS = 4000;
/** The non-vault Image form draft (UX-058): restored after a reload, never holds vault content. */
const DRAFT_KEY = "imagestudio.draft.image";
interface ImageDraft {
  modelId: string;
  prompt: string;
  aspect: string;
  count: number;
  adv: AdvancedValues;
  loraPicks: LoraPick[];
  denoise: number;
}

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

function readSaveTo(): Destination | null {
  try {
    const v = localStorage.getItem(SAVE_TO_KEY);
    return v === "vault" || v === "general" ? v : null;
  } catch {
    return null;
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export type GalleryFilter = "all" | "image" | "video";
export type GalleryTab = "general" | "vault";
const isVideo = (im: ImageRecord) => im.kind === "video";
const applyFilter = (list: ImageRecord[], f: GalleryFilter) => (f === "all" ? list : list.filter((im) => (f === "video") === isVideo(im)));

/**
 * img2img start image: imported (`refId`) or a vault item used in place (`vaultId`, spec v6).
 * `path` = the source file (to re-use it as a reference), `sourceId` = the gallery/vault record it came
 * from, `label` = the one-line origin under the thumbnail, `w`/`h` = its size once known.
 */
type StartPick = RefItem & { vaultId?: string; path?: string; sourceId?: string; label?: string; w?: number; h?: number; exact?: boolean };
const isVaultStart = (s: StartPick | null | undefined) => !!s && (!!s.vaultId || isVaultUrl(s.refId));

/** What each image model remembers while you use another one (UX-005; memory only, never persisted). */
interface ImageMemory {
  adv: AdvancedValues;
  loraPicks: LoraPick[];
  denoise: number;
  startImage: StartPick | null;
  refs: RefItem[];
  /** Holds vault-derived values: moved out of reach while the vault is locked. */
  vault: boolean;
}

/** Vault-derived form values set aside while the vault is locked (memory only). */
interface ImageStash {
  form: boolean;
  prompt: string;
  modelId: string;
  adv: AdvancedValues;
  loraPicks: LoraPick[];
  denoise: number;
  startImage: StartPick | null;
  refs: RefItem[];
  tainted: boolean;
  memory: [string, ImageMemory][];
}

export function CreateScreen({ active, onNavigate }: { active: boolean; onNavigate: (t: Tab) => void }) {
  const lib = useLibrary();
  const toast = useToast();
  const configured = isConfigured(lib.settings);
  const gpu = useGpu();
  const vault = useVault();
  // Pod backend with the GPU not starting/running: Generate starts it first (after the start confirmation).
  const startsGpu = gpu.profiles.image.needsStart;
  const imageModels = lib.imageModels;
  const { notice, show: showNotice, clear: clearNotice, hold: holdNotice } = usePanelNotice();

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

  // ---------- Save to: General | Vault (spec v6; the last choice is remembered, never switched by itself) ----------
  const [saveChoice, setSaveChoiceState] = useState<Destination | null>(readSaveTo);
  const setSaveChoice = useCallback((d: Destination) => {
    setSaveChoiceState(d);
    try {
      localStorage.setItem(SAVE_TO_KEY, d);
    } catch {
      /* ignore */
    }
  }, []);
  /** Video mode's start image is vault content (reported by VideoPanel). */
  const [videoVaultStart, setVideoVaultStart] = useState(false);

  // ---------- form state ----------
  const draft = useRef(readDraft<ImageDraft>(DRAFT_KEY)).current;
  const [modelId, setModelId] = useState<string>(() => draft?.modelId || readLastModel());
  const [prompt, setPromptState] = useState(() => (typeof draft?.prompt === "string" ? draft.prompt : ""));
  const [promptError, setPromptError] = useState(false);
  const setPrompt = useCallback((p: string) => {
    setPromptState(p);
    if (p.trim()) setPromptError(false);
  }, []);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [refBusy, setRefBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [loraPicks, setLoraPicks] = useState<LoraPick[]>([]);
  // img2img start image (models with supportsImg2Img) and its strength.
  const [startImage, setStartImage] = useState<StartPick | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [loraLinkOpen, setLoraLinkOpen] = useState(false);
  const [denoise, setDenoise] = useState(() => (typeof draft?.denoise === "number" ? draft.denoise : DENOISE_DEFAULT));
  const [aspect, setAspect] = useState(() => (typeof draft?.aspect === "string" ? draft.aspect : "1:1"));
  const [count, setCount] = useState(() => (typeof draft?.count === "number" && draft.count >= 1 && draft.count <= 4 ? draft.count : 1));
  const [adv, setAdv] = useState<AdvancedValues>(() => advancedDefaults(undefined));
  const [advOpen, setAdvOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /**
   * The prompt / seed / LoRAs came from the vault: restored from a vault item, or sent with a job saved
   * to the vault. They're cleared when the vault locks and come back on unlock (UX-003).
   */
  const [tainted, setTainted] = useState(false);
  const memory = useRef(new Map<string, ImageMemory>());
  /** Trigger words this form inserted with the chips (removed again with their LoRA). */
  const chipWords = useRef(new Set<string>());
  /** LoRAs added from a link here: added to the form once their download finishes. */
  const pendingLoras = useRef(new Set<string>());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const startFileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const lastSubmit = useRef(0);
  /** The last queued job's settings, to spot an accidental repeat (UI-078). */
  const lastQueued = useRef<{ key: string; at: number } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** "Add LoRA": where focus goes when the link dialog closes (its menu item is gone, UI-006). */
  const loraAddRef = useRef<HTMLButtonElement>(null);
  /** The form's scroll position while the link dialog is open, restored on close (UI-036). */
  const loraLinkScroll = useRef(0);

  const model = imageModels.find((m) => m.id === modelId);
  const maxRefs = model?.maxReferences ?? 0;
  const img2img = !!model?.supportsImg2Img;
  const startActive = img2img && !!startImage;
  const formHasVaultInputs = isVaultStart(startImage) || refs.some((r) => isVaultUrl(r.refId));

  // A vault start image or reference keeps the output in the vault (the core refuses "general").
  const vaultInputs =
    mode === "video" ? videoVaultStart : (startActive && isVaultStart(startImage)) || refs.slice(0, maxRefs).some((r) => isVaultUrl(r.refId));
  // The user's last choice (General until they pick). Vault while locked is allowed (outputs are sealed).
  const saveTo: Destination = !vault.exists ? "general" : vaultInputs ? "vault" : (saveChoice ?? "general");
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
    setAdv(draft?.modelId === m.id && draft.adv ? { ...advancedDefaults(m), ...draft.adv } : advancedDefaults(m));
  }, [imageModels, modelId, draft]);

  // The draft's LoRAs come back once the library has loaded (the "drop missing LoRAs" effect would clear them earlier).
  const loraDraftApplied = useRef(false);
  useEffect(() => {
    if (loraDraftApplied.current || !lib.loaded) return;
    loraDraftApplied.current = true;
    const picks = (draft?.loraPicks ?? []).filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present && l.modelId === draft?.modelId));
    if (picks.length && draft?.modelId === modelId) setLoraPicks(picks.slice(0, MAX_LORAS));
  }, [lib.loaded, lib.loras, draft, modelId]);

  useEffect(() => {
    try {
      if (modelId) localStorage.setItem(LAST_MODEL_KEY, modelId);
    } catch {
      /* ignore */
    }
  }, [modelId]);

  // Drop LoRAs that disappeared from the library (deleted in Models); add link-added ones once downloaded.
  useEffect(() => {
    setLoraPicks((ps) => {
      let keep = ps.filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present));
      for (const id of [...pendingLoras.current]) {
        const l = lib.loras.find((x) => x.id === id);
        if (!l) continue;
        if (l.present) {
          pendingLoras.current.delete(id);
          if (l.modelId === modelId && keep.length < MAX_LORAS && !keep.some((p) => p.loraId === id)) keep = [...keep, { loraId: id, strength: 1 }];
        } else if (l.task && (l.task.status === "failed" || l.task.status === "cancelled")) {
          pendingLoras.current.delete(id);
        }
      }
      return keep.length === ps.length && keep.every((p, i) => p === ps[i]) ? ps : keep;
    });
  }, [lib.loras, modelId]);

  // The start image's size (for the "Size: 3:4" line): from its record, else measured from the thumbnail.
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

  // Save the draft; anything vault-derived removes it instead (never persisted).
  useEffect(() => {
    if (!initialised.current) return;
    writeDraft(DRAFT_KEY, tainted || formHasVaultInputs ? null : ({ modelId, prompt, aspect, count, adv, loraPicks, denoise } satisfies ImageDraft));
  }, [modelId, prompt, aspect, count, adv, loraPicks, denoise, tainted, formHasVaultInputs]);

  useMoreBelow(panelScrollRef);

  const currentMemory = (): ImageMemory => ({ adv, loraPicks, denoise, startImage, refs, vault: tainted || formHasVaultInputs });

  // ---------- model switch: each model keeps its own settings (UX-005) ----------
  const selectModel = (id: string) => {
    if (id === modelId) return;
    const next = imageModels.find((m) => m.id === id);
    if (!next) return;
    const cur = model;
    memory.current.set(modelId, currentMemory());
    const mem = memory.current.get(id);
    setModelId(id);
    setAdv(mem?.adv ?? { ...advancedDefaults(next), seed: adv.seed, randomSeed: adv.randomSeed });
    setLoraPicks((mem?.loraPicks ?? []).filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present && l.modelId === id)));
    if (mem?.vault) setTainted(true);
    if (mem) setDenoise(mem.denoise);

    // LoRAs are made for one model: set them aside (they come back with that model) and take out the
    // trigger words the chips inserted.
    const aside = loraPicks.map((p) => lib.loras.find((l) => l.id === p.loraId)).filter((l): l is Lora => !!l);
    let nextPrompt = prompt;
    const tookOut: string[] = [];
    for (const l of aside)
      for (const w of l.triggerWords)
        if (chipWords.current.has(w.toLowerCase()) && promptHasWord(nextPrompt, w)) {
          nextPrompt = removeWordFromPrompt(nextPrompt, w);
          chipWords.current.delete(w.toLowerCase());
          tookOut.push(w);
        }
    if (nextPrompt !== prompt) setPrompt(nextPrompt);

    // Start image: kept when the new model takes one; else offered as a reference (UX-094) or kept for the old model.
    let movedToRefs = false;
    let nextRefs = next.maxReferences > 0 ? (refs.length ? refs : (mem?.refs ?? [])).slice(0, next.maxReferences) : [];
    if (next.supportsImg2Img) {
      setStartImage(startImage ?? mem?.startImage ?? null);
    } else {
      setStartImage(null);
      if (startImage && next.maxReferences > 0 && nextRefs.length < next.maxReferences) {
        if (startImage.refId && !nextRefs.some((r) => r.refId === startImage.refId)) {
          nextRefs = [...nextRefs, { refId: startImage.refId, thumbPath: startImage.thumbPath }];
          movedToRefs = true;
        } else if (startImage.vaultId && startImage.path) {
          movedToRefs = true;
          const src = startImage.path;
          setRefBusy(true);
          api
            .importReference(src, "vault")
            .then((r) => setRefs((rs) => (rs.length < next.maxReferences ? [...rs, r] : rs)))
            .catch((e) => toast.error("Couldn't add the start image as a reference", e))
            .finally(() => setRefBusy(false));
        }
      }
    }
    setRefs(nextRefs);

    const asideParts = [
      aside.length ? listJoin(aside.map((l) => l.name)) : "",
      startImage && !next.supportsImg2Img && !movedToRefs ? "the start image" : "",
      refs.length && !next.maxReferences ? plural(refs.length, "reference") : "",
    ].filter(Boolean);
    const asideCount = aside.length + (startImage && !next.supportsImg2Img && !movedToRefs ? 1 : 0) + (!next.maxReferences ? refs.length : 0);
    const why = [
      aside.length && cur
        ? `LoRAs are made for a specific model: ${aside.length === 1 ? "this one is" : "these are"} for ${cur.name}, not ${next.name}${tookOut.length ? `, so ${listJoin(tookOut)} came out of the prompt too` : ""}.`
        : "",
      startImage && !next.supportsImg2Img && !movedToRefs ? `${next.name} doesn't take a start image.` : "",
      refs.length && !next.maxReferences ? `${next.name} doesn't take reference images.` : "",
    ].filter(Boolean);
    if (asideParts.length && cur) {
      showNotice({
        tone: "info",
        title: `Kept ${listJoin(asideParts)} for ${cur.name}`,
        detail: `${why.join(" ")} Switch back to ${cur.name} to get ${asideCount === 1 ? "it" : "them"} back.`,
      });
    } else if (movedToRefs) {
      showNotice({ tone: "info", title: "Start image added as a reference", detail: `${next.name} uses references, not a start image (img2img).` });
    } else if (mem) {
      showNotice({ tone: "ok", title: `Restored your ${next.name} settings`, detail: "LoRAs, seed, steps, CFG and negative prompt as you left them." });
    } else {
      clearNotice();
    }
    if (movedToRefs && asideParts.length) toast.info("Start image added as a reference", `${next.name} uses references, not a start image (img2img).`);
  };

  // ---------- vault lock: clear every vault-derived value, restore it on unlock (UX-003 / UX-015) ----------
  const { stashNow } = useVaultLockCycle<ImageStash>(
    (submitted) => {
      setStartPickerOpen(false);
      setRefPickerOpen(false);
      const isTainted = tainted || submitted;
      const vStart = isVaultStart(startImage);
      const vRefs = refs.some((r) => isVaultUrl(r.refId));
      const form = isTainted || vStart || vRefs;
      const memVault = [...memory.current].filter(([, m]) => m.vault);
      for (const [k] of memVault) memory.current.delete(k);
      if (notice?.vault || !submitted) clearNotice();
      if (!form && !memVault.length) return null;
      const stash: ImageStash = { form, prompt, modelId, adv, loraPicks, denoise, startImage, refs, tainted: isTainted, memory: memVault };
      if (form) {
        setPrompt("");
        if (isTainted) {
          setAdv({ ...advancedDefaults(model) });
          setLoraPicks([]);
        }
        if (vStart) setStartImage(null);
        if (vRefs) setRefs((rs) => rs.filter((r) => !isVaultUrl(r.refId)));
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
        if (s.tainted) {
          setAdv(s.adv);
          setLoraPicks(s.loraPicks.filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present)));
        }
        if (!startImage && s.startImage) {
          setStartImage(s.startImage);
          setDenoise(s.denoise);
        }
        const vr = s.refs.filter((r) => isVaultUrl(r.refId));
        if (vr.length) setRefs((rs) => [...rs, ...vr.filter((r) => !rs.some((x) => x.refId === r.refId))].slice(0, Math.max(maxRefs, 0)));
      } else {
        memory.current.set(s.modelId, { adv: s.adv, loraPicks: s.loraPicks, denoise: s.denoise, startImage: s.startImage, refs: s.refs, vault: true });
      }
      if (s.tainted || !typedMeanwhile) setTainted(true);
      showNotice({
        tone: "ok",
        title: "Vault unlocked — restored what was cleared",
        detail: typedMeanwhile
          ? "Kept the prompt you typed while it was locked."
          : s.modelId !== modelId
            ? `The start image and settings are back on ${imageModels.find((m) => m.id === s.modelId)?.name ?? "the earlier model"}.`
            : undefined,
        vault: true,
      });
    },
    // Erased vault: drop the "unlock to restore" notice (nothing can come back).
    () => {
      if (notice?.vault) clearNotice();
    },
  );

  // ---------- references ----------
  const addFiles = async (picked: File[]) => {
    const files = await realImageFiles(picked);
    if (!files.length) return showNotice({ tone: "warn", title: NOT_AN_IMAGE });
    if (files.length < picked.length) toast.info("Some files were skipped", "Only image files can be references.");
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
    if (!imgs.length) return showNotice({ tone: "warn", title: NOT_AN_IMAGE });
    if (imgs.length < paths.length) toast.info("Some files were skipped", "Only image files can be references.");
    const slots = maxRefs - refs.length;
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

  /** A gallery or vault image as a reference (UX-036); vault images stay sealed in the vault. */
  const addRefFromGallery = async (rec: ImageRecord) => {
    setRefPickerOpen(false);
    if (refs.length >= maxRefs) return toast.info(`${model?.name} takes at most ${maxRefs} references`);
    setRefBusy(true);
    try {
      const r = await api.importReference(rec.path, rec.vault ? "vault" : saveTo);
      setRefs((rs) => (rs.length < maxRefs ? [...rs, r] : rs));
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setRefBusy(false);
    }
  };

  // ---------- start image (img2img) ----------
  // Same import pipeline as references (downscaled to ≤1 MP); one image, replaced on re-add.
  const setStartFrom = async (load: () => Promise<RefItem>, extra: Partial<StartPick> = {}) => {
    setStartBusy(true);
    try {
      setStartImage({ ...(await load()), ...extra });
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
    await setStartFrom(async () => api.importReferenceBytes(await api.blobToBase64(f), f.type || "image/png", saveTo), { label: `From your computer · ${clip(f.name)}` });
  };

  const addStartPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (!imgs.length) return showNotice({ tone: "warn", title: NOT_AN_IMAGE });
    if (imgs.length > 1) toast.info("Only one start image is used", "The first image was added.");
    await setStartFrom(() => api.importReference(imgs[0], saveTo), { label: `From your computer · ${clip(imgs[0].split(/[\\/]/).pop() ?? "")}` });
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

  /** A gallery or vault record becomes the img2img start image (picker, lightbox "Redraw this image"). */
  const startFromRecord = (rec: ImageRecord) => {
    const label = `${rec.vault ? "From your vault" : "From gallery"} · ${clip(rec.prompt)} · ${modelNames[rec.model] ?? rec.model}`;
    const extra = { path: rec.path, sourceId: rec.id, label, w: rec.width || undefined, h: rec.height || undefined, exact: !!rec.width };
    // A vault item is used in place (decrypted in memory by the backend, `initImageVaultId`); it forces Save to = Vault.
    if (rec.vault) {
      setStartImage({ refId: "", thumbPath: rec.thumbPath || rec.path, vaultId: rec.id, ...extra });
      return;
    }
    // Image mode has no gallery-id argument: import the gallery file like any other start image.
    void setStartFrom(() => api.importReference(rec.path, saveTo), extra);
  };

  /** Lightbox "Redraw this image" (UX-037): Image mode, an img2img model, this record as the start image. */
  const redraw = (rec: ImageRecord) => {
    setLightboxId(null);
    const prevMode = mode;
    const prevStart = startImage;
    const prevModel = modelId;
    setMode("image");
    if (!model?.supportsImg2Img) {
      const capable = imageModels.filter((m) => m.supportsImg2Img);
      const next = capable.find((m) => m.installed) ?? capable[0];
      if (!next) return toast.info("No image model takes a start image");
      selectModel(next.id);
    }
    startFromRecord(rec);
    panelScrollRef.current?.scrollTo({ top: 0 });
    showNotice({
      tone: "ok",
      title: "Start image set — describe the changes and Generate",
      detail: [prevMode !== "image" ? "Switched to Image" : "", prevStart ? "replaced your earlier start image" : ""].filter(Boolean).join(", ") || undefined,
      undo: () => {
        setMode(prevMode);
        if (prevModel !== modelId) setModelId(prevModel);
        setStartImage(prevStart);
      },
      vault: !!rec.vault,
    });
    requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
  };

  const removeStart = () => {
    const prev = startImage;
    setStartImage(null);
    if (prev) showNotice({ tone: "info", title: "Start image removed", undo: () => setStartImage(prev), vault: isVaultStart(prev) });
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
      const files = Array.from(e.clipboardData?.files ?? []);
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
    if (promptHasWord(prompt, w)) return;
    const el = promptRef.current;
    // At the caret while the prompt has focus, else at the end.
    const focused = !!el && document.activeElement === el;
    const start = focused ? el.selectionStart : prompt.length;
    const end = focused ? el.selectionEnd : prompt.length;
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

  const toggleWord = (w: string, on: boolean) => {
    if (on) {
      chipWords.current.add(w.toLowerCase());
      insertWord(w);
    } else {
      chipWords.current.delete(w.toLowerCase());
      setPrompt(removeWordFromPrompt(prompt, w));
    }
  };

  /** A LoRA's Remove button: also take out the trigger words its chips inserted (with Undo). */
  const onLoraRemoved = (l: Lora) => {
    const prevPicks = loraPicks;
    const prevPrompt = prompt;
    const words = l.triggerWords.filter((w) => chipWords.current.has(w.toLowerCase()) && promptHasWord(prompt, w));
    let next = prompt;
    for (const w of words) {
      next = removeWordFromPrompt(next, w);
      chipWords.current.delete(w.toLowerCase());
    }
    if (next !== prompt) setPrompt(next);
    showNotice({
      tone: "info",
      title: `Removed ${l.name}`,
      detail: words.length ? `Also took ${listJoin(words)} out of the prompt.` : undefined,
      undo: () => {
        setLoraPicks(prevPicks);
        setPrompt(prevPrompt);
        for (const w of words) chipWords.current.add(w.toLowerCase());
      },
      vault: tainted,
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

  // Finished cards stay until dismissed or the next job starts (UX-041 / UX-014: the cancelled card's
  // "GPU stopped" line needs time to be read).
  const dropFinished = (js: JobView[]) => js.filter((j) => j.status !== "completed" && j.status !== "cancelled");

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


  // On lock: drop every vault record this screen holds (open lightbox, job card prompts/outputs).
  // The form's own vault values are handled by useVaultLockCycle above.
  const lockEpoch = useRef(vault.lockEpoch);
  useEffect(() => {
    if (lockEpoch.current === vault.lockEpoch) return;
    lockEpoch.current = vault.lockEpoch;
    setLightboxId((id) => (id && imagesRef.current.some((x) => x.id === id) ? id : null));
    setJobs((js) => js.map((j) => (j.destination === "vault" ? { ...j, prompt: "", images: [] } : j)));
  }, [vault.lockEpoch]);

  // ---------- generate ----------
  const imageGpuStatus = gpu.profiles.image.state?.status;
  // Every reason Generate can't run, in form order (UI-009): the button is aria-disabled while any is
  // left, the hint lists them all, and a click goes to the first one without starting the GPU.
  const advProblem = advBlocker(adv, model);
  const blockers = !model
    ? ["Choose a model"]
    : [
        !configured ? "Connect RunPod in Settings first" : "",
        !model.installed ? `${model.name} isn't installed` : "",
        gpu.podMode && imageGpuStatus === "stopping" ? "The image GPU is stopping — Generate is available again once it has stopped" : "",
        !prompt.trim() ? "Write a prompt" : "",
        advProblem ?? "",
        refBusy ? "Adding references…" : "",
        startBusy ? "Adding the start image…" : "",
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
      if (!(await gpu.confirmStart(count > 1 ? `generate ${count} images` : "generate", "image"))) return;
      const input: GenerateInput = {
        model: model.id,
        prompt: prompt.trim(),
        aspectRatio: aspect,
        count,
        referenceIds: refs.slice(0, maxRefs).map((r) => r.refId),
        loras: loraPicks.slice(0, MAX_LORAS),
      };
      if (model.supportsNegativePrompt && adv.negativePrompt.trim()) input.negativePrompt = adv.negativePrompt.trim();
      if (!adv.randomSeed && adv.seed.trim() !== "") input.seed = Number(adv.seed.trim());
      if (adv.steps.trim() !== "" && Number(adv.steps) > 0) input.steps = Math.round(Number(adv.steps));
      if (adv.cfg.trim() !== "" && !isNaN(Number(adv.cfg))) input.cfg = Number(adv.cfg);
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
        // The same settings again within a few seconds: most likely a double tap, so say so with Undo (UI-078).
        const key = JSON.stringify({ ...input, seed: input.seed ?? "random" });
        const prev = lastQueued.current;
        lastQueued.current = { key, at: Date.now() };
        if (prev && prev.key === key && Date.now() - prev.at < REPEAT_WINDOW_MS)
          showNotice({
            tone: "info",
            title: "Queued again — same settings as the job before",
            detail: "Undo cancels this copy; the first job keeps running.",
            undo: () => void cancelJob(jobId),
            vault: saveTo === "vault",
          });
        setJobs((js) =>
          js.some((j) => j.jobId === jobId)
            ? js.map((j) => (j.jobId === jobId ? { ...j, ...meta } : j))
            : [...dropFinished(js), { jobId, status: "queued", total: count, completed: 0, progress: null, images: [], error: null, startedAt: Date.now(), ...meta }],
        );
        // A prompt sent to the vault is vault content from now on (cleared on lock; at once while locked).
        if (saveTo === "vault") {
          setTainted(true);
          if (!vault.unlocked) stashNow();
        }
      } catch (e) {
        toast.error("Couldn't start the generation", e);
      } finally {
        setSubmitting(false);
      }
    } finally {
      inFlight.current = false;
      lastSubmit.current = Date.now();
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
    // Save to is never changed here (UX-009); a vault start image or reference still forces Vault.
    const dest: Destination = im.vault ? "vault" : saveTo;
    if (isVideo(im)) {
      setLightboxId(null);
      const prevMode = mode;
      setMode("video");
      // A start frame taken from the gallery (or vault) is re-selected in place (matched by its file path).
      const pool = im.vault ? vault.items : imagesRef.current;
      const galleryStart = im.initImage ? (pool.find((x) => x.kind !== "video" && x.path === im.initImage) ?? null) : null;
      await videoRef.current?.applySettings(im, galleryStart, prevMode !== "video" ? { undoMode: () => setMode(prevMode) } : undefined);
      return;
    }
    const m = imageModels.find((x) => x.id === im.model);
    if (!m) return toast.error("That model is no longer available", im.model);
    const snap = { mode, modelId, prompt, aspect, adv, loraPicks, startImage, denoise, refs, tainted };
    setLightboxId(null);
    setMode("image");
    if (m.id !== modelId) memory.current.set(modelId, currentMemory());
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
    if (im.vault) setTainted(true);
    panelScrollRef.current?.scrollTo({ top: 0 });

    const missing: string[] = [];
    const picks: LoraPick[] = [];
    for (const l of im.loras.slice(0, MAX_LORAS)) {
      const found = lib.loras.find((x) => x.name === l.name && x.modelId === m.id && x.present);
      if (found) picks.push({ loraId: found.id, strength: l.strength });
      else missing.push(l.name);
    }
    setLoraPicks(picks);

    // img2img: re-import the stored start image (the original file may be gone). Without one in the
    // source, a start image already in the form is kept.
    let startFailed = false;
    let replacedStart = false;
    let removedStart = false;
    if (im.initImage && m.supportsImg2Img) {
      replacedStart = !!startImage;
      setStartImage(null);
      setDenoise(Math.min(DENOISE_MAX, Math.max(DENOISE_MIN, im.denoise ?? DENOISE_DEFAULT)));
      setStartBusy(true);
      try {
        setStartImage({ ...(await api.importReference(im.initImage, dest)), label: `Start image of the ${im.vault ? "vault item" : "image"} you restored` });
      } catch {
        startFailed = true;
      } finally {
        setStartBusy(false);
      }
    } else if (startImage) {
      // The source had no start image (or the model takes none): the form matches the source.
      removedStart = true;
      setStartImage(null);
    }

    let refFails = 0;
    if (m.maxReferences > 0 && im.references.length) {
      setRefs([]);
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
    } else {
      setRefs((rs) => rs.slice(0, m.maxReferences));
    }

    const changes = [
      snap.mode !== "image" ? "switched to Image" : "",
      snap.prompt.trim() && snap.prompt !== im.prompt ? "replaced your prompt" : "",
      replacedStart ? "replaced your start image" : "",
      removedStart ? (m.supportsImg2Img ? "removed your start image (the restored image had none)" : `removed your start image (${m.name} doesn't take one)`) : "",
    ].filter(Boolean);
    const gaps = [
      !m.installed ? `${m.name} isn't installed — install it in Models to generate` : "",
      missing.length ? `LoRA not in your library: ${missing.join(", ")}` : "",
      refFails ? `${plural(refFails, "reference")} couldn't be restored` : "",
      startFailed ? "the start image couldn't be restored" : "",
    ].filter(Boolean);
    const forcedVault = im.vault && ((!!im.initImage && m.supportsImg2Img) || (im.references.length > 0 && m.maxReferences > 0));
    const vaultNote = im.vault && !forcedVault && saveTo === "general" ? "Save to stays General — choose Vault to keep the result private." : "";
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    showNotice({
      tone: gaps.length ? "warn" : "ok",
      title: `Settings restored · ${m.name} · seed ${im.seed}`,
      detail: [...changes, ...gaps].map(cap).concat(vaultNote ? [vaultNote] : []).join(". ") || undefined,
      undo: () => {
        setMode(snap.mode);
        setModelId(snap.modelId);
        setPrompt(snap.prompt);
        setAspect(snap.aspect);
        setAdv(snap.adv);
        setLoraPicks(snap.loraPicks);
        setStartImage(snap.startImage);
        setDenoise(snap.denoise);
        setRefs(snap.refs);
        setTainted(snap.tainted);
      },
      vault: im.vault,
    });
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  /** The General header count follows the grid at once; the background recount then confirms it (UI-080). */
  const bumpGeneralTotals = (rec: ImageRecord | undefined, by: 1 | -1) => {
    if (!rec) return;
    setGeneralTotals((t) =>
      t ? { items: Math.max(0, t.items + by), images: Math.max(0, t.images + (isVideo(rec) ? 0 : by)), videos: Math.max(0, t.videos + (isVideo(rec) ? by : 0)) } : t,
    );
  };

  /** An item left the visible list (deleted, or moved to the other tab): show its neighbour. */
  const onRemoved = (id: string) => {
    if (galleryTab === "general") bumpGeneralTotals(imagesRef.current.find((x) => x.id === id), -1);
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
    bumpGeneralTotals(rec, 1);
    const list = imagesRef.current;
    if (list.some((x) => x.id === rec.id)) return;
    const t = Date.parse(rec.createdAt);
    const at = list.findIndex((x) => Date.parse(x.createdAt) < t);
    if (at < 0 && hasMore) return; // older than what's loaded: arrives with a later page
    const next = at < 0 ? [...list, rec] : [...list.slice(0, at), rec, ...list.slice(at)];
    imagesRef.current = next;
    setImages(next);
  };

  /** After the LoRA link dialog: the form is where it was before (focus return must not scroll it, UI-036). */
  const restoreLoraLinkScroll = () => {
    const top = loraLinkScroll.current;
    requestAnimationFrame(() => panelScrollRef.current?.scrollTo({ top }));
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
        ? js.map((j) => (j.jobId === job.jobId ? { ...j, modelName: job.modelName, prompt: job.prompt, kind: "video", destination: job.destination, durationS: job.durationS, resolution: job.resolution, audio: job.audio } : j))
        : [...dropFinished(js), job],
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
  // Real General totals (UX-019): the list is paged, so count through every page when it changes.
  const [generalTotals, setGeneralTotals] = useState<GalleryTotals | null>(null);
  useEffect(() => {
    let alive = true;
    countGallery()
      .then((t) => alive && setGeneralTotals(t))
      .catch(() => alive && setGeneralTotals(null));
    return () => {
      alive = false;
    };
  }, [images.length, vault.generalEpoch]);
  const totals: GalleryTotals | null =
    galleryTab === "vault"
      ? { items: tabItems.length, images: tabItems.length - videoCount, videos: videoCount }
      : generalTotals;
  const migrating = !!vault.migration && vault.migration.phase !== "done" && vault.migration.phase !== "error";
  const lightboxIndex = lightboxId ? shown.findIndex((x) => x.id === lightboxId) : -1;

  // An erased vault takes its items with it: a "moved to the vault · Undo · View in vault" toast
  // can no longer do either.
  const erasedAt = useRef(vault.eraseEpoch);
  useEffect(() => {
    if (erasedAt.current === vault.eraseEpoch) return;
    erasedAt.current = vault.eraseEpoch;
    toast.dismissKey("vault-move");
  }, [vault.eraseEpoch, toast]);

  /** Job card thumbnail → open it in the right tab (clearing a filter that hides it). */
  const openFromJob = (id: string) => {
    const inVault = vault.unlocked && vault.items.some((x) => x.id === id);
    const tab: GalleryTab = inVault ? "vault" : "general";
    const list = inVault ? vault.items : images;
    if (!list.some((x) => x.id === id)) {
      // Moved into a locked or erased vault, or deleted: say so rather than do nothing.
      toast.notify({
        kind: "info",
        key: "job-open-missing",
        title: vault.exists && !vault.unlocked ? "That item is in the locked vault" : "That item isn't in the gallery any more",
        message: vault.exists && !vault.unlocked ? "Unlock the vault to open it." : "It was moved into a vault that has since been erased, or deleted.",
      });
      return;
    }
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

  const sizeAspect = startActive && startImage?.w && startImage.h ? ratioLabel(startImage.w, startImage.h) : null;
  const sizeHighlight = sizeAspect && ASPECTS.some((a) => a.key === sizeAspect) ? sizeAspect : undefined;
  const footHint = blocker
    ? `${blockers.join(" · ")}${blockers.length === 1 && blocker === "Write a prompt" ? " to generate" : ""}.`.replace(/(…|\.)\.$/, "$1")
    : activeJobs
      ? `${plural(activeJobs, "job")} running`
      : startsGpu
        ? `Starts the GPU pod first (${gpu.startTarget}, ${gpu.costLabel}; a few minutes). It auto-stops after ${gpu.idleMinutes} idle min.`
        : gpu.podMode
          ? `Runs on your GPU pod (${gpu.gpuName}, ${gpu.costLabel}).`
          : "Each image is one RunPod job.";

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
        history={images}
      />
      <form
        ref={formRef}
        className="panel"
        aria-label="Generation settings"
        hidden={mode !== "image"}
        onKeyDown={onKeyDown}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void doGenerate();
        }}
      >
        <div className="panel__scroll" ref={panelScrollRef}>
          {modeSwitch}
          <section className="section">
            <h2 className="section__title">Model</h2>
            {imageModels.length === 0 ? (
              <div className="skeleton skeleton--cards" aria-label="Loading models" />
            ) : (
              <ModelPicker models={imageModels} value={modelId} onChange={selectModel} />
            )}
            {model && !model.installed && (
              <div className="notice notice--inline model-missing">
                <Icon name="cube" />
                <span>
                  {model.task ? `${model.name} is downloading to your volume.` : `${model.name} isn't on your RunPod volume yet.`}
                </span>
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
              className={`input textarea prompt ${promptError ? "is-invalid" : ""}`}
              rows={5}
              placeholder="Describe the image — subject, setting, light, lens, mood…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-invalid={promptError || undefined}
              aria-describedby={promptError ? "prompt-err" : undefined}
              spellCheck
            />
            {promptError && (
              <p className="field-error" id="prompt-err" role="alert">
                Describe what you want to see first.
              </p>
            )}
          </section>

          {maxRefs > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">
                  References <span className="section__aside">(optional, up to {maxRefs}) — guide subject, style or layout</span>
                </h2>
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
                onPickGallery={() => setRefPickerOpen(true)}
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
                onRemove={removeStart}
                onFiles={addStartFiles}
                onPick={pickStart}
                onPickGallery={() => setStartPickerOpen(true)}
                caption={startImage?.label}
              />
            </section>
          )}

          <section className="section">
            <h2 className="section__title">LoRAs</h2>
            <LoraPicker
              model={model}
              library={lib.loras}
              picks={loraPicks}
              prompt={prompt}
              onChange={setLoraPicks}
              onRemoved={onLoraRemoved}
              onToggleWord={toggleWord}
              onOpenLibrary={() => {
                // Models scrolls to and focuses its LoRA library section (UI-037; contract in ModelsScreen).
                requestModelFocus(LORA_LIBRARY_TARGET);
                onNavigate("models");
              }}
              onAddFromLink={() => {
                loraLinkScroll.current = panelScrollRef.current?.scrollTop ?? 0;
                setLoraLinkOpen(true);
              }}
              addButtonRef={loraAddRef}
            />
          </section>

          <section className="section">
            <h2 className="section__title">Aspect ratio</h2>
            {startActive ? (
              <p className="hint section__note start-size" id="aspect-note">
                <Icon name="info" size={12} /> Size:{" "}
                {sizeAspect ? (
                  <>
                    <strong>{sizeAspect}</strong>
                    {startImage?.exact && startImage.w ? ` · ${startImage.w}×${startImage.h}` : ""} (follows the start image)
                  </>
                ) : (
                  "follows the start image"
                )}
              </p>
            ) : (
              <AspectPicker value={aspect} onChange={setAspect} />
            )}
            {startActive && <AspectPicker value={aspect} onChange={setAspect} disabled highlight={sizeHighlight} describedBy="aspect-note" />}
          </section>

          <section className="section section--row">
            <h2 className="section__title">Images</h2>
            <CountPicker value={count} onChange={setCount} />
          </section>

          <Advanced model={model} values={adv} onChange={setAdv} open={advOpen} onToggle={() => setAdvOpen((o) => !o)} />
        </div>

        <div className="panel__foot">
          <PanelNoticeView notice={notice} onDismiss={clearNotice} onHold={holdNotice} />
          {saveToSwitch}
          {/* Never `disabled` (also not while queuing): after the GPU confirmation focus comes back here (UI-006). */}
          <button type="submit" className={`btn btn--generate ${vault.setupActive ? "is-quiet" : ""}`} aria-disabled={!!blocker || submitting || undefined} aria-describedby="gen-hint">
            {/* Blocked: a plain "!" mark, not the spark that reads as a loading spinner. */}
            <Icon name={blocker ? "alert" : "spark"} size={18} />
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
          <p id="gen-hint" className={`hint panel__hint ${blocker ? "panel__hint--block" : ""}`}>
            {footHint}
          </p>
        </div>
      </form>

      <section className="canvas" ref={scrollRef} aria-label="Results">
        <JobList
          jobs={jobs}
          vaultUnlocked={vault.unlocked}
          podMode={gpu.podMode}
          gpuNoteFor={(j) => (j.kind === "video" && (j.status === "queued" || j.status === "starting") ? videoGpuNote : null)}
          onCancel={(id) => void cancelJob(id)}
          onDismiss={(ids) => setJobs((js) => js.filter((x) => !ids.includes(x.jobId)))}
          onOpenImage={openFromJob}
        />
        <div className="canvas__head">
          <h2 className="canvas__title">Gallery</h2>
          <GalleryTabs value={galleryTab} onChange={setGalleryTab} unlocked={vault.unlocked} exists={vault.exists} />
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
            {totals && totals.items && !(galleryTab === "vault" && migrating)
              ? filter === "all"
                ? `${totals.items} item${totals.items === 1 ? "" : "s"}${totals.videos ? ` · ${totals.videos} video${totals.videos === 1 ? "" : "s"}` : ""}`
                : `${totalFor(totals, filter)} ${filter === "video" ? (totalFor(totals, filter) === 1 ? "video" : "videos") : totalFor(totals, filter) === 1 ? "image" : "images"}`
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
      </section>

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
        onRedraw={redraw}
        onUseAsReference={
          mode === "image" && maxRefs > 0
            ? (im) => {
                setLightboxId(null);
                void addRefFromGallery(im);
              }
            : undefined
        }
        onMakeVideo={
          lib.videoModels.some((m) => m.modes?.includes("i2v"))
            ? (im) => {
                setLightboxId(null);
                const prevMode = mode;
                setMode("video");
                videoRef.current?.startFromImage(im, prevMode !== "video" ? { undoMode: () => setMode(prevMode) } : undefined);
              }
            : undefined
        }
        modelNames={modelNames}
      />

      <GalleryPicker
        open={startPickerOpen}
        preferVault={saveTo === "vault"}
        modelNames={modelNames}
        currentId={startImage?.sourceId}
        returnFocusRef={promptRef}
        onClose={() => setStartPickerOpen(false)}
        onPick={(rec) => {
          setStartPickerOpen(false);
          startFromRecord(rec);
          // The picker's opener ("From gallery") is replaced by the thumbnail: continue at the prompt (UI-006).
          requestAnimationFrame(() => promptRef.current?.focus());
        }}
      />

      <GalleryPicker
        open={refPickerOpen}
        title="Choose a reference image"
        purpose="reference"
        preferVault={saveTo === "vault"}
        modelNames={modelNames}
        returnFocusRef={promptRef}
        onClose={() => setRefPickerOpen(false)}
        onPick={(rec) => void addRefFromGallery(rec)}
      />

      <AddLoraLinkDialog
        open={loraLinkOpen}
        model={model}
        returnFocusRef={loraAddRef}
        onClose={() => {
          setLoraLinkOpen(false);
          restoreLoraLinkScroll();
        }}
        onAdded={(l) => {
          setLoraLinkOpen(false);
          restoreLoraLinkScroll();
          pendingLoras.current.add(l.id);
          showNotice({
            tone: "ok",
            title: `Adding ${l.name}`,
            detail:
              l.modelId === modelId
                ? "Downloading to your volume — it's added to this form when ready."
                : `Downloading to your volume. It's made for ${modelNames[l.modelId] ?? l.modelId}, so it appears there.`,
          });
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

function GalleryTabs({ value, onChange, unlocked, exists }: { value: GalleryTab; onChange: (t: GalleryTab) => void; unlocked: boolean; exists: boolean }) {
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
              <Icon name={unlocked ? "lockOpen" : "lock"} size={14} />
              Vault
              {!exists ? (
                <span className="gallery-tab__state"> · Set up</span>
              ) : unlocked ? (
                <span className="gallery-tab__state"> · unlocked</span>
              ) : (
                <span className="visually-hidden"> (locked)</span>
              )}
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
