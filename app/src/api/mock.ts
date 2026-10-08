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
  GpuState,
  ImageRecord,
  ImagePage,
  Job,
  KeptFile,
  Lora,
  ModelView,
  ResolvedLora,
  SaveSettingsInput,
  Settings,
  StatusSnapshot,
  Task,
} from "./types";

type RegistryModel = (typeof registry.models)[number];

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
};

const models: RegistryModel[] = registry.models;
const aspect = registry.aspectRatios as Record<string, number[]>;

/** Filenames present on the fake volume. */
const present = new Set<string>();
for (const id of ["chroma", "zimage", "qwen"]) {
  for (const f of models.find((m) => m.id === id)!.files) present.add(f.filename);
}
const loraFiles = new Set<string>();

const modelTasks = new Map<string, Task>();
const loraTasks = new Map<string, Task>();
const taskCancel = new Set<string>();
const jobCancel = new Set<string>();
const activeJobs = new Map<string, Job>();

// App-side auto-stop: idleMinutes with no jobs or tasks while the GPU runs.
window.setInterval(() => {
  if (!podMode() || gpu.status !== "running") return;
  const busy =
    activeJobs.size > 0 || [...modelTasks.values(), ...loraTasks.values()].some((t) => t.status === "queued" || t.status === "running");
  if (busy) lastActivity = Date.now();
  else if (Date.now() - lastActivity >= gpu.idleMinutes * MINUTE_MS) stopGpuInternal("idle").catch(() => {});
}, 1000);

let checkedAt = Date.now() - 1000 * 60 * 60 * 5;
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

let gpu: GpuState = params.has("gpuRunning")
  ? {
      status: "running",
      podId: "mockpod_leftover",
      gpuType: GPU_TYPE,
      startedAt: new Date(Date.now() - 23 * 60_000).toISOString(),
      costPerHr: GPU_COST,
      phase: null,
      error: null,
      idleMinutes: settings.idleMinutes,
      leftRunning: true,
      stopReason: null,
      watchdogArmed: params.has("noWatchdog") ? false : true,
    }
  : {
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
let gpuRun = 0; // bumped on every start/stop so a stale start sequence gives up
let lastActivity = Date.now();

const podMode = () => settings.backend === "pod";

function setGpu(patch: Partial<GpuState>) {
  gpu = { ...gpu, ...patch };
  emit("gpu-update", gpu);
}

function startGpuInternal() {
  if (gpu.status === "starting" || gpu.status === "running" || gpu.status === "stopping") return;
  const run = ++gpuRun;
  setGpu({
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
      if (run !== gpuRun || gpu.status !== "starting") return;
      if (i < START_PHASES.length) {
        setGpu({ phase: START_PHASES[i] });
      } else if (params.has("gpuFail")) {
        setGpu({ status: "error", phase: null, error: "ComfyUI didn't become healthy within 10 minutes (simulated by ?gpuFail). The pod is still there." });
      } else {
        lastActivity = Date.now();
        setGpu({ status: "running", phase: null, startedAt: new Date().toISOString(), watchdogArmed: !params.has("noWatchdog") });
      }
    }
  })();
}

async function stopGpuInternal(reason: "user" | "idle" | "external") {
  if (gpu.status === "stopped") return;
  if (gpu.status === "stopping") {
    while (gpu.status === "stopping") await sleep(100);
    return;
  }
  gpuRun++;
  setGpu({ status: "stopping", phase: null });
  await sleep(1500);
  if (params.has("stopFail")) {
    const error = "Couldn't stop the GPU pod — it may still be billing. Press Stop to try again. (simulated by ?stopFail)";
    setGpu({ status: "error", error });
    throw new Error(error);
  }
  // Terminating the pod ends whatever was running on it.
  activeJobs.forEach((j) => jobCancel.add(j.jobId));
  for (const t of [...modelTasks.values(), ...loraTasks.values()]) if (t.status === "queued" || t.status === "running") taskCancel.add(t.taskId);
  loadedModels.clear(); // a new pod starts with empty GPU memory
  setGpu({ status: "stopped", podId: null, gpuType: null, costPerHr: null, startedAt: null, phase: null, error: null, leftRunning: false, stopReason: reason, watchdogArmed: null });
}

/** Like the Rust core: quitting must be confirmed while a pod may be billing. */
const quitNeedsConfirm = () =>
  podMode() && (gpu.status === "starting" || gpu.status === "running" || gpu.status === "stopping" || (gpu.status === "error" && !!gpu.podId));

(window as unknown as { mockQuit: () => void }).mockQuit = () => {
  if (quitNeedsConfirm()) emit("quit-requested", gpu);
  else console.info("[mock] No GPU pod is billing — the app would quit now.");
};

/**
 * Pod backend: make sure the GPU is running, auto-starting it when stopped (like the Rust core).
 * `onPhase` sees each boot phase; resolves once running, throws if it ends stopped/in error.
 */
async function ensureGpuReady(onPhase?: (phase: string) => void, aborted?: () => boolean) {
  // Read through a function: `gpu` changes behind the awaits, so don't let TS narrow it.
  const status = () => gpu.status;
  if (!podMode() || status() === "running") return;
  while (status() === "stopping") await sleep(100);
  startGpuInternal();
  let last: string | null = null;
  while (status() === "starting" && !aborted?.()) {
    if (gpu.phase && gpu.phase !== last) onPhase?.((last = gpu.phase));
    await sleep(100);
  }
  if (aborted?.()) return;
  if (status() !== "running") throw new Error(gpu.error ?? "The GPU pod stopped before it was ready.");
}

// ---------- helpers ----------

function modelView(m: RegistryModel): ModelView {
  const files = m.files.map((f) => ({
    ...f,
    present: present.has(f.filename),
    sharedWith: models.filter((o) => o.id !== m.id && o.files.some((g) => g.folder === f.folder && g.filename === f.filename)).map((o) => o.id),
  }));
  const task = modelTasks.get(m.id) ?? null;
  return {
    ...m,
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

function usedBytes() {
  let used = 0;
  const seen = new Set<string>();
  for (const m of models)
    for (const f of m.files)
      if (present.has(f.filename) && !seen.has(f.filename)) {
        seen.add(f.filename);
        used += f.sizeBytes;
      }
  for (const l of loras) if (loraFiles.has(l.filename)) used += l.sizeBytes ?? 0;
  return used;
}

function volume() {
  const totalBytes = 100 * GB;
  return { totalBytes, freeBytes: totalBytes - usedBytes() - 3.2 * GB };
}

function snapshot(): StatusSnapshot {
  return { models: models.map(modelView), volume: volume(), checkedAt: new Date(checkedAt).toISOString() };
}

function emitStatus() {
  emit("status-update", snapshot());
}

/** Shared-file delete rule (mirror of the Rust pure function). */
function computeDelete(id: string): DeletePreview {
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
    await ensureGpuReady(undefined, () => taskCancel.has(task.taskId)); // stays "queued" while the GPU starts
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
    checkedAt = Date.now();
    emitStatus();
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
  saving: "saving",
};

/** Models whose weights the simulated GPU holds (the 2nd run of a model reports cached loaders). */
const loadedModels = new Set<string>();

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
  const warm = loadedModels.has(input.model);
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
  loadedModels.add(input.model);
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
  const job: Job = { jobId, status: "queued", total: input.count, completed: 0, progress: null, images: [], error: null };
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
  if (podMode() && gpu.status !== "running") {
    // GPU boot: status "starting" + progress.phase = the pod phase.
    job.status = "starting";
    try {
      await ensureGpuReady((phase) => {
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
      setGpu({ idleMinutes: i.idleMinutes });
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
    if (gpu.status === "running") {
      const n = activeJobs.size;
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
  get_gpu_state: () => ({ ...gpu }),
  start_gpu: async () => {
    if (!settings.hasApiKey) throw new Error("RunPod API key is not set. Add it in Settings.");
    await sleep(200);
    startGpuInternal();
    return { ...gpu };
  },
  stop_gpu: async () => {
    await stopGpuInternal("user");
    return { ...gpu };
  },
  confirm_quit: async (a) => {
    if (a.stopGpu) {
      await stopGpuInternal("user");
      while (gpu.status === "stopping") await sleep(100);
      if (gpu.status !== "stopped") throw new Error(gpu.error ?? "The GPU pod could not be stopped; it may still be billing");
    }
    console.info(`[mock] The app would quit now${a.stopGpu ? " (GPU stopped)" : " (GPU left running)"}.`);
  },
  list_models: () => models.map(modelView),
  refresh_status: async () => {
    requireConfigured();
    await ensureGpuReady();
    await sleep(2200);
    checkedAt = Date.now();
    emitStatus();
    return snapshot();
  },
  get_status: () => snapshot(),
  list_jobs: () => [...activeJobs.values()],

  download_model: async (a) => {
    requireConfigured();
    const id = String(a.id);
    const m = models.find((x) => x.id === id);
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
        await ensureGpuReady(undefined, () => taskCancel.has(task.taskId));
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
    await ensureGpuReady();
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
      const fn = handler as (p: unknown) => void;
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
