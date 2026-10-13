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
// video model's files are present; default: MiniMax H3 and H3 Character installed, LTX-2.5 not). Video records'
// `path` is `mock-video://<id>.mp4`, which the browser can't load, so the UI shows the poster.
//
// Vault (spec v6): by default no vault exists (first use: "Create vault" migrates the gallery).
// ?vault — a vault already exists (password "password123", locked) holding a few items;
// ?fastLock — an auto-lock "minute" lasts 5 s. Wrong passwords reject with WRONG_PASSWORD;
// unlocking waits ~1 s like Argon2. Vault media are data URLs here (vault:// in the app); a
// vault reference's refId is a vault://localhost/… URL like the core's, its thumbPath a data URL.
//
// GPU-start audit (for walking the "confirm before a paid GPU start" flows): `window.mockStats`
// counts every pod start per profile and every command that would start a stopped pod
// (generate, generate_video, download_model, delete_model, add_lora, delete_lora,
// refresh_status, start_gpu, and the Stories render_shot, render_story, approve_take);
// `window.mockStats.reset()` zeroes it.
//
// Stories (spec 2026-10-13): characters, stories and shots live in memory. ?storyDemo seeds two
// characters (Mara, Ivo) with placeholder reference images; ?llm=down makes the local LLM
// (LM Studio) unreachable, so plan_story and llm_status show the "start LM Studio" hint. plan_story
// returns a canned plan after 1.5 s (a brief containing "invalid" gets a 3 s first shot, to see
// validation errors). Shot renders run as normal h3ref video jobs; their takes and the assembled
// film stay out of the gallery. Vault characters and stories (with ?vault) vanish from the lists
// while the mock vault is locked; opening or changing one then answers VAULT_LOCKED.
//
// Quit flow: a browser tab can't intercept closing with an in-app dialog, so call
// `window.mockQuit()` from the console to simulate ⌘Q (`quit-requested` when a pod
// may be billing); `confirm_quit` then logs instead of exiting.

import registry from "../../../shared/models.json";
import type { Backend, Unlisten } from "./backend";
import { hashString, placeholderImage } from "./placeholder";
import type {
  AddLoraInput,
  ApproveResult,
  Character,
  LlmStatus,
  PlanProgress,
  RenderAllResult,
  RenderedShot,
  StoryPatch,
  Shot,
  Story,
  StoryIssue,
  StoryView,
  Voice,
  ConnectionTest,
  KeyCheck,
  KeyTestReport,
  DeletePreview,
  Destination,
  MigrationProgress,
  VaultStatus,
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
  // Serverless was removed (UX-016): like the core, a legacy ?serverless still runs as the pod backend.
  backend: "pod",
  gpuType: GPU_TYPE,
  gpuTypes: [GPU_TYPE, "NVIDIA RTX PRO 4500 Blackwell", "NVIDIA GeForce RTX 4090", "NVIDIA RTX PRO 4000 Blackwell"],
  volumeNames: ["image-studio-models"],
  passApiKeyToPod: true,
  fallbackCostPerHr: GPU_COST,
  workerRef: "main",
  podImage: "ghcr.io/algotradingfervid/image-studio-runtime:latest",
  videoGpuTypes: ["NVIDIA H200", GPU_TYPE, "NVIDIA H100 80GB HBM3"],
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
for (const m of videoModels) if (m.id === "h3" || m.id === "h3ref" || params.has("videoInstalled")) for (const f of m.files) present.add(f.filename);
/** LoRA files on the image volume, keyed like the core's (folder loras/<modelId>, filename): the same
 * file added for two models is two files, so deleting one entry never removes the other's (UI-011). */
const loraFiles = new Set<string>();
const loraKey = (l: { modelId: string; filename: string }) => `loras/${l.modelId}/${l.filename}`;

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
for (const l of loras) loraFiles.add(loraKey(l));

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
/** Like the Rust core (UX-014/047): why each pod was started, and whether a generation ran on it. */
const gpuOrigin: Record<GpuProfile, "user" | "job" | "task" | null> = { image: null, video: null };
const gpuServed: Record<GpuProfile, boolean> = { image: false, video: false };

const podMode = () => settings.backend === "pod";
const asProfile = (v: unknown): GpuProfile => (v === "video" ? "video" : "image");

function setGpu(p: GpuProfile, patch: Partial<GpuState>) {
  gpus[p] = { ...gpus[p], ...patch, profile: p };
  emit("gpu-update", gpus[p]);
}

/** See the header: what a Cancel in the start confirmation must never produce. */
const GPU_START_COMMANDS = new Set([
  "generate",
  "generate_video",
  "download_model",
  "delete_model",
  "add_lora",
  "delete_lora",
  "refresh_status",
  "start_gpu",
  "render_shot",
  "render_story",
  "approve_take",
]);
const mockStats = {
  gpuStarts: { image: 0, video: 0 } as Record<GpuProfile, number>,
  commands: [] as string[],
  reset() {
    mockStats.gpuStarts = { image: 0, video: 0 };
    mockStats.commands = [];
  },
};
(window as unknown as { mockStats: typeof mockStats }).mockStats = mockStats;

function startGpuInternal(p: GpuProfile, origin: "user" | "job" | "task" = "job") {
  const gpu = gpus[p];
  if (gpu.status === "starting" || gpu.status === "running" || gpu.status === "stopping") {
    if (origin === "user" && gpu.status !== "stopping") gpuOrigin[p] = "user";
    return;
  }
  gpuOrigin[p] = origin;
  gpuServed[p] = false;
  mockStats.gpuStarts[p]++;
  console.info(`[mock] Starting the ${p} GPU pod (start #${mockStats.gpuStarts[p]})`);
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

/**
 * Like the Rust core's `begin_release`: stop a pod started for a job/task when that work is gone
 * (nothing else on the profile, no generation ran on it). Returns the stop promise, or null.
 */
function releaseGpu(p: GpuProfile, reason: "cancelled" | "finished"): { costUsd?: number; done: Promise<boolean> } | null {
  const g = gpus[p];
  if (!podMode() && p === "image") return null;
  if (g.status !== "starting" && g.status !== "running") return null;
  if (gpuOrigin[p] !== "job" && gpuOrigin[p] !== "task") return null;
  if (gpuServed[p]) return null;
  const busy =
    [...activeJobs.values()].some((j) => jobProfile(j) === p) ||
    [...modelTasks.values(), ...loraTasks.values()].some((t) => taskLive(t) && taskProfile(t) === p);
  if (busy) return null;
  const started = g.startedAt ? Date.parse(g.startedAt) : null;
  const costUsd = started ? ((Date.now() - started) / 3_600_000) * (g.costPerHr ?? GPU_COST) : undefined;
  console.info(`[mock] Stopping the ${p} GPU: nothing uses the pod it was started for (${reason})`);
  const done = stopGpuInternal(p, reason).then(
    () => true,
    () => false,
  );
  return { costUsd, done };
}

/** Cancelled job / ended task: release the GPU and say so on it (two events, like the core). */
function releaseFor<T extends Job | Task>(item: T, p: GpuProfile, reason: "cancelled" | "finished", event: "job-update" | "task-update") {
  const rel = releaseGpu(p, reason);
  if (!rel) return;
  item.gpuRelease = { profile: p, state: "stopping", costUsd: rel.costUsd };
  emit(event, item as never);
  void rel.done.then((ok) => {
    item.gpuRelease = { profile: p, state: ok ? "stopped" : "failed", costUsd: rel.costUsd, ...(ok ? {} : { error: gpus[p].error ?? "Couldn't stop the GPU" }) };
    emit(event, { ...item } as never);
  });
}

async function stopGpuInternal(p: GpuProfile, reason: "user" | "idle" | "external" | "cancelled" | "finished") {
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
async function ensureGpuReady(p: GpuProfile, onPhase?: (phase: string) => void, aborted?: () => boolean, origin: "job" | "task" = "job") {
  const status = () => gpus[p].status;
  if (!podMode() || status() === "running") return;
  while (status() === "stopping") await sleep(100);
  startGpuInternal(p, origin);
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
  return { ...l, present: loraFiles.has(loraKey(l)), task: t && (t.status === "queued" || t.status === "running") ? t : null };
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
  if (p === "image") for (const l of loras) if (loraFiles.has(loraKey(l))) used += l.sizeBytes ?? 0;
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
  // Like the core (UX-043): files a queued/running delete will remove already count as gone,
  // and only downloads keep a shared file busy.
  const pendingDeletes = new Set<string>();
  for (const t of modelTasks.values())
    if (t.kind === "delete" && (t.status === "queued" || t.status === "running")) for (const fn of (t.file ?? "").split(", ")) if (fn) pendingDeletes.add(fn);
  const onVolume = (fn: string) => present.has(fn) && !pendingDeletes.has(fn);
  for (const f of m.files) {
    if (!onVolume(f.filename)) continue;
    const others = models.filter((y) => y.id !== id && y.files.some((g) => g.filename === f.filename));
    const blocking = others.filter((y) => {
      const otherFilesPresent = y.files.some((g) => g.filename !== f.filename && onVolume(g.filename));
      const t = modelTasks.get(y.id);
      const busy = !!t && t.kind === "download" && (t.status === "queued" || t.status === "running");
      return otherFilesPresent || busy;
    });
    if (blocking.length === 0) {
      deleteFiles.push(f.filename);
      freedBytes += f.sizeBytes;
    } else {
      const y = blocking[0];
      const t = modelTasks.get(y.id);
      const busy = !!t && t.kind === "download" && (t.status === "queued" || t.status === "running");
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
    await ensureGpuReady(taskProfile(task), undefined, () => taskCancel.has(task.taskId), "task"); // stays "queued" while the GPU starts
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
  releaseFor(task, taskProfile(task), "finished", "task-update");
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
  /** r2v character references (paths). */
  references?: string[];
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
    references: input.references ?? [],
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
    // Sizes each model really offers (shared/models.json), so "Use these settings" restores them as they are (UI-069).
    { at: 1, model: "h3", prompt: "A paper boat drifting down a rain-soaked street, gentle camera follow", res: "864x480", d: 5, fps: 24, audio: true },
    { at: 6, model: "ltx25", prompt: "Timelapse of clouds rolling over a mountain ridge at sunrise, wide shot", res: "896x512", d: 8, fps: 25, audio: false },
    { at: 13, model: "h3", prompt: "A street musician playing violin under a bridge, warm evening light, slow dolly in", res: "480x864", d: 6, fps: 24, audio: true, i2v: true },
    { at: 22, model: "ltx25", prompt: "Waves crashing on black sand, drone pulling back", res: "1280x704", d: 4, fps: 24, audio: true },
    { at: 30, model: "h3", prompt: "Steam rising from a cup of coffee on a windowsill, rain outside", res: "864x480", d: 3, fps: 24, audio: false },
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

// ---------- vault (spec v6) ----------

/** One auto-lock "minute" (?fastLock: 5 s). */
const VAULT_MINUTE_MS = params.has("fastLock") ? 5000 : 60_000;

const vault = {
  exists: false,
  unlocked: false,
  password: "",
  autoLockMinutes: 10,
  /** Sealed items (decrypted only while unlocked in the real core). */
  items: [] as ImageRecord[],
  migrating: false,
  /** Moves into / out of the vault running now (erase is refused meanwhile, like the core). */
  moving: 0,
  lastTouch: Date.now(),
};

const vaultStatus = (): VaultStatus => ({
  exists: vault.exists,
  unlocked: vault.unlocked,
  autoLockMinutes: vault.autoLockMinutes,
  itemCount: vault.unlocked ? vault.items.filter((x) => !x.storyId).length : null,
  migrationPending: vault.migrating && !vault.unlocked,
  autoLockMs: vault.autoLockMinutes * VAULT_MINUTE_MS,
});

function emitVault() {
  emit("vault-update", vaultStatus());
}

function lockVault() {
  if (!vault.unlocked) return;
  vault.unlocked = false;
  emitVault();
}

function requireUnlocked() {
  if (!vault.exists) throw new Error("NO_VAULT: Create a vault first.");
  if (!vault.unlocked) throw new Error("VAULT_LOCKED: Unlock the vault first.");
}

/** A vault start image needs the unlocked key (it is decrypted and sent to the pod). */
function checkVaultStart(id: string | undefined, destination: unknown, refIds: (string | undefined)[] = []) {
  if (destination === "vault" && !vault.exists) throw new Error("NO_VAULT: Create a vault first.");
  const vaultRefs = refIds.some((r) => !!r && r.startsWith("vault:"));
  if (destination !== "vault" && (id || vaultRefs)) throw new Error("A vault start image or reference can only be used when saving to the vault.");
  if (!id) return;
  requireUnlocked();
  const rec = vault.items.find((x) => x.id === id);
  if (!rec) throw new Error("That vault item no longer exists; please choose another start image");
  if (rec.kind === "video") throw new Error("A video can't be a start image; choose an image");
}

/** A record as the vault returns it: `vault: true` plus a grid thumbnail. */
const asVaultItem = (rec: ImageRecord): ImageRecord => ({ ...rec, vault: true, thumbPath: rec.kind === "video" ? (rec.posterPath ?? null) : rec.path });

function insertNewestFirst(list: ImageRecord[], rec: ImageRecord) {
  const t = Date.parse(rec.createdAt);
  const at = list.findIndex((x) => Date.parse(x.createdAt) < t);
  if (at < 0) list.push(rec);
  else list.splice(at, 0, rec);
}

/** A finished output goes to the gallery or is sealed into the vault (locked or not). */
function saveOutput(rec: ImageRecord, destination: Destination) {
  if (destination === "vault") {
    Object.assign(rec, asVaultItem(rec));
    vault.items.unshift(rec);
  } else {
    images.unshift(rec);
  }
}

/** One-time migration of every existing gallery record into the vault. */
async function runMigration() {
  vault.migrating = true;
  const total = images.length;
  const p: MigrationProgress = {
    phase: "encrypting",
    done: 0,
    total,
    counts: { images: 0, videos: 0, posters: 0, startImages: 0, references: 0 },
    errors: 0,
    error: null,
  };
  emit("vault-migration", p);
  while (images.length) {
    await sleep(total > 30 ? 90 : 160);
    p.phase = p.done % 3 === 2 ? "verifying" : "encrypting";
    const rec = images.shift()!;
    insertNewestFirst(vault.items, asVaultItem(rec));
    if (rec.kind === "video") p.counts.videos++;
    else p.counts.images++;
    if (rec.posterPath) p.counts.posters++;
    if (rec.initImage) p.counts.startImages++;
    p.counts.references += rec.references.length;
    p.done++;
    emit("vault-migration", p);
  }
  p.phase = "cleaning";
  emit("vault-migration", p);
  await sleep(600);
  p.phase = "done";
  vault.migrating = false;
  emit("vault-migration", p);
  emitVault();
}

// Auto-lock after N minutes without `vault_touch`.
window.setInterval(() => {
  if (vault.unlocked && Date.now() - vault.lastTouch >= vault.autoLockMinutes * VAULT_MINUTE_MS) {
    console.info("[mock] Vault auto-locked after inactivity.");
    lockVault();
  }
}, 1000);

// ?vault: a vault already exists (locked) with a few items moved in.
if (params.has("vault")) {
  vault.exists = true;
  vault.password = "password123";
  for (const rec of images.splice(2, 6)) vault.items.push(asVaultItem(rec));
}

(window as unknown as { mockLockVault: () => void }).mockLockVault = lockVault;

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
  const initUsed = !!(input.initImageId || input.initImageVaultId || input.initImageGalleryId);
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
  const initPath = input.initImageVaultId
    ? (vault.items.find((x) => x.id === input.initImageVaultId)?.path ?? null)
    : input.initImageGalleryId
      ? (images.find((x) => x.id === input.initImageGalleryId)?.path ?? null)
      : input.initImageId
        ? (refs.get(input.initImageId) ?? null)
        : null;
  const initSize = initPath ? initImageSize(...(await loadImageSize(initPath))) : null;
  const destination: Destination = input.destination === "vault" ? "vault" : "general";
  const job: Job = { jobId, kind: "image", status: "queued", total: input.count, completed: 0, progress: null, images: [], error: null, destination };
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
    if (cancelled()) {
      stop("cancelled");
      return releaseFor(job, "image", "cancelled", "job-update");
    }
    job.progress = null;
  }
  if (!cancelled()) gpuServed.image = true;
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
    saveOutput(rec, destination);
    job.images = [...job.images, rec];
    job.completed = k + 1;
    warmUntil = Date.now() + 20_000;
    emit("job-update", job);
    if (destination === "vault") emitVault();
  }
  stop("completed");
}

/** Video stage checklist (same progress shape as runStages). */
async function runVideoStages(job: Job, input: GenerateVideoInput, steps: number, cancelled: () => boolean): Promise<boolean | "failed"> {
  const warm = loadedModels.video.has(input.model);
  const initUsed = !!(input.initImageId || input.initImageGalleryId || input.initImageVaultId);
  const refsUsed = (input.referenceIds?.length ?? 0) > 0;
  const stages = [
    "loading_text_encoder",
    "encoding_prompt",
    "loading_model",
    ...(initUsed ? ["preparing_init_image"] : []),
    ...(refsUsed ? ["preparing_references"] : []),
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
  if (refsUsed) {
    enter("preparing_references");
    if (!(await hold(900))) return false;
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

/** `take`: a Stories shot render — the record is tagged and kept out of the gallery (`takes`). */
async function runVideoJob(jobId: string, input: GenerateVideoInput, take?: { storyId: string; shotId: string; label: string }) {
  const m = videoModels.find((x) => x.id === input.model)!;
  const steps = input.steps || m.defaults.steps || 30;
  const cfg = input.cfg ?? m.defaults.cfg ?? 5;
  const seed = input.seed ?? nextSeed();
  // Gallery start image: read in place (the record's own file), like the Rust core.
  const initPath = input.initImageVaultId
    ? (vault.items.find((x) => x.id === input.initImageVaultId)?.path ?? null)
    : input.initImageGalleryId
      ? (images.find((x) => x.id === input.initImageGalleryId)?.path ?? null)
      : input.initImageId
        ? (refs.get(input.initImageId) ?? null)
        : null;
  const destination: Destination = input.destination === "vault" ? "vault" : "general";
  const job: Job = { jobId, kind: "video", status: "queued", total: 1, completed: 0, progress: null, images: [], error: null, destination };
  if (take) job.label = take.label;
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
    if (cancelled()) {
      stop("cancelled");
      return releaseFor(job, "video", "cancelled", "job-update");
    }
    job.progress = null;
  }
  if (!cancelled()) gpuServed.video = true;
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
    references: (input.referenceIds ?? []).map((id) => refs.get(id) ?? "").filter(Boolean),
  });
  // Like save_video: a take whose shot was removed meanwhile is discarded.
  if (take && !shots.has(take.shotId)) return stop("failed", "The shot was removed while it rendered; its take was discarded");
  if (take) {
    rec.storyId = take.storyId;
    rec.shotId = take.shotId;
    // A vault story's take is sealed (works locked); its job-update is redacted while locked.
    if (destination === "vault") Object.assign(rec, asVaultItem(rec));
    takes.unshift(rec);
  } else saveOutput(rec, destination);
  job.images = destination === "vault" && !vault.unlocked ? [] : [rec];
  job.completed = 1;
  emit("job-update", job);
  if (destination === "vault") emitVault();
  stop("completed");
}

// ---------- commands ----------

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

// ---------- stories (spec 2026-10-13) ----------

const STORY_MODEL = "h3ref";
const STORY_FPS = 24;
const MIN_SHOT_S = 5;
const MAX_SHOT_S = 15;
const MAX_CAST_PER_SHOT = 2;
const WORDS_PER_S = 2.5;
const TOTAL_TOLERANCE = 0.15;
const MAX_REFS_PER_SHOT = 6;
const MAX_PROMPT_CHARS = 7000;
const LLM_DEFAULT_URL = "http://localhost:1234/v1";
const LLM_DEFAULT_MODEL = "qwen3.8-27b-uncensored-optiq";
const LM_STUDIO_HINT =
  "Could not reach the local LLM. Start LM Studio's server (Developer → Start server, or `lms server start`) and load a model.";
const STORY_RESOLUTION: Record<string, string> = { "16:9": "1344x768", "9:16": "768x1344", "1:1": "768x768" };

const characters = new Map<string, Character>();
const stories = new Map<string, Story>();
const shots = new Map<string, Shot>();
/** Story takes: video records with storyId + shotId, never in `images` (the gallery). */
const takes: ImageRecord[] = [];
/** Assembled story films: storyId set, shotId null; also never in `images`. */
const films: ImageRecord[] = [];
// ?planner=pod: plans run on the video GPU (fake GPU-start and model-load phases before writing).
const llm = { baseUrl: LLM_DEFAULT_URL, model: LLM_DEFAULT_MODEL, onPod: params.get("planner") === "pod" };
const llmDown = params.get("llm") === "down";

const nowIso = () => new Date().toISOString();

// Mirror of stories/validate.rs.
const MINOR_TERMS = new Set([
  "child", "children", "kid", "kids", "minor", "minors", "teen", "teens", "teenage", "teenager",
  "schoolgirl", "schoolboy", "underage", "preteen", "toddler", "infant", "baby", "loli", "shota",
]);
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function mentionsMinor(text: string): boolean {
  const w = words(text);
  if (w.some((x) => MINOR_TERMS.has(x))) return true;
  return w.some((x, i) => /^\d+$/.test(x) && Number(x) < 18 && ["year", "years", "yo", "yr", "yrs"].includes(w[i + 1] ?? ""));
}

const MAX_DELIVERY_WORDS = 15;

function validateStory(story: Story, list: Shot[], cast: Character[]): StoryIssue[] {
  const out: StoryIssue[] = [];
  const name = (id: string) => cast.find((c) => c.id === id)?.name ?? id;
  const storyIssue = (message: string) => out.push({ shot: null, message });
  for (const c of cast) {
    if (!c.adult) storyIssue(`${c.name} is not confirmed as an adult (18+)`);
    if (c.source === "real_person" && !c.consent) storyIssue(`${c.name} is a real person without a consent tick`);
    if (mentionsMinor(c.description)) storyIssue(`${c.name}'s description must describe an adult; stories use adults only`);
  }
  if (mentionsMinor(story.brief) || mentionsMinor(story.style)) storyIssue("The brief must describe adults only");
  if (!list.length) {
    storyIssue("The story has no shots");
    return out;
  }
  const total = list.reduce((n, s) => n + s.durationS, 0);
  if (total < story.targetS * (1 - TOTAL_TOLERANCE) || total > story.targetS * (1 + TOTAL_TOLERANCE))
    storyIssue(`Shots add up to ${total} s; the target is ${story.targetS} s (±15 %)`);
  list.forEach((s, i) => {
    const push = (message: string) => out.push({ shot: s.position, message });
    if (!(s.durationS >= MIN_SHOT_S && s.durationS <= MAX_SHOT_S)) push(`Duration ${s.durationS} s is outside 5–15 s`);
    if (!s.characters.length) push(`Shot ${s.position} needs at least one character`);
    if (s.characters.length > MAX_CAST_PER_SHOT) push(`${s.characters.length} characters; at most 2 per shot`);
    for (const c of s.characters) if (!story.cast.includes(c)) push(`${name(c)} is not in the cast`);
    const wordsTotal = s.dialogue.reduce((n, d) => n + words(d.line).length, 0);
    const maxWords = Math.floor(WORDS_PER_S * s.durationS);
    if (wordsTotal > maxWords) push(`Dialogue has ${wordsTotal} words; at most ${maxWords} fit in ${s.durationS} s`);
    for (const d of s.dialogue) if (!s.characters.includes(d.speaker)) push(`${name(d.speaker)} speaks but is not in this shot`);
    for (const d of s.dialogue) {
      const n = words(d.delivery ?? "").length;
      if (n > MAX_DELIVERY_WORDS) push(`Delivery is too long (${n} words; at most ${MAX_DELIVERY_WORDS})`);
    }
    if (s.dialogue.some((d) => d.line.includes('"') || (d.delivery ?? "").includes('"'))) push("Remove quotation marks from dialogue");
    if ([s.action, s.setting, s.camera].some(mentionsMinor) || s.dialogue.some((d) => mentionsMinor(d.line)))
      push("Stories use adults only; remove the reference to a minor");
    if (s.continuity === "continues") {
      if (i === 0) push("The first shot cannot continue a previous shot");
      else if (!s.characters.some((c) => list[i - 1].characters.includes(c))) push("Continues the previous shot but shares no character with it");
    }
    const nRefs = s.characters.reduce((n, id) => n + (cast.find((c) => c.id === id)?.refIds.length ?? 0), 0);
    if (nRefs > MAX_REFS_PER_SHOT) push(`${nRefs} reference images; at most 6 reference images per shot`);
  });
  return out;
}

// Mirror of stories/compile.rs (H3 five-block prompt, references in cast order).
const trimDot = (s: string) => s.trim().replace(/\.+$/, "");
function compileShot(story: Story, shot: Shot, cast: Character[]): { prompt: string; refIds: string[] } {
  const chars = story.cast.filter((id) => shot.characters.includes(id)).map((id) => cast.find((c) => c.id === id)).filter((c): c is Character => !!c);
  const lines = ["ROLES:"];
  const refIds: string[] = [];
  for (const c of chars) {
    const first = refIds.length + 1;
    refIds.push(...c.refIds);
    const tags = c.refIds.map((_, k) => `<Picture ${first + k}>`);
    const [verb, these] = tags.length === 1 ? ["is", "this picture"] : ["are", "these pictures"];
    lines.push(`${tags.join(", ")} ${verb} ${c.name}: ${trimDot(c.description)}. Keep ${c.name}'s face, hair, body and clothing identical to ${these}.`);
  }
  const name = (id: string) => cast.find((c) => c.id === id)?.name ?? id;
  lines.push(`SHOT (${shot.durationS} s, ${story.aspect}, ${shot.camera.trim()}): ${trimDot(shot.setting)}.`);
  lines.push(shot.action.trim());
  for (const d of shot.dialogue) lines.push(`${name(d.speaker)} says: "${d.line.trim()}"`);
  lines.push(`LOOK: ${story.style.trim() ? trimDot(story.style) : "natural cinematic look"}.`);
  lines.push("SOUND: natural ambient sound of the setting. Dialogue is spoken aloud and lip-synced to the speaker.");
  lines.push("LIMITS: Hold identity and clothing from the pictures. No subtitles, no on-screen text, no watermark, no extra people, no face morphing.");
  const prompt = lines.join("\n");
  if ([...prompt].length > MAX_PROMPT_CHARS)
    throw new Error(`Shot ${shot.position} compiles to ${[...prompt].length} characters; H3 takes at most 7,000`);
  return { prompt, refIds };
}

/** Vault characters and stories are visible (and usable) only while the mock vault is unlocked. */
const vaultVisible = () => vault.unlocked;
const visible = (x: { vault: boolean }) => !x.vault || vaultVisible();
const lockedError = (what: string) => new Error(`VAULT_LOCKED: Unlock the vault to ${what}`);

/** Mirror of repo::get_story: a vault story while locked answers VAULT_LOCKED. */
function getStoryOr(id: string): Story {
  const st = stories.get(id);
  if (!st) throw new Error("That story no longer exists");
  if (!visible(st)) throw lockedError("open this story");
  return st;
}
/** Mirror of repo::require_unlocked_story: the spec §8 copy for approve / assemble / plan. */
function requireStoryUnlocked(storyId: string, what: string) {
  const st = stories.get(storyId);
  if (st && !visible(st)) throw lockedError(what);
}
const storyShots = (storyId: string) => [...shots.values()].filter((s) => s.storyId === storyId).sort((a, b) => a.position - b.position);
const castOf = (story: Story): Character[] =>
  story.cast.map((id) => {
    const c = characters.get(id);
    if (!c) throw new Error("A cast character no longer exists");
    return c;
  });

function storyView(storyId: string): StoryView {
  const story = getStoryOr(storyId);
  const list = storyShots(storyId);
  const cast = castOf(story);
  const issues = list.length ? validateStory(story, list, cast) : [];
  for (const s of list) {
    try {
      compileShot(story, s, cast);
    } catch (e) {
      issues.push({ shot: s.position, message: e instanceof Error ? e.message : String(e) });
    }
  }
  const result = films.find((f) => f.id === story.resultImageId) ?? null;
  return { story, cast, shots: list, takes: takes.filter((t) => t.storyId === storyId), result, issues };
}

/** Mirror of repo::check_cast: a General story never casts a vault character; cast names differ. */
function checkStoreRules(story: Story) {
  const cast = castOf(story);
  if (!story.vault && cast.some((c) => c.vault)) throw new Error("A General story can't use a vault character. Create the story as a vault story.");
  const dup = cast.find((c, i) => cast.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase()) !== i);
  if (dup) throw new Error(`Two cast members are both named ${dup.name}. Rename one.`);
}

/** Plan / render refuse a cast that breaks the adult or consent rule (the Rust command checks the same). */
function checkCast(story: Story) {
  if (!story.cast.length) throw new Error("Add at least one character to the cast first");
  checkStoreRules(story);
  for (const c of castOf(story)) {
    if (!c.adult) throw new Error(`${c.name} is not confirmed as an adult (18+)`);
    if (c.source === "real_person" && !c.consent) throw new Error(`${c.name} is a real person without a consent tick`);
  }
}

function checkCharacter(c: Character) {
  const name = (c.name ?? "").trim();
  if (!name) throw new Error("Give the character a name");
  if ([...name].length > 40) throw new Error("The name is at most 40 characters");
  if ([...(c.description ?? "")].length > 200) throw new Error("The description is at most 200 characters");
  if (!c.description?.trim()) throw new Error("Describe the character in one line");
  if (!c.refIds?.length || c.refIds.length > 3) throw new Error("Add 1–3 reference images");
  if (c.refIds.some((id) => !refs.has(id))) throw new Error("A reference image is missing; please add it again");
  if (!c.adult) throw new Error(`${name} is not confirmed as an adult (18+)`);
  if (c.source === "real_person" && !c.consent) throw new Error(`${name} is a real person without a consent tick`);
  if (mentionsMinor(c.description)) throw new Error(`${name}'s description must describe an adult; stories use adults only`);
}

function checkStoryFields(f: { brief: string; targetS: number; aspect: string; style: string; cast: string[] }) {
  if (!Number.isInteger(f.targetS) || f.targetS < 30 || f.targetS > 180) throw new Error("The target length must be 30 s to 3 min");
  if (!STORY_RESOLUTION[f.aspect]) throw new Error(`Unknown aspect ${f.aspect}`);
  if ([...(f.style ?? "")].length > 300) throw new Error("The style line is at most 300 characters");
  if (f.cast.length > 2) throw new Error("A story has at most 2 characters");
  for (const id of f.cast) if (!characters.has(id)) throw new Error("A cast character no longer exists");
}

const issueText = (i: StoryIssue) => (i.shot != null && !i.message.startsWith(`Shot ${i.shot} `) ? `Shot ${i.shot}: ${i.message}` : i.message);

/** Mirror of `core.story_renders`: shot id → job id of a story render still running. */
const storyRenders = new Map<string, string>();
const isRenderingShot = (shotId: string) => {
  const job = storyRenders.get(shotId);
  if (job && !activeJobs.has(job)) storyRenders.delete(shotId);
  return storyRenders.has(shotId);
};
/** Delete / re-plan / removing a shot: refused while an affected shot renders. */
function refuseRendering(list: Shot[]) {
  const s = list.find((x) => isRenderingShot(x.id));
  if (s) throw new Error(`Wait for shot ${s.position} to finish rendering`);
}

/** Mirror of render.rs job_label (a vault story's names nothing of it). */
function storyJobLabel(story: Story, position: number): string {
  if (story.vault) return `Vault story · shot ${position}`;
  let name = story.title.trim();
  if (!name) {
    const brief = story.brief.trim();
    if ([...brief].length > 40) {
      const cut = [...brief].slice(0, 40).join("");
      const i = cut.lastIndexOf(" ");
      name = `${(i > 0 ? cut.slice(0, i) : cut).replace(/[ ,;:.]+$/, "")}…`;
    } else name = brief;
  }
  return `Story: ${name} · shot ${position}`;
}

/** The canned planner output: shot durations sum to the target, shot 1 cuts, shot 2 continues. */
function cannedPlan(story: Story): { title: string; logline: string; voices: Voice[]; shots: Shot[] } {
  const cast = castOf(story);
  const [a, b] = cast;
  const n = Math.max(4, Math.ceil(story.targetS / MAX_SHOT_S));
  const base = Math.floor(story.targetS / n);
  const extra = story.targetS - base * n;
  const durations = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  if (story.brief.toLowerCase().includes("invalid")) durations[0] = 3;
  const settings = ["rooftop at night, city lights below", "narrow stairwell, flickering light", "empty train platform at dawn", "small diner booth, rain on the window"];
  const cameras = ["wide shot, slow push-in", "medium close-up, handheld", "over-the-shoulder, static", "low angle, slow dolly left"];
  const lines = ["We leave tonight.", "Are you sure about this?", "I have never been more sure.", "Then let's not waste the dark."];
  const deliveries = ["turns toward the city and says quietly", "stops and answers with a tired half-smile", "looks straight ahead and says firmly", "leans in and says under the breath"];
  const sounds = [
    "Light rain patters on wet concrete while distant city traffic hums far below.",
    "Footsteps echo on metal stairs and a fluorescent tube buzzes overhead.",
    "A cold wind moves along the empty platform; a distant train horn sounds once.",
    "Rain taps on the window glass, cutlery clinks softly and a fridge hums behind the counter.",
  ];
  const voicePhrases = ["a low, steady voice with a calm pace", "a deep, slightly hoarse voice with a slow pace"];
  const voices: Voice[] = cast.map((c, i) => ({ characterId: c.id, voice: voicePhrases[i % voicePhrases.length] }));
  const list: Shot[] = durations.map((d, i) => {
    const pair = b && i % 2 === 1 ? [a.id, b.id] : [a.id];
    const speaker = pair[i % pair.length];
    const who = cast.find((c) => c.id === speaker)!.name;
    return {
      id: uid("shot"),
      storyId: story.id,
      position: i + 1,
      durationS: d,
      characters: pair,
      setting: settings[i % settings.length],
      camera: cameras[i % cameras.length],
      action: `${who} moves through the scene, looking around and reacting the whole time; the camera keeps moving with ${i === 0 ? "the opening" : "the action"}.`,
      dialogue: [{ speaker, delivery: deliveries[i % deliveries.length], line: lines[i % lines.length] }],
      sound: sounds[i % sounds.length],
      continuity: i === 1 ? "continues" : "cut",
      approvedTakeId: null,
    };
  });
  // Shot 2 continues shot 1, so it must share a character with it (it always has `a`).
  const brief = story.brief.trim();
  const first = brief ? brief.split(/[.!?\n]/)[0].trim() : "";
  // At most 48 characters, cut at a word boundary with an ellipsis.
  const cut = first.length > 48 ? first.slice(0, 48).replace(/\s+\S*$/, "").trim() + "…" : first;
  const title = cut || "Untitled story";
  return { title, logline: `${cast.map((c) => c.name).join(" and ")} — ${brief.slice(0, 120) || "a short story"}`, voices, shots: list };
}

function requireH3ref() {
  requireConfigured();
  const m = videoModels.find((x) => x.id === STORY_MODEL);
  if (!m) throw new Error(`Unknown video model ${STORY_MODEL}`);
  const missing = m.files.filter((f) => !present.has(f.filename)).map((f) => f.filename);
  if (missing.length) throw new Error(`MODEL_NOT_INSTALLED: ${missing.join(", ")}`);
}

function renderShotInternal(shotId: string): string {
  const shot = shots.get(shotId);
  if (!shot) throw new Error("That shot no longer exists");
  if (isRenderingShot(shotId)) throw new Error(`Shot ${shot.position} is already rendering`);
  const view = storyView(shot.storyId);
  checkCast(view.story);
  // Story-wide issues and this shot's own block it; another shot's don't.
  const issue = view.issues.find((i) => i.shot === null || i.shot === shot.position);
  if (issue) throw new Error(issueText(issue));
  const compiled = compileShot(view.story, shot, view.cast);
  if (!compiled.refIds.length) throw new Error(`Shot ${shot.position} has no character with reference images`);
  let initImageId: string | undefined;
  if (shot.continuity === "continues") {
    const prev = view.shots.find((s) => s.position + 1 === shot.position);
    if (!prev) throw new Error("The previous shot is missing");
    if (!prev.approvedTakeId) throw new Error(`Approve shot ${prev.position} first`);
    const take = takes.find((t) => t.id === prev.approvedTakeId);
    if (!take) throw new Error("The approved take's video is missing");
    // The core extracts the take's last frame with ffmpeg; the mock uses its poster.
    initImageId = uid("ref");
    refs.set(initImageId, take.posterPath ?? take.path);
  }
  requireH3ref();
  const input: GenerateVideoInput = {
    model: STORY_MODEL,
    prompt: compiled.prompt,
    referenceIds: compiled.refIds,
    initImageId,
    durationS: shot.durationS,
    fps: STORY_FPS,
    resolution: STORY_RESOLUTION[view.story.aspect],
    audio: true,
    destination: view.story.vault ? "vault" : "general",
  };
  const jobId = uid("job");
  // runVideoJob registers the job in activeJobs before its first await.
  storyRenders.set(shot.id, jobId);
  void runVideoJob(jobId, input, { storyId: shot.storyId, shotId: shot.id, label: storyJobLabel(view.story, shot.position) });
  return jobId;
}

const shotHasTakes = (shotId: string) => takes.some((t) => t.shotId === shotId);

function llmStatusNow(): LlmStatus {
  if (llm.onPod) return { baseUrl: "", model: "qwen3.8-27b-uncensored", reachable: true, models: [], error: null, onPod: true };
  const models = llmDown ? [] : [LLM_DEFAULT_MODEL, "qwen3-8b"];
  const model = models.length && !models.includes(llm.model) ? models[0] : llm.model;
  return { baseUrl: llm.baseUrl, model, reachable: !llmDown, models, error: llmDown ? LM_STUDIO_HINT : null, onPod: false };
}

function removeRecord(list: ImageRecord[], id: string) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}

if (params.has("storyDemo")) {
  const demo: [string, string, string][] = [
    ["Mara", "woman in her 30s, short black hair, green bomber jacket", "Portrait of Mara, short black hair, green bomber jacket"],
    ["Ivo", "man in his 40s, grey beard, navy wool coat", "Portrait of Ivo, grey beard, navy wool coat"],
  ];
  for (const [name, description, prompt] of demo) {
    const refIds = [0, 1].map((k) => {
      const id = uid("ref");
      refs.set(id, placeholderImage({ width: 768, height: 1024, seed: hashString(name) + k, prompt, label: name }));
      return id;
    });
    const id = uid("char");
    characters.set(id, { id, name, description, source: "generated", consent: false, adult: true, refIds, refPaths: [], vault: false, createdAt: nowIso(), updatedAt: nowIso() });
  }
}

/** Like the core: a display path next to each reference id ("" when it is gone); the mock's are data URLs. */
const withRefPaths = (c: Character): Character => ({ ...c, refPaths: c.refIds.map((id) => refs.get(id) ?? "") });

const storyCommands: Record<string, Handler> = {
  list_characters: () => [...characters.values()].filter(visible).sort((a, b) => a.name.localeCompare(b.name)).map(withRefPaths),
  save_character: (a) => {
    const c = a.character as Character;
    const old = c.id ? characters.get(c.id) : undefined;
    // Mirror of repo::save_character: the store is fixed (an existing character keeps its own).
    const inVault = old ? old.vault : !!c.vault;
    if (inVault && !vault.exists) throw new Error("NO_VAULT: Create the vault first (Gallery → Vault)");
    if (inVault && !vaultVisible()) throw lockedError(old ? "open this character" : "create a vault character");
    checkCharacter(c);
    if (!c.refIds.every((r) => r.startsWith("vault:") === inVault)) throw new Error("Reference images must be in the same place as the character");
    const name = c.name.trim();
    const clash = [...characters.values()].find((x) => x.id !== c.id && x.vault === inVault && x.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new Error(`A character named ${name} already exists`);
    const saved: Character = {
      ...c,
      vault: inVault,
      id: old?.id ?? uid("char"),
      name,
      description: c.description.trim(),
      consent: c.source === "real_person" && c.consent,
      createdAt: old?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    characters.set(saved.id, saved);
    return withRefPaths(saved);
  },
  delete_character: (a) => {
    const id = String(a.id);
    const c = characters.get(id);
    if (!c) return;
    if (c.vault && !vaultVisible()) throw lockedError("open this character");
    if (!c.vault && vault.exists && !vaultVisible()) throw new Error("Unlock the vault first: a vault story may use this character");
    const user = [...stories.values()].filter(visible).find((s) => s.cast.includes(id));
    if (user) throw new Error(`${c.name} is used by story "${user.title || user.brief.slice(0, 40)}"`);
    characters.delete(id);
  },
  list_stories: () => [...stories.values()].filter(visible).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  create_story: (a) => {
    const f = { brief: String(a.brief ?? ""), targetS: Number(a.targetS), aspect: String(a.aspect ?? ""), style: String(a.style ?? ""), cast: (a.cast as string[]) ?? [] };
    const inVault = a.destination === "vault";
    if (inVault && !vault.exists) throw new Error("NO_VAULT: Create the vault first (Gallery → Vault)");
    if (inVault && !vaultVisible()) throw lockedError("create a vault story");
    checkStoryFields(f);
    const story: Story = {
      id: uid("story"),
      title: "",
      logline: "",
      ...f,
      aspect: f.aspect as Story["aspect"],
      voices: [],
      status: "draft",
      resultImageId: null,
      vault: inVault,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    checkStoreRules(story);
    stories.set(story.id, story);
    return storyView(story.id);
  },
  update_story: (a) => {
    // Mirror of render::update_story: only the fields the patch sets are written.
    const id = String(a.id);
    const p = (a.patch ?? {}) as StoryPatch;
    const old = getStoryOr(id);
    if (p.aspect !== undefined && p.aspect !== old.aspect && takes.some((t) => t.storyId === id))
      throw new Error("Change the aspect before rendering; this story already has takes");
    const next: Story = { ...old };
    if (p.title !== undefined) next.title = p.title.trim();
    if (p.brief !== undefined) next.brief = p.brief.trim();
    if (p.targetS !== undefined) next.targetS = p.targetS;
    if (p.aspect !== undefined) next.aspect = p.aspect;
    if (p.style !== undefined) next.style = p.style.trim();
    if (p.cast !== undefined) next.cast = p.cast;
    // One non-empty phrase per cast member (drops the voices of characters who left).
    next.voices = (p.voices ?? old.voices)
      .map((v) => ({ characterId: v.characterId, voice: v.voice.trim() }))
      .filter((v, i, all) => v.voice && next.cast.includes(v.characterId) && all.findIndex((x) => x.characterId === v.characterId) === i);
    if (!next.brief) throw new Error("Write a brief first");
    if (!next.cast.length) throw new Error("Add at least one character to the cast first");
    checkStoryFields(next);
    checkStoreRules(next);
    stories.set(id, { ...next, updatedAt: nowIso() });
    return storyView(id);
  },
  delete_story: (a) => {
    const id = String(a.id);
    const story = stories.get(id);
    if (!story) return;
    if (!visible(story)) throw lockedError("open this story");
    refuseRendering(storyShots(id));
    for (const s of storyShots(id)) shots.delete(s.id);
    for (const t of takes.filter((t) => t.storyId === id)) removeRecord(takes, t.id);
    if (story.resultImageId) removeRecord(films, story.resultImageId);
    stories.delete(id);
  },
  get_story: (a) => storyView(String(a.id)),
  plan_story: async (a) => {
    requireStoryUnlocked(String(a.id), "plan the story");
    const story = getStoryOr(String(a.id));
    checkCast(story);
    if (!story.brief.trim()) throw new Error("Write a brief first");
    refuseRendering(storyShots(story.id));
    // ?planMs= stretches the fake LLM call (to exercise edits made while planning).
    const planMs = Number(params.get("planMs")) || 1500;
    const expectedTokens = story.targetS * 40;
    if (llm.onPod) {
      const steps: [PlanProgress["phase"], string][] = [
        ["gpu", "Creating pod"],
        ["gpu", "Pulling image"],
        ["download", "Downloading the planner model · 12.4 of 27.8 GB"],
        ["loading", "Loading the planner model"],
      ];
      for (const [i, [phase, detail]] of steps.entries()) {
        emit("story-plan-progress", { storyId: story.id, progress: { attempt: 0, maxAttempts: 0, tokens: 0, expectedTokens: 0, elapsedS: i * 30, phase, detail } });
        await sleep(planMs / 6);
      }
    }
    if (llm.onPod && llmDown) throw new Error("The planner model failed to start on the video GPU: out of memory");
    for (let i = 0; i <= 10; i++) {
      const phase = i === 0 ? "waiting" : "writing";
      emit("story-plan-progress", { storyId: story.id, progress: { attempt: 1, maxAttempts: 3, tokens: Math.round((expectedTokens * i) / 10), expectedTokens, elapsedS: Math.round((planMs * i) / 10000), phase } });
      await sleep(planMs / 11);
    }
    if (llmDown) throw new Error(LM_STUDIO_HINT);
    refuseRendering(storyShots(story.id));
    // The plan was only in memory: a vault that locked meanwhile loses it.
    if (!visible(story)) throw new Error("VAULT_LOCKED: The vault locked while planning; unlock and plan again");
    // Built on the story as stored now, not as it was when planning began.
    const latest = getStoryOr(story.id);
    const plan = cannedPlan(latest);
    // Re-planning replaces every shot; their takes go with them.
    for (const s of storyShots(story.id)) {
      shots.delete(s.id);
      for (const t of takes.filter((t) => t.shotId === s.id)) removeRecord(takes, t.id);
    }
    for (const s of plan.shots) shots.set(s.id, s);
    stories.set(story.id, { ...latest, title: plan.title, logline: plan.logline, voices: plan.voices, status: "planned", updatedAt: nowIso() });
    return storyView(story.id);
  },
  save_shots: (a) => {
    const storyId = String(a.storyId);
    const story = getStoryOr(storyId);
    const incoming = (a.shots as Shot[]) ?? [];
    // Removing a shot that is rendering is refused (nothing is changed).
    refuseRendering(storyShots(storyId).filter((s) => !incoming.some((x) => x.id === s.id)));
    const keep = new Set<string>();
    const text = (s: Shot) => JSON.stringify([s.durationS, s.characters, s.setting, s.camera, s.action, s.dialogue, s.sound, s.continuity]);
    incoming.forEach((s, i) => {
      const old = s.id ? shots.get(s.id) : undefined;
      const id = old && old.storyId === storyId ? old.id : uid("shot");
      const next: Shot = {
        ...s,
        id,
        storyId,
        position: i + 1,
        sound: s.sound ?? "",
        dialogue: (s.dialogue ?? []).map((d) => ({ ...d, delivery: d.delivery ?? "" })),
      };
      // Edited text: the approved take no longer matches the shot.
      if (old && text(old) !== text(next)) next.approvedTakeId = null;
      if (!old) next.approvedTakeId = null;
      shots.set(id, next);
      keep.add(id);
    });
    for (const s of storyShots(storyId)) {
      if (keep.has(s.id)) continue;
      shots.delete(s.id);
      for (const t of takes.filter((t) => t.shotId === s.id)) removeRecord(takes, t.id);
    }
    stories.set(storyId, { ...story, updatedAt: nowIso() });
    return storyView(storyId);
  },
  render_shot: (a) => ({ jobId: renderShotInternal(String(a.shotId)) }),
  render_story: (a): RenderAllResult => {
    // Mirror of render::render_story: a shot that can't render doesn't stop the others.
    const view = storyView(String(a.storyId));
    const out: RenderedShot[] = [];
    const errors: string[] = [];
    for (const s of view.shots) {
      const prevOk = s.continuity === "cut" || view.shots.some((p) => p.position + 1 === s.position && p.approvedTakeId);
      if (shotHasTakes(s.id) || isRenderingShot(s.id) || !prevOk) continue;
      try {
        out.push({ shotId: s.id, jobId: renderShotInternal(s.id) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg.startsWith("Shot ") ? msg : `Shot ${s.position}: ${msg}`);
      }
    }
    const error = !errors.length ? null : out.length ? `Queued ${out.length} shot(s); ${errors.join("; ")}` : errors.join("; ");
    return { queued: out, error };
  },
  approve_take: (a): ApproveResult => {
    const shotId = String(a.shotId);
    const takeId = String(a.takeId);
    const owner = shots.get(shotId);
    if (owner) requireStoryUnlocked(owner.storyId, "approve takes");
    const take = takes.find((t) => t.id === takeId);
    if (!take) throw new Error("That take no longer exists");
    if (take.shotId !== shotId) throw new Error("That take belongs to another shot");
    const shot = shots.get(shotId);
    if (!shot) throw new Error("That shot no longer exists");
    shots.set(shotId, { ...shot, approvedTakeId: takeId });
    let queued: RenderedShot | null = null;
    const next = storyShots(shot.storyId).find((s) => s.position === shot.position + 1);
    if (next && next.continuity === "continues" && !shotHasTakes(next.id)) queued = { shotId: next.id, jobId: renderShotInternal(next.id) };
    return { view: storyView(shot.storyId), queued };
  },
  assemble_story: async (a) => {
    const storyId = String(a.storyId);
    requireStoryUnlocked(storyId, "assemble the story");
    const view = storyView(storyId);
    if (!view.shots.length) throw new Error("The story has no shots");
    const approved = view.shots.map((s) => {
      if (!s.approvedTakeId) throw new Error(`Approve a take for shot ${s.position} first`);
      const t = takes.find((x) => x.id === s.approvedTakeId);
      if (!t) throw new Error("The approved take's video is missing");
      return t;
    });
    await sleep(1500); // ffmpeg concat + loudnorm
    const first = approved[0];
    const rec = makeVideo({
      model: STORY_MODEL,
      prompt: `Story: ${view.story.title || view.story.brief}`,
      negativePrompt: "",
      resolution: STORY_RESOLUTION[view.story.aspect],
      durationS: view.shots.reduce((n, s) => n + s.durationS, 0),
      fps: STORY_FPS,
      audio: true,
      seed: 0,
      steps: 0,
      cfg: 0,
      createdAt: Date.now(),
      delayMs: 0,
      executionMs: 0,
    });
    rec.storyId = storyId;
    rec.posterPath = first.posterPath ?? rec.posterPath;
    if (view.story.vault) Object.assign(rec, asVaultItem(rec));
    if (view.story.resultImageId) removeRecord(films, view.story.resultImageId);
    films.unshift(rec);
    stories.set(storyId, { ...view.story, status: "assembled", resultImageId: rec.id, updatedAt: nowIso() });
    return storyView(storyId);
  },
  llm_status: async () => {
    await sleep(300);
    return llmStatusNow();
  },
  save_planner_location: async (a) => {
    llm.onPod = !!a.onPod;
    await sleep(200);
    return llmStatusNow();
  },
  save_llm_settings: async (a) => {
    const url = typeof a.baseUrl === "string" ? a.baseUrl.trim().replace(/\/+$/, "") : "";
    const model = typeof a.model === "string" ? a.model.trim() : "";
    if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("The planner URL must start with http:// or https://");
    llm.baseUrl = url || LLM_DEFAULT_URL;
    llm.model = model || LLM_DEFAULT_MODEL;
    await sleep(300);
    return llmStatusNow();
  },
};

const commands: Record<string, Handler> = {
  get_settings: () => ({ ...settings, vaultAutoLockMinutes: vault.autoLockMinutes, settingsPath: "~/Library/Application Support/com.naren.imagestudio/settings.json" }),
  save_settings: async (a) => {
    const i = a as SaveSettingsInput;
    await sleep(250);
    if (i.idleMinutes !== undefined && (!Number.isInteger(i.idleMinutes) || i.idleMinutes < 5 || i.idleMinutes > 240))
      throw new Error("Auto-stop must be between 5 and 240 minutes.");
    if (i.apiKey !== undefined) settings.hasApiKey = i.apiKey.length > 0;
    if (i.endpointId !== undefined) settings.endpointId = i.endpointId.trim() || null;
    if (i.civitaiKey !== undefined) settings.hasCivitaiKey = i.civitaiKey.length > 0;
    // The backend is no longer a choice (UX-016): always the pod.
    if (i.passApiKeyToPod !== undefined) settings.passApiKeyToPod = i.passApiKeyToPod;
    if (i.idleMinutes !== undefined) {
      settings.idleMinutes = i.idleMinutes;
      for (const p of PROFILES) setGpu(p, { idleMinutes: i.idleMinutes });
    }
    return { ...settings };
  },
  reveal_logs: () => {
    const path = "~/Library/Logs/Image Studio/app.log";
    console.info(`[mock] Would show ${path} in Finder.`);
    return path;
  },
  log_ui: (a) => {
    console.info(`[mock log] ${a?.level}: ${a?.message}`);
  },
  reveal_image: (a) => {
    if (vault.items.some((x) => x.id === a.id) || films.some((x) => x.id === a.id && x.vault)) throw new Error("Vault films are exported, not shown in Finder");
    console.info(`[mock] Would show ${String(a.id)} in Finder.`);
  },
  reveal_settings_file: () => {
    const path = "~/Library/Application Support/com.naren.imagestudio/settings.json";
    console.info(`[mock] Would show ${path} in Finder.`);
    return path;
  },
  test_api_keys: async (a): Promise<KeyTestReport> => {
    await sleep(700);
    // Dev mock: a key containing "invalid"/"bad" is rejected; "offline" can't be reached.
    const check = (typed: unknown, saved: boolean, service: "runpod" | "civitai"): KeyCheck | null => {
      const t = typeof typed === "string" ? typed.trim() : "";
      if (!t && !saved) return null;
      const source = t ? "typed" : "saved";
      if (/offline/i.test(t)) return { ok: false, source, network: true, message: `Couldn't reach ${service === "runpod" ? "RunPod" : "Civitai"}: connection refused (mock)` };
      if (/invalid|bad/i.test(t))
        return {
          ok: false,
          source,
          network: false,
          message: service === "runpod" ? "RunPod rejected this key — check RunPod → Settings → API Keys" : "Civitai rejected this key — check civitai.com → Account settings → API keys",
        };
      return { ok: true, source, network: false, message: service === "civitai" ? "Key OK (signed in as mock-user)" : "Key OK" };
    };
    return { runpod: check(a.apiKey, settings.hasApiKey, "runpod"), civitai: check(a.civitaiKey, settings.hasCivitaiKey, "civitai") };
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
    startGpuInternal(p, "user");
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
    await ensureGpuReady(p, undefined, undefined, "task");
    await sleep(2200);
    checkedAt[p] = Date.now();
    emitStatus(p);
    releaseGpu(p, "finished"); // a pod started only for this Refresh stops again
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
        await ensureGpuReady(taskProfile(task), undefined, () => taskCancel.has(task.taskId), "task");
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
    // Like the core: the file keeps the resolved name (the Name is only a label), names are
    // at most 60 characters, and the same file can't be added twice for one model.
    if (name.length > 60) throw new Error("Keep the name to 60 characters or fewer");
    const resolved = (await commands.resolve_lora_link({ url: i.url })) as ResolvedLora;
    const filename = resolved.filename;
    const dup = loras.find((x) => x.modelId === i.modelId && x.filename === filename);
    if (dup) throw new Error(`Already in your library as “${dup.name}” for this model (same file ${filename})`);
    const l = {
      id: uid("lora"),
      name,
      modelId: i.modelId,
      source: (i.url.includes("civitai") ? "civitai" : "huggingface") as Lora["source"],
      sourceUrl: i.url,
      filename,
      // One size source: the resolved size the preview and GPU confirm showed (UI-053).
      sizeBytes: resolved.sizeBytes ?? 180 * 1024 ** 2,
      triggerWords: i.triggerWords ?? [],
    };
    loras.unshift(l);
    const task: Task = { taskId: uid("task"), kind: "download", target: { type: "lora", id: l.id }, status: "queued", bytes: 0, totalBytes: l.sizeBytes, file: filename, error: null };
    loraTasks.set(l.id, task);
    void runDownloadTask(task, [{ filename, sizeBytes: l.sizeBytes }], () => loraFiles.add(loraKey(l)));
    return loraView(l);
  },
  list_loras: () => loras.map(loraView),
  delete_lora: async (a) => {
    requireConfigured();
    if (!loras.some((l) => l.id === a.id)) throw new Error("LoRA not found");
    const t = loraTasks.get(String(a.id));
    if (t) taskCancel.add(t.taskId);
    // Like the core: a file that isn't on the volume (or that another entry uses) needs no GPU.
    const target = loras.find((l) => l.id === a.id)!;
    const needsGpu = loraFiles.has(loraKey(target)) && !loras.some((o) => o.id !== target.id && loraKey(o) === loraKey(target));
    if (needsGpu) {
      await ensureGpuReady("image", undefined, undefined, "task");
      await sleep(500);
    }
    const idx = loras.findIndex((l) => l.id === a.id);
    if (idx < 0) throw new Error("LoRA not found");
    // Only this entry's file; another entry keeps its own (UI-011).
    const row = loras[idx];
    if (!loras.some((o) => o.id !== row.id && loraKey(o) === loraKey(row))) loraFiles.delete(loraKey(row));
    loras.splice(idx, 1);
    if (needsGpu) releaseGpu("image", "finished"); // a pod started only for this delete stops again
    return null; // removed immediately
  },

  import_reference: async (a) => {
    const path = String(a.path);
    await sleep(120);
    // A vault:// path (a vault item's start image / reference) always re-imports into the vault.
    const dest = path.startsWith("vault:") || a.destination === "vault" ? "vault" : "general";
    return importRef(refs.get(path) ?? path, dest);
  },
  import_reference_bytes: async (a) => {
    await sleep(120);
    return importRef(`data:${String(a.mime)};base64,${String(a.base64)}`, a.destination === "vault" ? "vault" : "general");
  },
  seal_reference: async (a) => {
    const src = refs.get(String(a.refId));
    if (!src) throw new Error("The reference is missing; please add it again");
    await sleep(150);
    return importRef(src, "vault");
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
    if ((i.initImageId || i.initImageVaultId || i.initImageGalleryId) && !m.supportsImg2Img) throw new Error(`${m.name} does not take a start image`);
    if (i.initImageId && !refs.has(i.initImageId)) throw new Error("The start image is missing; please add it again");
    if (i.initImageGalleryId && !images.some((x) => x.id === i.initImageGalleryId)) throw new Error("That gallery image no longer exists; please choose another start image");
    checkVaultStart(i.initImageVaultId, i.destination, [i.initImageId, ...i.referenceIds]);
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
    const hasInit = !!(i.initImageId || i.initImageGalleryId || i.initImageVaultId);
    const refIds = i.referenceIds ?? [];
    if ((m.modes ?? []).includes("r2v")) {
      // Mirrors build_video_plan: r2v takes 1..maxReferences character references and no start image.
      if (hasInit) throw new Error(`${m.name} does not take a start image; add character references instead`);
      if (!refIds.length) throw new Error("Add at least one character reference image");
      if (refIds.length > m.maxReferences) throw new Error(`${m.name} takes at most ${m.maxReferences} character reference images`);
      if (refIds.some((id) => !refs.has(id))) throw new Error("The reference image is missing; please add it again");
    } else {
      if (refIds.length) throw new Error(`${m.name} does not take character reference images`);
      if (hasInit && !(m.modes ?? []).includes("i2v")) throw new Error(`${m.name} does not take a start image`);
    }
    checkVaultStart(i.initImageVaultId, i.destination, [i.initImageId, ...refIds]);
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
    if (vault.items.some((x) => x.id === a.id)) return commands.delete_vault_item(a);
    await sleep(150);
    const id = String(a.id);
    const idx = images.findIndex((im) => im.id === id);
    if (idx >= 0) images.splice(idx, 1);
    // Story takes and films live outside `images`; a story forgets a take or result it pointed at (Rust: delete_record).
    removeRecord(takes, id);
    removeRecord(films, id);
    for (const s of shots.values()) if (s.approvedTakeId === id) shots.set(s.id, { ...s, approvedTakeId: null });
    for (const s of stories.values()) if (s.resultImageId === id) stories.set(s.id, { ...s, resultImageId: null, status: "planned" });
  },
  // ---------- vault (spec v6) ----------
  vault_status: () => vaultStatus(),
  vault_create: async (a) => {
    const password = String(a.password ?? "");
    if (vault.exists) throw new Error("VAULT_EXISTS: A vault already exists.");
    if (password.length < 8) throw new Error("WEAK_PASSWORD: Use at least 8 characters.");
    await sleep(1000); // key generation + Argon2id
    vault.exists = true;
    vault.password = password;
    vault.unlocked = true;
    vault.lastTouch = Date.now();
    emitVault();
    void runMigration();
    return vaultStatus();
  },
  vault_unlock: async (a) => {
    if (!vault.exists) throw new Error("NO_VAULT: Create a vault first.");
    await sleep(1000); // Argon2id
    if (String(a.password ?? "") !== vault.password) throw new Error("WRONG_PASSWORD: The password is incorrect.");
    vault.unlocked = true;
    vault.lastTouch = Date.now();
    emitVault();
    return vaultStatus();
  },
  vault_lock: () => {
    lockVault();
    return vaultStatus();
  },
  vault_change_password: async (a) => {
    requireUnlocked();
    await sleep(1000);
    if (String(a.oldPassword ?? "") !== vault.password) throw new Error("WRONG_PASSWORD: The current password is incorrect.");
    const next = String(a.newPassword ?? "");
    if (next.length < 8) throw new Error("WEAK_PASSWORD: Use at least 8 characters.");
    if (next === vault.password) throw new Error("SAME_PASSWORD: Choose a password different from the current one");
    vault.password = next;
    emitVault();
    return vaultStatus();
  },
  vault_erase: async (a) => {
    // Like the core: the typed word, locked or unlocked, no password; nothing is revealed.
    if (String(a.confirm ?? "") !== "erase") throw new Error('CONFIRM_REQUIRED: Type "erase" to erase the vault');
    if (!vault.exists) throw new Error("NO_VAULT: No vault has been created yet");
    if (vault.migrating || vault.moving) throw new Error("VAULT_BUSY: Wait for the move into the vault to finish");
    await sleep(400);
    Object.assign(vault, { exists: false, unlocked: false, password: "", items: [], migrating: false });
    emitVault();
    return vaultStatus();
  },
  vault_set_auto_lock: async (a) => {
    // Like the core: only while unlocked.
    if (!vault.unlocked) throw new Error("VAULT_LOCKED: Unlock the vault to change its auto-lock time");
    const n = Number(a.minutes);
    if (!Number.isInteger(n) || n < 1 || n > 240) throw new Error("Auto-lock must be between 1 and 240 minutes.");
    await sleep(150);
    vault.autoLockMinutes = n;
    vault.lastTouch = Date.now();
    emitVault();
    return vaultStatus();
  },
  vault_touch: () => {
    if (vault.unlocked) vault.lastTouch = Date.now();
  },
  list_vault_items: async () => {
    requireUnlocked();
    await sleep(200);
    return vault.items.filter((x) => !x.storyId);
  },
  delete_vault_item: async (a) => {
    requireUnlocked();
    await sleep(150);
    const idx = vault.items.findIndex((x) => x.id === a.id);
    if (idx < 0) throw new Error("Vault item not found");
    vault.items.splice(idx, 1);
    emitVault();
  },
  move_to_vault: async (a) => {
    requireUnlocked();
    const idx = images.findIndex((x) => x.id === a.id);
    if (idx < 0) throw new Error("Image not found");
    vault.moving++;
    await sleep(400).finally(() => vault.moving--); // encrypt, verify, delete the plaintext
    const [rec] = images.splice(idx, 1);
    const moved = asVaultItem(rec);
    insertNewestFirst(vault.items, moved);
    emitVault();
    return moved;
  },
  move_to_general: async (a) => {
    requireUnlocked();
    const idx = vault.items.findIndex((x) => x.id === a.id);
    if (idx < 0) throw new Error("Vault item not found");
    vault.moving++;
    await sleep(400).finally(() => vault.moving--);
    const [rec] = vault.items.splice(idx, 1);
    const moved: ImageRecord = { ...rec, vault: false, thumbPath: null };
    insertNewestFirst(images, moved);
    emitVault();
    return moved;
  },
  export_vault_item: async (a) => {
    requireUnlocked();
    const im = vault.items.find((x) => x.id === a.id);
    if (!im) throw new Error("Vault item not found");
    downloadRecord(im, String(a.dest));
  },

  export_image: async (a) => {
    if (vault.items.some((x) => x.id === a.id)) return commands.export_vault_item({ id: a.id, dest: a.destPath });
    const im = images.find((x) => x.id === a.id) ?? films.find((x) => x.id === a.id);
    if (!im) throw new Error("Image not found");
    if (im.vault) requireUnlocked();
    downloadRecord(im, String(a.destPath));
  },
  ...storyCommands,
};

/** Mock refs: a vault ref's refId is a vault:// URL (like the core); its thumbPath stays displayable. */
function importRef(src: string, dest: Destination) {
  if (dest === "vault" && !vault.exists) throw new Error("NO_VAULT: Create a vault first.");
  const refId = dest === "vault" ? `vault://localhost/${uid("blob")}.png` : uid("ref");
  refs.set(refId, src);
  return { refId, thumbPath: src };
}

function downloadRecord(im: ImageRecord, dest: string) {
  if (im.kind === "video") {
    console.info(`[mock] The .mp4 for ${im.id} would be saved to ${dest}.`);
    return;
  }
  const link = document.createElement("a");
  link.href = im.path;
  link.download = dest.split("/").pop() || "image.jpg";
  link.click();
}

export function createMockBackend(): Backend {
  console.info("[Image Studio] Running with the in-memory dev mock (not inside Tauri).");
  return {
    isMock: true,
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      const h = commands[cmd];
      if (!h) throw new Error(`[mock] Unknown command: ${cmd}`);
      if (GPU_START_COMMANDS.has(cmd)) mockStats.commands.push(cmd);
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
