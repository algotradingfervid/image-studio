// In-memory dev mock of every Tauri command and event, for `npm run dev` in a browser.
// Loaded only via dynamic import from backend.ts when `__TAURI_INTERNALS__` is absent,
// so it is completely inert inside the Tauri app.
//
// URL flags: ?unconfigured (no API key / endpoint), ?empty (empty gallery),
// ?gpuRunning (a re-adopted pod is already running, shows the launch banner),
// ?fastIdle (an auto-stop "minute" lasts 2 s), ?gpuFail (starting the GPU ends in an error),
// ?serverless (legacy serverless backend selected), ?noWatchdog (the running pod can't
// auto-stop itself), ?stopFail (stopping the GPU fails, e.g. to try the quit dialog's
// "Try again / Quit anyway").
// Video (spec v5): ?videoRunning (a re-adopted video pod is already running), ?noVideoModels
// (list_models has no video models, like a build without `videoModels`), ?videoInstalled (every
// video model's files are present; default: MiniMax H3 installed, LTX-2.5 not). Video records'
// `path` is `mock-video://<id>.mp4`, which the browser can't load, so the UI shows the poster.
//
// Quit flow: a browser tab can't intercept closing with an in-app dialog, so call
// `window.mockQuit()` from the console to simulate ⌘Q (`quit-requested` when a pod
// may be billing); `confirm_quit` then logs instead of exiting.

import registry from "../../../shared/models.json";
import type { Backend, Unlisten } from "./backend";
import { hashString, placeholderImage } from "./placeholder";
import type {
  AddLoraInput,
  ConnectionTest,
  DeletePreview,
  EventMap,
  GenerateInput,
  GenerateVideoInput,
  GpuProfile,
  GpuState,
  ImageRecord,
  ImagePage,
  Job,
  KeptFile,
  Lora,
  ModelDefaults,
  ModelFile,
  ModelView,
  ResolvedLora,
  SaveSettingsInput,
  Settings,
  StatusSnapshot,
  Task,
  VideoDefaults,
  VideoLimits,
} from "./types";
import { resolutionId } from "./types";

/** A registry entry (`models` or `videoModels` in shared/models.json). */
interface RegistryModel {
  id: string;
  name: string;
  description: string;
  license: string;
  precision: string;
  maxReferences: number;
  supportsNegativePrompt: boolean;
  supportsImg2Img: boolean;
  defaults: ModelDefaults & VideoDefaults;
  civitaiBaseModels: string[];
  files: ModelFile[];
  modes?: string[];
  audio?: boolean;
  volume?: string;
  limits?: VideoLimits;
}

const PROFILES: GpuProfile[] = ["image", "video"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const GB = 1024 ** 3;

const params = new URLSearchParams(window.location.search);

// ---------- state ----------

const GPU_TYPE = "NVIDIA RTX PRO 6000 Blackwell Server Edition";
const GPU_COST = 2.49;

const settings: Settings = {
  ...(params.has("unconfigured")
    ? { hasApiKey: false, endpointId: null, hasCivitaiKey: false }
    : { hasApiKey: true, endpointId: "abc123mockendpoint", hasCivitaiKey: true }),
  idleMinutes: 30,
  backend: params.has("serverless") ? "serverless" : "pod",
  gpuType: GPU_TYPE,
  gpuTypes: [GPU_TYPE, "NVIDIA RTX PRO 4500 Blackwell", "NVIDIA GeForce RTX 4090", "NVIDIA RTX PRO 4000 Blackwell"],
  volumeNames: ["image-studio-models"],
  passApiKeyToPod: true,
  fallbackCostPerHr: GPU_COST,
  workerRef: "main",
  podImage: "ghcr.io/algotradingfervid/image-studio-runtime:latest",
  videoGpuTypes: [GPU_TYPE, "NVIDIA H200", "NVIDIA H100 80GB HBM3"],
  videoVolumeNames: ["image-studio-video"],
};

const models: RegistryModel[] = registry.models;
const aspect = registry.aspectRatios as Record<string, number[]>;

const hf = (repo: string, path: string) => `https://huggingface.co/${repo}/resolve/main/${path}`;
const vfile = (folder: string, filename: string, gb: number, repo: string, gated = false): ModelFile => ({
  folder,
  filename,
  url: hf(repo, `split_files/${folder}/${filename}`),
  sizeBytes: Math.round(gb * GB),
  sha256: null,
  gated,
});

/** Video models (spec v5); shared/models.json gets `videoModels` later — prefer it when present. */
const videoModels: RegistryModel[] = params.has("noVideoModels")
  ? []
  : ((registry as unknown as { videoModels?: RegistryModel[] }).videoModels ?? [
      {
        id: "h3",
        name: "MiniMax H3",
        description: "Text→video and image→video with a synchronised audio track (first/last-frame model).",
        license: "MiniMax H3 Community",
        precision: "fp8",
        maxReferences: 0,
        supportsNegativePrompt: true,
        supportsImg2Img: false,
        defaults: { steps: 30, cfg: 5, sampler: "euler", scheduler: "simple", negativePrompt: "", durationS: 5, fps: 24, resolution: "1280x720" },
        civitaiBaseModels: [],
        files: [
          vfile("unet", "minimax_h3_fl2va_pruned_fp8_scaled.safetensors", 20.96, "Comfy-Org/MiniMax-H3"),
          vfile("clip", "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", 27.14, "Comfy-Org/MiniMax-H3"),
          vfile("vae", "minimax_h3_video_vae_fp16.safetensors", 5.21, "Comfy-Org/MiniMax-H3"),
          vfile("vae", "minimax_h3_audio_vae_fp32.safetensors", 0.61, "Comfy-Org/MiniMax-H3"),
        ],
        modes: ["t2v", "i2v"],
        audio: true,
        volume: "image-studio-video",
        limits: { maxDurationS: 10, resolutions: ["1280x720", "720x1280"], fpsOptions: [24] },
      },
      {
        id: "ltx25",
        name: "LTX-2.5 distilled",
        description: "Fast distilled 22B video model: text→video and image→video with audio, in 8 steps.",
        license: "LTX-2.x Community",
        precision: "int8",
        maxReferences: 0,
        supportsNegativePrompt: true,
        supportsImg2Img: false,
        defaults: { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", negativePrompt: "", durationS: 5, fps: 24, resolution: "768x512" },
        civitaiBaseModels: [],
        files: [
          vfile("unet", "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", 21.5, "Lightricks/LTX-2.5", true),
          vfile("clip", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", 15.4, "Lightricks/LTX-2.5", true),
          vfile("vae", "ltx-2.5-video-vae-bf16.safetensors", 0.4, "Lightricks/LTX-2.5", true),
          vfile("vae", "ltx-2.5-audio-vae-bf16.safetensors", 0.2, "Lightricks/LTX-2.5", true),
        ],
        modes: ["t2v", "i2v"],
        audio: true,
        volume: "image-studio-video",
        limits: { maxDurationS: 10, resolutions: ["768x512", "1280x720"], fpsOptions: [24, 25] },
      },
    ]);

const allModels = (): RegistryModel[] => [...models, ...videoModels];
const isVideoModel = (m: RegistryModel) => videoModels.includes(m);
const profileOfModel = (id: string): GpuProfile => (videoModels.some((m) => m.id === id) ? "video" : "image");

/** Filenames present on the fake volumes (image and video filenames don't overlap). */
const present = new Set<string>();
for (const id of ["chroma", "zimage", "qwen"]) {
  for (const f of models.find((m) => m.id === id)!.files) present.add(f.filename);
}
for (const m of videoModels) if (m.id === "h3" || params.has("videoInstalled")) for (const f of m.files) present.add(f.filename);
const loraFiles = new Set<string>();

const modelTasks = new Map<string, Task>();
const loraTasks = new Map<string, Task>();
const taskCancel = new Set<string>();
const jobCancel = new Set<string>();
const activeJobs = new Map<string, Job>();

const jobProfile = (j: Job): GpuProfile => (j.kind === "video" ? "video" : "image");
const taskProfile = (t: Task): GpuProfile => (t.target.type === "model" ? profileOfModel(t.target.id) : "image");
const taskLive = (t: Task) => t.status === "queued" || t.status === "running";

// App-side auto-stop, per profile: idleMinutes with no jobs or tasks while that GPU runs.
window.setInterval(() => {
  for (const p of PROFILES) {
    const gpu = gpus[p];
    if (!podMode() || gpu.status !== "running") continue;
    const busy =
      [...activeJobs.values()].some((j) => jobProfile(j) === p) ||
      [...modelTasks.values(), ...loraTasks.values()].some((t) => taskLive(t) && taskProfile(t) === p);
    if (busy) lastActivity[p] = Date.now();
    else if (Date.now() - lastActivity[p] >= gpu.idleMinutes * MINUTE_MS) stopGpuInternal(p, "idle").catch(() => {});
  }
}, 1000);

const checkedAt: Record<GpuProfile, number> = { image: Date.now() - 1000 * 60 * 60 * 5, video: Date.now() - 1000 * 60 * 60 * 2 };
let warmUntil = 0;

const refs = new Map<string, string>();
const loras: Omit<Lora, "present" | "task">[] = [
  {
    id: "lora_film",
    name: "Analog Film Grain",
    modelId: "flux2",
    source: "civitai",
    sourceUrl: "https://civitai.com/models/111111/analog-film",
    filename: "analog_film_grain_v2.safetensors",
    sizeBytes: 164 * 1024 ** 2,
    triggerWords: ["analog film", "kodak portra 400", "film grain"],
  },
  {
    id: "lora_ink",
    name: "Sumi Ink Wash",
    modelId: "chroma",
    source: "huggingface",
    sourceUrl: "https://huggingface.co/someone/sumi-ink/blob/main/sumi_ink_chroma.safetensors",
    filename: "sumi_ink_chroma.safetensors",
    sizeBytes: 228 * 1024 ** 2,
    triggerWords: ["sumi-e", "ink wash painting"],
  },
];
for (const l of loras) loraFiles.add(l.filename);

const images: ImageRecord[] = [];

// ---------- events ----------

const listeners = new Map<string, Set<(p: unknown) => void>>();
function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
  const copy = structuredClone(payload);
  listeners.get(event)?.forEach((fn) => fn(copy));
}

// ---------- GPU pod ----------

/** One auto-stop "minute" (?fastIdle makes it 2 s so the auto-stop can be watched). */
const MINUTE_MS = params.has("fastIdle") ? 2000 : 60_000;
const START_PHASES = ["Creating pod", "Waiting for machine", "Pulling image", "Booting ComfyUI"];
const PHASE_MS = 1250; // ~5 s from Start to running

function initialGpu(profile: GpuProfile, running: boolean): GpuState {
  return running
    ? {
        profile,
        status: "running",
        podId: `mockpod_leftover_${profile}`,
        gpuType: GPU_TYPE,
        startedAt: new Date(Date.now() - (profile === "video" ? 9 : 23) * 60_000).toISOString(),
        costPerHr: GPU_COST,
        phase: null,
        error: null,
        idleMinutes: settings.idleMinutes,
        leftRunning: true,
        stopReason: null,
        watchdogArmed: params.has("noWatchdog") ? false : true,
      }
    : {
        profile,
        status: "stopped",
        podId: null,
        gpuType: null,
        startedAt: null,
        costPerHr: null,
        phase: null,
        error: null,
        idleMinutes: settings.idleMinutes,
        leftRunning: false,
        stopReason: null,
      };
}

const gpus: Record<GpuProfile, GpuState> = {
  image: initialGpu("image", params.has("gpuRunning")),
  video: initialGpu("video", params.has("videoRunning")),
};
// Bumped on every start/stop so a stale start sequence gives up.
const gpuRun: Record<GpuProfile, number> = { image: 0, video: 0 };
const lastActivity: Record<GpuProfile, number> = { image: Date.now(), video: Date.now() };

const podMode = () => settings.backend === "pod";
const asProfile = (v: unknown): GpuProfile => (v === "video" ? "video" : "image");

function setGpu(p: GpuProfile, patch: Partial<GpuState>) {
  gpus[p] = { ...gpus[p], ...patch, profile: p };
  emit("gpu-update", gpus[p]);
}

function startGpuInternal(p: GpuProfile) {
  const gpu = gpus[p];
  if (gpu.status === "starting" || gpu.status === "running" || gpu.status === "stopping") return;
  const run = ++gpuRun[p];
  setGpu(p, {
    status: "starting",
    podId: uid("pod"),
    gpuType: GPU_TYPE,
    costPerHr: GPU_COST,
    startedAt: null,
    phase: START_PHASES[0],
    error: null,
    leftRunning: false,
    stopReason: null,
  });
  void (async () => {
    for (let i = 1; i <= START_PHASES.length; i++) {
      await sleep(PHASE_MS);
      if (run !== gpuRun[p] || gpus[p].status !== "starting") return;
      if (i < START_PHASES.length) {
        setGpu(p, { phase: START_PHASES[i] });
      } else if (params.has("gpuFail")) {
        setGpu(p, { status: "error", phase: null, error: "ComfyUI didn't become healthy within 10 minutes (simulated by ?gpuFail). The pod is still there." });
      } else {
        lastActivity[p] = Date.now();
        setGpu(p, { status: "running", phase: null, startedAt: new Date().toISOString(), watchdogArmed: !params.has("noWatchdog") });
      }
    }
  })();
}

async function stopGpuInternal(p: GpuProfile, reason: "user" | "idle" | "external") {
  const status = () => gpus[p].status;
  if (status() === "stopped") return;
  if (status() === "stopping") {
    while (status() === "stopping") await sleep(100);
    return;
  }
  gpuRun[p]++;
  setGpu(p, { status: "stopping", phase: null });
  await sleep(1500);
  if (params.has("stopFail")) {
    const error = "Couldn't stop the GPU pod — it may still be billing. Press Stop to try again. (simulated by ?stopFail)";
    setGpu(p, { status: "error", error });
    throw new Error(error);
  }
  // Terminating the pod ends whatever was running on it (only this profile's work).
  activeJobs.forEach((j) => jobProfile(j) === p && jobCancel.add(j.jobId));
  for (const t of [...modelTasks.values(), ...loraTasks.values()]) if (taskLive(t) && taskProfile(t) === p) taskCancel.add(t.taskId);
  loadedModels[p].clear(); // a new pod starts with empty GPU memory
  setGpu(p, { status: "stopped", podId: null, gpuType: null, costPerHr: null, startedAt: null, phase: null, error: null, leftRunning: false, stopReason: reason, watchdogArmed: null });
}

/** Like the Rust core: quitting must be confirmed while any pod may be billing. */
const mayBill = (g: GpuState) => g.status === "starting" || g.status === "running" || g.status === "stopping" || (g.status === "error" && !!g.podId);
const quitNeedsConfirm = () => podMode() && PROFILES.some((p) => mayBill(gpus[p]));

(window as unknown as { mockQuit: () => void }).mockQuit = () => {
  if (quitNeedsConfirm()) emit("quit-requested", PROFILES.map((p) => gpus[p]));
  else console.info("[mock] No GPU pod is billing — the app would quit now.");
};

/**
 * Pod backend: make sure the profile's GPU is running, auto-starting it when stopped (like the Rust core).
 * `onPhase` sees each boot phase; resolves once running, throws if it ends stopped/in error.
 */
async function ensureGpuReady(p: GpuProfile, onPhase?: (phase: string) => void, aborted?: () => boolean) {
  const status = () => gpus[p].status;
  if (!podMode() || status() === "running") return;
  while (status() === "stopping") await sleep(100);
  startGpuInternal(p);
  let last: string | null = null;
  while (status() === "starting" && !aborted?.()) {
    const phase = gpus[p].phase;
    if (phase && phase !== last) onPhase?.((last = phase));
    await sleep(100);
  }
  if (aborted?.()) return;
  if (status() !== "running") throw new Error(gpus[p].error ?? "The GPU pod stopped before it was ready.");
}

// ---------- helpers ----------

function modelView(m: RegistryModel): ModelView {
  const video = isVideoModel(m);
  const peers = video ? videoModels : models;
  const files = m.files.map((f) => ({
    ...f,
    present: present.has(f.filename),
    sharedWith: peers.filter((o) => o.id !== m.id && o.files.some((g) => g.folder === f.folder && g.filename === f.filename)).map((o) => o.id),
  }));
  const task = modelTasks.get(m.id) ?? null;
  return {
    ...m,
    kind: video ? "video" : "image",
    files,
    installed: files.every((f) => f.present),
    presentBytes: files.filter((f) => f.present).reduce((a, f) => a + f.sizeBytes, 0),
    totalBytes: files.reduce((a, f) => a + f.sizeBytes, 0),
    task: task && (task.status === "queued" || task.status === "running") ? task : null,
  };
}

function loraView(l: (typeof loras)[number]): Lora {
  const t = loraTasks.get(l.id) ?? null;
  return { ...l, present: loraFiles.has(l.filename), task: t && (t.status === "queued" || t.status === "running") ? t : null };
}

function usedBytes(p: GpuProfile) {
  let used = 0;
  const seen = new Set<string>();
  for (const m of p === "video" ? videoModels : models)
    for (const f of m.files)
      if (present.has(f.filename) && !seen.has(f.filename)) {
        seen.add(f.filename);
        used += f.sizeBytes;
      }
  if (p === "image") for (const l of loras) if (loraFiles.has(l.filename)) used += l.sizeBytes ?? 0;
  return used;
}

function volume(p: GpuProfile) {
  const totalBytes = (p === "video" ? 150 : 100) * GB;
  return { totalBytes, freeBytes: totalBytes - usedBytes(p) - (p === "video" ? 0.4 : 3.2) * GB };
}

function snapshot(p: GpuProfile): StatusSnapshot {
  return { profile: p, models: allModels().map(modelView), volume: volume(p), checkedAt: new Date(checkedAt[p]).toISOString() };
}

function emitStatus(p: GpuProfile) {
  emit("status-update", snapshot(p));
}

/** Shared-file delete rule (mirror of the Rust pure function). */
function computeDelete(id: string): DeletePreview {
  const models = allModels();
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model ${id}`);
  const deleteFiles: string[] = [];
  const keptFiles: KeptFile[] = [];
  let freedBytes = 0;
  for (const f of m.files) {
    if (!present.has(f.filename)) continue;
    const others = models.filter((y) => y.id !== id && y.files.some((g) => g.filename === f.filename));
    const blocking = others.filter((y) => {
      const otherFilesPresent = y.files.some((g) => g.filename !== f.filename && present.has(g.filename));
      const t = modelTasks.get(y.id);
      const busy = !!t && (t.status === "queued" || t.status === "running");
      return otherFilesPresent || busy;
    });
    if (blocking.length === 0) {
      deleteFiles.push(f.filename);
      freedBytes += f.sizeBytes;
    } else {
      const y = blocking[0];
      const t = modelTasks.get(y.id);
      const busy = !!t && (t.status === "queued" || t.status === "running");
      keptFiles.push({
        filename: f.filename,
        reason: busy ? `Shared with ${y.name}, which is downloading` : `Shared with ${y.name}, which is still installed`,
      });
    }
  }
  return { deleteFiles, freedBytes, keptFiles };
}

function requireConfigured() {
  if (!settings.hasApiKey) throw new Error("RunPod API key is not set. Add it in Settings.");
  if (settings.backend === "serverless" && !settings.endpointId)
    throw new Error("RunPod endpoint ID is not set. Add it in Settings (needed for the serverless backend).");
}

async function runDownloadTask(task: Task, files: { filename: string; sizeBytes: number }[], done: (f: string) => void) {
  const total = files.reduce((a, f) => a + f.sizeBytes, 0);
  task.totalBytes = total;
  try {
    await ensureGpuReady(taskProfile(task), undefined, () => taskCancel.has(task.taskId)); // stays "queued" while the GPU starts
  } catch (e) {
    return finishTask(task, "failed", e instanceof Error ? e.message : String(e));
  }
  await sleep(600);
  if (taskCancel.has(task.taskId)) return finishTask(task, "cancelled");
  task.status = "running";
  emit("task-update", task);
  const rate = Math.max(total / 9, 1); // ~9 s overall
  for (const f of files) {
    task.file = f.filename;
    let got = 0;
    while (got < f.sizeBytes) {
      await sleep(200);
      if (taskCancel.has(task.taskId)) return finishTask(task, "cancelled");
      const step = Math.min(f.sizeBytes - got, rate / 5);
      got += step;
      task.bytes += step;
      emit("task-update", task);
    }
    done(f.filename);
  }
  finishTask(task, "completed");
}

function finishTask(task: Task, status: Task["status"], error: string | null = null) {
  task.status = status;
  task.error = error;
  emit("task-update", task);
  // Like the Rust core: refresh the status cache after a download/delete finishes.
  if (status === "completed") {
    const p = taskProfile(task);
    checkedAt[p] = Date.now();
    emitStatus(p);
  }
}

function nextSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

function makeImage(input: {
  model: string;
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
  seed: number;
  steps: number;
  cfg: number;
  references: string[];
  loras: { name: string; strength: number }[];
  createdAt: number;
  delayMs: number;
  executionMs: number;
  /** img2img: start image path and strength; size = the start image's 1 MP / ×16 size. */
  initImage?: string | null;
  denoise?: number | null;
  size?: [number, number] | null;
}): ImageRecord {
  const [width, height] = input.size ?? aspect[input.aspectRatio] ?? [1024, 1024];
  const m = models.find((x) => x.id === input.model);
  return {
    id: uid("img"),
    path: placeholderImage({ width, height, seed: input.seed, prompt: input.prompt, label: m?.name ?? input.model }),
    model: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    aspectRatio: input.aspectRatio,
    width,
    height,
    seed: input.seed,
    steps: input.steps,
    cfg: input.cfg,
    references: input.references,
    loras: input.loras,
    createdAt: new Date(input.createdAt).toISOString(),
    durationMs: input.delayMs + input.executionMs + 400,
    runpod: { delayMs: input.delayMs, executionMs: input.executionMs },
    initImage: input.initImage ?? null,
    denoise: input.initImage ? (input.denoise ?? 0.6) : null,
    kind: "image",
  };
}

/** "1280x720" → [1280, 720]; falls back to 1280×720. */
function resolutionSize(res: string): [number, number] {
  const m = res.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : [1280, 720];
}

function makeVideo(input: {
  model: string;
  prompt: string;
  negativePrompt: string;
  resolution: string;
  durationS: number;
  fps: number;
  audio: boolean;
  seed: number;
  steps: number;
  cfg: number;
  createdAt: number;
  delayMs: number;
  executionMs: number;
  initImage?: string | null;
}): ImageRecord {
  const [width, height] = resolutionSize(input.resolution);
  const m = videoModels.find((x) => x.id === input.model);
  const id = uid("vid");
  return {
    id,
    // Not loadable in a browser: the UI falls back to the poster ("Preview unavailable in mock").
    path: `mock-video://${id}.mp4`,
    posterPath: placeholderImage({ width, height, seed: input.seed, prompt: input.prompt, label: `▶ ${m?.name ?? input.model}`, scale: 4 }),
    kind: "video",
    model: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    aspectRatio: input.resolution,
    width,
    height,
    seed: input.seed,
    steps: input.steps,
    cfg: input.cfg,
    references: [],
    loras: [],
    createdAt: new Date(input.createdAt).toISOString(),
    durationMs: input.delayMs + input.executionMs + 400,
    runpod: { delayMs: input.delayMs, executionMs: input.executionMs },
    initImage: input.initImage ?? null,
    denoise: null,
    durationS: input.durationS,
    fps: input.fps,
    hasAudio: input.audio,
  };
}

/** Mirror of worker/src/workflows.py init_image_size: 1 MP, sides rounded to ×16, clamped 64–4096. */
function initImageSize(w: number, h: number): [number, number] {
  const scale = Math.sqrt((1024 * 1024) / (w * h));
  const side = (v: number) => Math.min(4096, Math.max(64, Math.round((v * scale) / 16) * 16));
  return [side(w), side(h)];
}

/** Pixel size of a start image (data URL or path); falls back to square. */
function loadImageSize(src: string): Promise<[number, number]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : [1024, 1024]);
    img.onerror = () => resolve([1024, 1024]);
    img.src = src;
  });
}

// Seed gallery
if (!params.has("empty")) {
  const prompts = [
    "A lighthouse on a basalt cliff at blue hour, long exposure, mist over the sea",
    "Portrait of an elderly watchmaker in his workshop, warm tungsten light, shallow depth of field",
    "Isometric cutaway of a tiny greenhouse library, soft pastel palette",
    "Neon-lit ramen stall in the rain, reflections on wet asphalt, cinematic",
    "Macro photo of frost crystals on a red maple leaf",
    "Brutalist concert hall interior, morning light through clerestory windows",
    "A fox in a snowy birch forest, sumi-e ink wash painting",
    "Retro travel poster for a city on Mars, bold flat shapes",
  ];
  const ar = ["1:1", "3:4", "16:9", "2:3", "4:3", "9:16", "3:2"];
  const ms = ["chroma", "zimage", "qwen", "flux2"];
  let t = Date.now() - 1000 * 60 * 30;
  for (let i = 0; i < 40; i++) {
    const model = ms[i % ms.length];
    const m = models.find((x) => x.id === model)!;
    const seed = hashString(`s${i}`) % 2 ** 31;
    images.push(
      makeImage({
        model,
        prompt: prompts[i % prompts.length],
        negativePrompt: m.supportsNegativePrompt ? m.defaults.negativePrompt : "",
        aspectRatio: ar[i % ar.length],
        seed,
        steps: m.defaults.steps || 30,
        cfg: m.defaults.cfg || 4,
        references: [],
        loras: model === "chroma" && i % 3 === 0 ? [{ name: "Sumi Ink Wash", strength: 0.8 }] : [],
        createdAt: t,
        delayMs: i % 5 === 0 ? 48_000 : 900,
        executionMs: 6_000 + (i % 4) * 3_100,
        // A few img2img examples (chroma/zimage), redrawn from an earlier tile.
        ...(m.supportsImg2Img && i % 8 === 5 && images.length
          ? { initImage: images[images.length - 1].path, denoise: 0.45, size: [1248, 832] as [number, number] }
          : {}),
      }),
    );
    t -= 1000 * 60 * (17 + i * 13);
  }
  // A few videos (spec v5) between the images, newest-first order kept.
  const vids = [
    { at: 1, model: "h3", prompt: "A paper boat drifting down a rain-soaked street, gentle camera follow", res: "1280x720", d: 5, fps: 24, audio: true },
    { at: 6, model: "ltx25", prompt: "Timelapse of clouds rolling over a mountain ridge at sunrise, wide shot", res: "768x512", d: 8, fps: 25, audio: false },
    { at: 13, model: "h3", prompt: "A street musician playing violin under a bridge, warm evening light, slow dolly in", res: "720x1280", d: 6, fps: 24, audio: true, i2v: true },
    { at: 22, model: "ltx25", prompt: "Waves crashing on black sand, drone pulling back", res: "1280x720", d: 4, fps: 24, audio: true },
    { at: 30, model: "h3", prompt: "Steam rising from a cup of coffee on a windowsill, rain outside", res: "1280x720", d: 3, fps: 24, audio: false },
  ];
  for (const v of vids) {
    if (v.at >= images.length) continue;
    const newer = Date.parse(images[v.at - 1].createdAt);
    const older = Date.parse(images[v.at].createdAt);
    const vm = videoModels.find((x) => x.id === v.model);
    const seed = hashString(`v${v.at}`) % 2 ** 31;
    images.splice(
      v.at,
      0,
      makeVideo({
        model: v.model,
        prompt: v.prompt,
        negativePrompt: "",
        resolution: v.res,
        durationS: v.d,
        fps: v.fps,
        audio: v.audio,
        seed,
        steps: vm?.defaults.steps ?? 30,
        cfg: vm?.defaults.cfg ?? 5,
        createdAt: Math.round((newer + older) / 2),
        delayMs: 1200,
        executionMs: 95_000 + v.d * 14_000,
        initImage: v.i2v ? images[v.at].path : null,
      }),
    );
  }
}

// ---------- generate progress (mirror of worker/src/handler.py StageTracker) ----------

const STAGE_PHASE: Record<string, string> = {
  loading_text_encoder: "loading",
  encoding_prompt: "loading",
  loading_model: "loading",
  preparing_init_image: "loading",
  preparing_references: "loading",
  sampling: "sampling",
  decoding: "saving",
  video_decoding: "saving",
  audio_decoding: "saving",
  encoding_video: "saving",
  saving: "saving",
};

/** Models whose weights the simulated GPU holds (the 2nd run of a model reports cached loaders). */
const loadedModels: Record<GpuProfile, Set<string>> = { image: new Set(), video: new Set() };

/** Sleeps in small slices; false if the job was cancelled meanwhile. */
async function pause(ms: number, cancelled: () => boolean): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled()) return false;
    await sleep(Math.min(150, end - Date.now()));
  }
  return !cancelled();
}

/** v2 worker progress: stage checklist, elapsed times, cached loaders. */
async function runStages(job: Job, input: GenerateInput, steps: number, cold: boolean, cancelled: () => boolean): Promise<boolean | "failed"> {
  const warm = loadedModels.image.has(input.model);
  const refsUsed = input.referenceIds.length > 0;
  const initUsed = !!input.initImageId;
  const stages = [
    "loading_text_encoder",
    "encoding_prompt",
    "loading_model",
    ...(initUsed ? ["preparing_init_image"] : []),
    ...(refsUsed ? ["preparing_references"] : []),
    "sampling",
    "decoding",
    "saving",
  ];
  const cachedStages = warm ? ["loading_text_encoder", "loading_model"] : [];
  const t0 = Date.now();
  const times: Record<string, number> = {};
  let stage = stages[0];
  let stageStart = t0;
  let step = 0;
  const send = () => {
    const now = Date.now();
    job.progress = {
      phase: STAGE_PHASE[stage],
      stage,
      stages,
      step,
      totalSteps: steps,
      elapsedMs: now - t0,
      stageElapsedMs: now - stageStart,
      cached: cachedStages.length > 0,
      cachedStages,
      stageTimes: { ...times },
    };
    emit("job-update", job);
  };
  const enter = (next: string) => {
    const now = Date.now();
    times[stage] = (times[stage] ?? 0) + (now - stageStart);
    stage = next;
    stageStart = now;
    if (next === "decoding" || next === "saving") step = steps;
    send();
  };
  // Like the 1 s status poll: a heartbeat while a stage runs.
  const hold = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await pause(Math.min(1000, end - Date.now()), cancelled))) return false;
      send();
    }
    return true;
  };
  send();
  if (!warm) {
    if (!(await hold(cold ? 3200 : 2400))) return false;
    enter("encoding_prompt");
    if (!(await hold(900))) return false;
    enter("loading_model");
    if (!(await hold(cold ? 6500 : 4800))) return false;
  } else {
    enter("encoding_prompt");
    if (!(await hold(400))) return false;
  }
  if (input.prompt.toLowerCase().includes("fail")) return "failed";
  loadedModels.image.add(input.model);
  if (initUsed) {
    enter("preparing_init_image");
    if (!(await hold(500))) return false;
  }
  if (refsUsed) {
    enter("preparing_references");
    if (!(await hold(700))) return false;
  }
  enter("sampling");
  const perStep = Math.max(80, 7000 / steps);
  for (let s = 1; s <= steps; s++) {
    // The first step also moves the weights onto the GPU.
    if (!(await pause(s === 1 && !warm ? perStep * 4 : perStep * (0.85 + Math.random() * 0.3), cancelled))) return false;
    step = s;
    send();
  }
  enter("decoding");
  if (!(await hold(600))) return false;
  enter("saving");
  return hold(300);
}

/** v1 worker progress (?v1progress): phase + step only, as before the stage fields. */
async function runPhasesV1(job: Job, input: GenerateInput, steps: number, cold: boolean, cancelled: () => boolean): Promise<boolean | "failed"> {
  job.progress = { phase: "loading", step: 0, totalSteps: steps };
  emit("job-update", job);
  if (!(await pause(cold ? 900 : 250, cancelled))) return false;
  if (input.prompt.toLowerCase().includes("fail")) return "failed";
  for (let s = 1; s <= steps; s++) {
    if (cancelled()) return false;
    job.progress = { phase: "sampling", step: s, totalSteps: steps };
    emit("job-update", job);
    await sleep(Math.max(60, 2400 / steps));
  }
  job.progress = { phase: "saving", step: steps, totalSteps: steps };
  emit("job-update", job);
  return pause(300, cancelled);
}

// ---------- jobs ----------

async function runJob(jobId: string, input: GenerateInput) {
  const m = models.find((x) => x.id === input.model)!;
  const steps = input.steps || m.defaults.steps || 30;
  const cfg = input.cfg ?? (m.defaults.cfg || 4);
  const baseSeed = input.seed ?? nextSeed();
  const initPath = input.initImageId ? (refs.get(input.initImageId) ?? null) : null;
  const initSize = initPath ? initImageSize(...(await loadImageSize(initPath))) : null;
  const job: Job = { jobId, kind: "image", status: "queued", total: input.count, completed: 0, progress: null, images: [], error: null };
  const cancelled = () => jobCancel.has(jobId);
  const stop = (status: Job["status"], error: string | null = null) => {
    job.status = status;
    job.error = error;
    job.progress = null;
    activeJobs.delete(jobId);
    emit("job-update", job);
  };
  activeJobs.set(jobId, job);
  emit("job-update", job);
  if (podMode() && gpus.image.status !== "running") {
    // GPU boot: status "starting" + progress.phase = the pod phase.
    job.status = "starting";
    try {
      await ensureGpuReady("image", (phase) => {
        job.progress = { phase, step: null, totalSteps: null };
        emit("job-update", job);
      }, cancelled);
    } catch (e) {
      return stop("failed", e instanceof Error ? e.message : String(e));
    }
    if (cancelled()) return stop("cancelled");
    job.progress = null;
  }
  await sleep(300);

  for (let k = 0; k < input.count; k++) {
    if (cancelled()) return stop("cancelled");
    // Serverless only: a cold worker. A running pod is always warm.
    const cold = !podMode() && Date.now() > warmUntil;
    const startedAt = Date.now();
    if (cold) {
      job.status = "starting";
      job.progress = null;
      emit("job-update", job);
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        if (cancelled()) return stop("cancelled");
      }
    }
    const delayMs = Date.now() - startedAt + (cold ? 41_000 : 0);
    job.status = "running";
    const execStart = Date.now();
    const ok = params.has("v1progress")
      ? await runPhasesV1(job, input, steps, cold, cancelled)
      : await runStages(job, input, steps, cold, cancelled);
    if (ok === "failed") return stop("failed", "Worker error: CUDA out of memory (simulated — prompt contains 'fail').");
    if (!ok) return stop("cancelled");
    const lorasUsed = input.loras.map((l) => ({ name: loras.find((x) => x.id === l.loraId)?.name ?? l.loraId, strength: l.strength }));
    const rec = makeImage({
      model: input.model,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? "",
      aspectRatio: input.aspectRatio,
      seed: (baseSeed + k) % 2 ** 32,
      steps,
      cfg,
      references: input.referenceIds.map((id) => refs.get(id) ?? "").filter(Boolean),
      loras: lorasUsed,
      initImage: initPath,
      denoise: initPath ? Math.min(1, Math.max(0.05, input.denoise ?? 0.6)) : null,
      size: initSize,
      createdAt: Date.now(),
      delayMs,
      executionMs: Date.now() - execStart + 1200,
    });
    images.unshift(rec);
    job.images = [...job.images, rec];
    job.completed = k + 1;
    warmUntil = Date.now() + 20_000;
    emit("job-update", job);
  }
  stop("completed");
}

/** Video stage checklist (same progress shape as runStages). */
async function runVideoStages(job: Job, input: GenerateVideoInput, steps: number, cancelled: () => boolean): Promise<boolean | "failed"> {
  const warm = loadedModels.video.has(input.model);
  const initUsed = !!(input.initImageId || input.initImageGalleryId);
  const stages = [
    "loading_text_encoder",
    "encoding_prompt",
    "loading_model",
    ...(initUsed ? ["preparing_init_image"] : []),
    "sampling",
    "video_decoding",
    ...(input.audio ? ["audio_decoding"] : []),
    "encoding_video",
    "saving",
  ];
  const cachedStages = warm ? ["loading_text_encoder", "loading_model"] : [];
  const t0 = Date.now();
  const times: Record<string, number> = {};
  let stage = stages[0];
  let stageStart = t0;
  let step = 0;
  const send = () => {
    const now = Date.now();
    job.progress = {
      phase: STAGE_PHASE[stage],
      stage,
      stages,
      step,
      totalSteps: steps,
      elapsedMs: now - t0,
      stageElapsedMs: now - stageStart,
      cached: cachedStages.length > 0,
      cachedStages,
      stageTimes: { ...times },
    };
    emit("job-update", job);
  };
  const enter = (next: string) => {
    const now = Date.now();
    times[stage] = (times[stage] ?? 0) + (now - stageStart);
    stage = next;
    stageStart = now;
    if (next !== "sampling" && stages.indexOf(next) > stages.indexOf("sampling")) step = steps;
    send();
  };
  const hold = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await pause(Math.min(1000, end - Date.now()), cancelled))) return false;
      send();
    }
    return true;
  };
  send();
  if (!warm) {
    if (!(await hold(3000))) return false;
    enter("encoding_prompt");
    if (!(await hold(1200))) return false;
    enter("loading_model");
    if (!(await hold(5000))) return false;
  } else {
    enter("encoding_prompt");
    if (!(await hold(600))) return false;
  }
  if (input.prompt.toLowerCase().includes("fail")) return "failed";
  loadedModels.video.add(input.model);
  if (initUsed) {
    enter("preparing_init_image");
    if (!(await hold(700))) return false;
  }
  enter("sampling");
  const perStep = Math.max(250, 9000 / steps);
  for (let s = 1; s <= steps; s++) {
    if (!(await pause(perStep * (0.85 + Math.random() * 0.3), cancelled))) return false;
    step = s;
    send();
  }
  enter("video_decoding");
  if (!(await hold(1800))) return false;
  if (input.audio) {
    enter("audio_decoding");
    if (!(await hold(700))) return false;
  }
  enter("encoding_video");
  if (!(await hold(1100))) return false;
  enter("saving");
  return hold(400);
}

async function runVideoJob(jobId: string, input: GenerateVideoInput) {
  const m = videoModels.find((x) => x.id === input.model)!;
  const steps = input.steps || m.defaults.steps || 30;
  const cfg = input.cfg ?? m.defaults.cfg ?? 5;
  const seed = input.seed ?? nextSeed();
  // Gallery start image: read in place (the record's own file), like the Rust core.
  const initPath = input.initImageGalleryId
    ? (images.find((x) => x.id === input.initImageGalleryId)?.path ?? null)
    : input.initImageId
      ? (refs.get(input.initImageId) ?? null)
      : null;
  const job: Job = { jobId, kind: "video", status: "queued", total: 1, completed: 0, progress: null, images: [], error: null };
  const cancelled = () => jobCancel.has(jobId);
  const stop = (status: Job["status"], error: string | null = null) => {
    job.status = status;
    job.error = error;
    job.progress = null;
    activeJobs.delete(jobId);
    emit("job-update", job);
  };
  activeJobs.set(jobId, job);
  emit("job-update", job);
  const queuedAt = Date.now();
  if (podMode() && gpus.video.status !== "running") {
    job.status = "starting";
    try {
      await ensureGpuReady("video", (phase) => {
        job.progress = { phase, step: null, totalSteps: null };
        emit("job-update", job);
      }, cancelled);
    } catch (e) {
      return stop("failed", e instanceof Error ? e.message : String(e));
    }
    if (cancelled()) return stop("cancelled");
    job.progress = null;
  }
  await sleep(300);
  if (cancelled()) return stop("cancelled");
  const delayMs = Date.now() - queuedAt;
  job.status = "running";
  const execStart = Date.now();
  const ok = await runVideoStages(job, input, steps, cancelled);
  if (ok === "failed") return stop("failed", "Worker error: CUDA out of memory while sampling video (simulated — prompt contains 'fail').");
  if (!ok) return stop("cancelled");
  const rec = makeVideo({
    model: input.model,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? "",
    resolution: input.resolution,
    durationS: input.durationS,
    fps: input.fps,
    audio: input.audio,
    seed,
    steps,
    cfg,
    createdAt: Date.now(),
    delayMs,
    executionMs: Date.now() - execStart + 1200,
    initImage: initPath,
  });
  images.unshift(rec);
  job.images = [rec];
  job.completed = 1;
  emit("job-update", job);
  stop("completed");
}

// ---------- commands ----------

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const commands: Record<string, Handler> = {
  get_settings: () => ({ ...settings }),
  save_settings: async (a) => {
    const i = a as SaveSettingsInput;
    await sleep(250);
    if (i.idleMinutes !== undefined && (!Number.isInteger(i.idleMinutes) || i.idleMinutes < 5 || i.idleMinutes > 240))
      throw new Error("Auto-stop must be between 5 and 240 minutes.");
    if (i.apiKey !== undefined) settings.hasApiKey = i.apiKey.length > 0;
    if (i.endpointId !== undefined) settings.endpointId = i.endpointId.trim() || null;
    if (i.civitaiKey !== undefined) settings.hasCivitaiKey = i.civitaiKey.length > 0;
    if (i.backend !== undefined) settings.backend = i.backend;
    if (i.passApiKeyToPod !== undefined) settings.passApiKeyToPod = i.passApiKeyToPod;
    if (i.idleMinutes !== undefined) {
      settings.idleMinutes = i.idleMinutes;
      for (const p of PROFILES) setGpu(p, { idleMinutes: i.idleMinutes });
    }
    return { ...settings };
  },
  test_connection: async (): Promise<ConnectionTest> => {
    await sleep(900);
    const none = { workers: { idle: 0, running: 0 }, jobs: { inQueue: 0, inProgress: 0 } };
    if (settings.backend === "serverless") {
      if (!settings.hasApiKey || !settings.endpointId) return { ok: false, ...none, target: "serverless", error: "Missing API key or endpoint ID" };
      const busy = Date.now() < warmUntil;
      return { ok: true, workers: { idle: busy ? 1 : 0, running: busy ? 1 : 0 }, jobs: { inQueue: 0, inProgress: 0 }, target: "serverless" };
    }
    if (!settings.hasApiKey) return { ok: false, ...none, target: "api", error: "Missing RunPod API key" };
    if (gpus.image.status === "running") {
      const n = [...activeJobs.values()].filter((j) => jobProfile(j) === "image").length;
      return {
        ok: true,
        workers: { idle: n ? 0 : 1, running: n ? 1 : 0 },
        jobs: { inQueue: Math.max(0, n - 1), inProgress: Math.min(n, 1) },
        target: "pod",
        ready: true,
        gpu: GPU_TYPE,
        message: "GPU pod is up and ComfyUI is ready",
      };
    }
    return { ok: true, ...none, target: "api", message: "API key OK — GPU is stopped" };
  },
  get_gpu_state: (a) => ({ ...gpus[asProfile(a.profile)] }),
  list_gpu_states: () => PROFILES.map((p) => ({ ...gpus[p] })),
  start_gpu: async (a) => {
    const p = asProfile(a.profile);
    if (!settings.hasApiKey) throw new Error("RunPod API key is not set. Add it in Settings.");
    await sleep(200);
    startGpuInternal(p);
    return { ...gpus[p] };
  },
  stop_gpu: async (a) => {
    const p = asProfile(a.profile);
    await stopGpuInternal(p, "user");
    return { ...gpus[p] };
  },
  confirm_quit: async (a) => {
    if (a.stopGpu) {
      const results = await Promise.allSettled(PROFILES.map((p) => stopGpuInternal(p, "user")));
      for (const p of PROFILES) while (gpus[p].status === "stopping") await sleep(100);
      const failed = PROFILES.filter((p) => gpus[p].status !== "stopped");
      if (failed.length) {
        const err = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        throw new Error(
          gpus[failed[0]].error ?? (err?.reason instanceof Error ? err.reason.message : null) ?? `The ${failed.join(" and ")} GPU pod could not be stopped; it may still be billing`,
        );
      }
    }
    console.info(`[mock] The app would quit now${a.stopGpu ? " (all GPUs stopped)" : " (GPUs left running)"}.`);
  },
  list_models: () => allModels().map(modelView),
  refresh_status: async (a) => {
    const p = asProfile(a.profile);
    requireConfigured();
    await ensureGpuReady(p);
    await sleep(2200);
    checkedAt[p] = Date.now();
    emitStatus(p);
    return snapshot(p);
  },
  get_status: (a) => snapshot(asProfile(a.profile)),
  list_jobs: () => [...activeJobs.values()],

  download_model: async (a) => {
    requireConfigured();
    const id = String(a.id);
    const m = allModels().find((x) => x.id === id);
    if (!m) throw new Error(`Unknown model ${id}`);
    const existing = modelTasks.get(id);
    if (existing && (existing.status === "queued" || existing.status === "running")) return existing;
    const missing = m.files.filter((f) => !present.has(f.filename));
    const task: Task = { taskId: uid("task"), kind: "download", target: { type: "model", id }, status: "queued", bytes: 0, totalBytes: 0, file: null, error: null };
    modelTasks.set(id, task);
    void runDownloadTask(task, missing, (f) => present.add(f));
    return { ...task, totalBytes: missing.reduce((s, f) => s + f.sizeBytes, 0) };
  },
  cancel_task: (a) => {
    taskCancel.add(String(a.taskId));
  },
  delete_preview: async (a) => {
    await sleep(150);
    return computeDelete(String(a.id));
  },
  delete_model: async (a) => {
    requireConfigured();
    const id = String(a.id);
    const plan = computeDelete(id);
    if (!plan.deleteFiles.length) return { freedBytes: 0, keptFiles: plan.keptFiles, task: null };
    const task: Task = { taskId: uid("task"), kind: "delete", target: { type: "model", id }, status: "queued", bytes: 0, totalBytes: plan.freedBytes, file: plan.deleteFiles.join(", "), error: null };
    modelTasks.set(id, task);
    void (async () => {
      try {
        await ensureGpuReady(taskProfile(task), undefined, () => taskCancel.has(task.taskId));
      } catch (e) {
        return finishTask(task, "failed", e instanceof Error ? e.message : String(e));
      }
      await sleep(500);
      task.status = "running";
      emit("task-update", task);
      await sleep(1400);
      plan.deleteFiles.forEach((f) => present.delete(f));
      task.bytes = plan.freedBytes;
      finishTask(task, "completed");
    })();
    return { freedBytes: plan.freedBytes, keptFiles: plan.keptFiles, task: { ...task } };
  },

  resolve_lora_link: async (a): Promise<ResolvedLora> => {
    const url = String(a.url).trim();
    await sleep(700);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("That doesn't look like a link.");
    }
    if (u.hostname.endsWith("civitai.com")) {
      const id = url.match(/models\/(\d+)/)?.[1] ?? url.match(/modelVersionId=(\d+)/)?.[1];
      if (!id) throw new Error("Couldn't find a Civitai model or version id in that link.");
      const pool = [
        { name: "Cinematic Teal & Orange", baseModel: "Flux.2 Klein 9B", trig: ["cinematic color grade", "teal and orange"] },
        { name: "Paper Cutout Diorama", baseModel: "Chroma", trig: ["papercut", "layered paper diorama"] },
        { name: "Product Shot Studio", baseModel: "Qwen Image 2.1", trig: ["studio product photo"] },
        { name: "SDXL Pixel Art", baseModel: "SDXL 1.0", trig: ["pixel art"] },
      ];
      const p = pool[Number(id) % pool.length];
      const suggested = models.find((m) => m.civitaiBaseModels.includes(p.baseModel))?.id ?? null;
      return {
        source: "civitai",
        name: p.name,
        downloadUrl: `https://civitai.com/api/download/models/${Number(id) + 1000}`,
        filename: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.safetensors`,
        sizeBytes: 150 * 1024 ** 2 + (Number(id) % 7) * 37 * 1024 ** 2,
        baseModel: p.baseModel,
        ...(suggested ? { suggestedModelId: suggested } : {}),
        triggerWords: p.trig,
      };
    }
    if (u.hostname.endsWith("huggingface.co")) {
      if (!/\/(blob|resolve)\//.test(u.pathname) || !u.pathname.endsWith(".safetensors"))
        throw new Error("Hugging Face links must point to a .safetensors file (…/blob/main/x.safetensors).");
      const filename = u.pathname.split("/").pop()!;
      return {
        source: "huggingface",
        name: filename.replace(/\.safetensors$/, "").replace(/[_-]+/g, " "),
        downloadUrl: url.replace("/blob/", "/resolve/"),
        filename,
        sizeBytes: 312 * 1024 ** 2,
        sha256: "0".repeat(64),
        triggerWords: [],
      };
    }
    throw new Error("Only Hugging Face and Civitai links are supported.");
  },
  add_lora: async (a) => {
    requireConfigured();
    const i = a as unknown as AddLoraInput;
    await sleep(300);
    const name = i.name?.trim() || i.url.split("/").pop()?.replace(/\.safetensors$/, "") || "LoRA";
    const filename = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.safetensors`;
    const l = {
      id: uid("lora"),
      name,
      modelId: i.modelId,
      source: (i.url.includes("civitai") ? "civitai" : "huggingface") as Lora["source"],
      sourceUrl: i.url,
      filename,
      sizeBytes: 180 * 1024 ** 2,
      triggerWords: i.triggerWords ?? [],
    };
    loras.unshift(l);
    const task: Task = { taskId: uid("task"), kind: "download", target: { type: "lora", id: l.id }, status: "queued", bytes: 0, totalBytes: l.sizeBytes, file: filename, error: null };
    loraTasks.set(l.id, task);
    void runDownloadTask(task, [{ filename, sizeBytes: l.sizeBytes }], (f) => loraFiles.add(f));
    return loraView(l);
  },
  list_loras: () => loras.map(loraView),
  delete_lora: async (a) => {
    requireConfigured();
    if (!loras.some((l) => l.id === a.id)) throw new Error("LoRA not found");
    const t = loraTasks.get(String(a.id));
    if (t) taskCancel.add(t.taskId);
    await ensureGpuReady("image");
    await sleep(500);
    const idx = loras.findIndex((l) => l.id === a.id);
    if (idx < 0) throw new Error("LoRA not found");
    loraFiles.delete(loras[idx].filename);
    loras.splice(idx, 1);
    return null; // removed immediately
  },

  import_reference: async (a) => {
    const path = String(a.path);
    await sleep(120);
    const refId = uid("ref");
    refs.set(refId, path);
    return { refId, thumbPath: path };
  },
  import_reference_bytes: async (a) => {
    await sleep(120);
    const dataUrl = `data:${String(a.mime)};base64,${String(a.base64)}`;
    const refId = uid("ref");
    refs.set(refId, dataUrl);
    return { refId, thumbPath: dataUrl };
  },
  generate: (a) => {
    requireConfigured();
    const i = a as unknown as GenerateInput;
    const m = models.find((x) => x.id === i.model);
    if (!m) throw new Error(`Unknown model ${i.model}`);
    const missing = m.files.filter((f) => !present.has(f.filename)).map((f) => f.filename);
    if (missing.length) throw new Error(`MODEL_NOT_INSTALLED: ${missing.join(", ")}`);
    if (i.referenceIds.length > m.maxReferences) throw new Error(`${m.name} accepts at most ${m.maxReferences} references.`);
    if (i.loras.length > 3) throw new Error("At most 3 LoRAs per generation.");
    if (i.initImageId && !m.supportsImg2Img) throw new Error(`${m.name} does not take a start image`);
    if (i.initImageId && !refs.has(i.initImageId)) throw new Error("The start image is missing; please add it again");
    const jobId = uid("job");
    void runJob(jobId, i);
    return { jobId };
  },
  generate_video: (a) => {
    requireConfigured();
    const i = a as unknown as GenerateVideoInput;
    const m = videoModels.find((x) => x.id === i.model);
    if (!m) throw new Error(models.some((x) => x.id === i.model) ? `${i.model} is not a video model` : `Unknown video model ${i.model}`);
    const missing = m.files.filter((f) => !present.has(f.filename)).map((f) => f.filename);
    if (missing.length) throw new Error(`MODEL_NOT_INSTALLED: ${missing.join(", ")}`);
    if (!i.prompt?.trim()) throw new Error("Write a prompt first.");
    if ((i.initImageId || i.initImageGalleryId) && !(m.modes ?? []).includes("i2v")) throw new Error(`${m.name} does not take a start image`);
    if (i.initImageId && i.initImageGalleryId) throw new Error("Pass either initImageId or initImageGalleryId, not both.");
    if (i.initImageId && !refs.has(i.initImageId)) throw new Error("The start image is missing; please add it again");
    if (i.initImageGalleryId) {
      const rec = images.find((x) => x.id === i.initImageGalleryId);
      if (!rec) throw new Error("That gallery image no longer exists; please choose another start image");
      if (rec.kind === "video") throw new Error("A video can't be a start image; choose an image");
    }
    const lim = m.limits!;
    if (!Number.isFinite(i.durationS) || i.durationS < 1 || i.durationS > lim.maxDurationS)
      throw new Error(`Duration must be between 1 and ${lim.maxDurationS} seconds.`);
    if (!lim.resolutions.map(resolutionId).includes(i.resolution)) throw new Error(`${m.name} doesn't support resolution ${i.resolution}.`);
    if (!lim.fpsOptions.includes(i.fps)) throw new Error(`${m.name} doesn't support ${i.fps} fps.`);
    if (i.audio && !m.audio) throw new Error(`${m.name} doesn't generate audio.`);
    const jobId = uid("job");
    void runVideoJob(jobId, i);
    return { jobId };
  },
  cancel_job: (a) => {
    jobCancel.add(String(a.jobId));
  },
  list_images: async (a): Promise<ImagePage> => {
    await sleep(250);
    const limit = Number(a.limit) || 30;
    const before = typeof a.before === "number" ? a.before : null;
    const all = before == null ? images : images.filter((im) => Date.parse(String(im.createdAt)) < before);
    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextBefore: all.length > limit && last ? Date.parse(String(last.createdAt)) : null };
  },
  delete_image: async (a) => {
    await sleep(150);
    const idx = images.findIndex((im) => im.id === a.id);
    if (idx >= 0) images.splice(idx, 1);
  },
  export_image: async (a) => {
    const im = images.find((x) => x.id === a.id);
    if (!im) throw new Error("Image not found");
    if (im.kind === "video") {
      console.info(`[mock] The .mp4 for ${im.id} would be saved to ${String(a.destPath)}.`);
      return;
    }
    const link = document.createElement("a");
    link.href = im.path;
    link.download = String(a.destPath).split("/").pop() || "image.jpg";
    link.click();
  },
};

export function createMockBackend(): Backend {
  console.info("[Image Studio] Running with the in-memory dev mock (not inside Tauri).");
  return {
    isMock: true,
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      const h = commands[cmd];
      if (!h) throw new Error(`[mock] Unknown command: ${cmd}`);
      await sleep(30);
      try {
        return structuredClone(await h(args)) as T;
      } catch (e) {
        // The Rust core rejects with a plain string.
        throw e instanceof Error ? e.message : String(e);
      }
    },
    async listen(event, handler): Promise<Unlisten> {
      // A fresh wrapper per call (like Tauri's per-listen ids): registering the same handler twice
      // (React StrictMode re-running an effect) must not let the first unlisten remove the second.
      const fn = (p: unknown) => (handler as (p: unknown) => void)(p);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    async pickSavePath(defaultName) {
      return `~/Downloads/${defaultName}`;
    },
    async pickImagePaths() {
      return null; // use the browser <input type=file>
    },
    async onFileDrop() {
      return () => {}; // DOM drag-and-drop handles files in the browser
    },
  };
}
