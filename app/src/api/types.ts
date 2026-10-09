// Types mirroring docs/spec.md "Commands (invoke)" and "Events" (camelCase JSON).

export type ModelId = string;

export interface ModelDefaults {
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  negativePrompt: string;
}

/** A file entry from the registry (shared/models.json). */
export interface ModelFile {
  folder: string;
  filename: string;
  url: string;
  sizeBytes: number;
  sha256: string | null;
  gated: boolean;
}

export interface ModelFileView extends ModelFile {
  present: boolean;
  /** Ids of other models that use the same (folder, filename). */
  sharedWith: string[];
}

/** `ModelView` = registry fields + `{installed, files: [{...file, present}], presentBytes, totalBytes, task}`. */
export interface ModelView {
  /** "image" (registry `models`) or "video" (registry `videoModels`, spec v5). */
  kind: "image" | "video";
  id: ModelId;
  name: string;
  description: string;
  license: string;
  precision: string;
  maxReferences: number;
  supportsNegativePrompt: boolean;
  /** img2img: accepts a start image (`initImageId`) + strength (`denoise`). */
  supportsImg2Img: boolean;
  defaults: ModelDefaults;
  civitaiBaseModels: string[];
  installed: boolean;
  files: ModelFileView[];
  presentBytes: number;
  totalBytes: number;
  task: Task | null;
  // ----- video models only (kind === "video") -----
  /** "t2v" (text→video) and/or "i2v" (start image→video). */
  modes?: ("t2v" | "i2v" | string)[];
  /** Generates an audio track. */
  audio?: boolean;
  /** Network volume holding the files, e.g. "image-studio-video". */
  volume?: string;
  limits?: VideoLimits;
  /** For video models `defaults` also carries durationS, fps, resolution (see VideoDefaults). */
}

/** A resolution option: a plain id ("1280x720", "720p") or an object with an id/label and size. */
export type VideoResolutionOption = string | { id?: string; label?: string; width?: number; height?: number };

export interface VideoLimits {
  minDurationS?: number;
  maxDurationS: number;
  resolutions: VideoResolutionOption[];
  fpsOptions: number[];
}

export interface VideoDefaults {
  durationS?: number;
  fps?: number;
  resolution?: string;
  steps?: number;
  cfg?: number;
}

/** Id of a resolution option (string as-is; object → id, label, or "WxH"). Matches the backend. */
export function resolutionId(r: VideoResolutionOption): string {
  if (typeof r === "string") return r;
  return r.id ?? r.label ?? `${r.width ?? 0}x${r.height ?? 0}`;
}

export type GpuProfile = "image" | "video";

// ---------- Settings ----------

/** "pod" = dedicated GPU pod started/stopped from the app (v3); "serverless" = legacy endpoint. */
export type BackendKind = "pod" | "serverless";

export interface Settings {
  hasApiKey: boolean;
  /** Only needed (and used) for the legacy serverless backend. */
  endpointId: string | null;
  hasCivitaiKey: boolean;
  /** App-side auto-stop after this many idle minutes (5–240). */
  idleMinutes: number;
  backend: BackendKind;
  /** First entry of `gpuTypes` (full name). */
  gpuType: string;
  /** GPU placement priority list (full names); the pod gets the first one available. */
  gpuTypes: string[];
  /** Network volume name(s) the pod mounts. */
  volumeNames: string[];
  /** Pass the RunPod API key to the pod so its idle watchdog can terminate itself. */
  passApiKeyToPod: boolean;
  /** USD/h used when the pod doesn't report a price. */
  fallbackCostPerHr: number;
  /** Git ref the pod's boot script fetches worker code at (`WORKER_REF`; settings file `workerRef`, default "main"). */
  workerRef: string;
  /** Pod container image (settings file `podImage`; default the runtime image). */
  podImage: string;
  /** Video profile (spec v5): GPU priority list and volume names (settings file `videoGpuTypes` / `videoVolumeNames`). */
  videoGpuTypes: string[];
  videoVolumeNames: string[];
  /** Vault auto-lock minutes (spec v6; same value as `VaultStatus.autoLockMinutes`). */
  vaultAutoLockMinutes?: number;
}

export interface SaveSettingsInput {
  apiKey?: string;
  endpointId?: string;
  civitaiKey?: string;
  /** 5–240; the backend rejects anything else. */
  idleMinutes?: number;
  backend?: BackendKind;
  passApiKeyToPod?: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  workers: { idle: number; running: number };
  jobs: { inQueue: number; inProgress: number };
  error?: string | null;
  /** What was checked: the running pod's /health, only the API key (GPU stopped), or the legacy endpoint. */
  target?: "pod" | "api" | "serverless";
  message?: string | null;
  ready?: boolean | null;
  gpu?: string | null;
}

// ---------- GPU pod ----------

export type GpuStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface GpuState {
  /** Which pod this is: "image" (image-studio-gpu) or "video" (image-studio-video-gpu). */
  profile: GpuProfile;
  status: GpuStatus;
  podId?: string | null;
  /** e.g. "NVIDIA RTX PRO 6000 Blackwell Server Edition" */
  gpuType?: string | null;
  /** RFC 3339; drives the live elapsed time. */
  startedAt?: string | null;
  /** USD/h (the backend falls back to 2.49). */
  costPerHr?: number | null;
  /** While starting: "Creating pod" | "Waiting for machine" | "Pulling image" | "Booting ComfyUI". */
  phase?: string | null;
  /** Set when status === "error". */
  error?: string | null;
  idleMinutes: number;
  /** True when an existing pod was found and re-adopted at app launch. */
  leftRunning: boolean;
  /** Set on "stopped": user pressed Stop, the app auto-stopped it, or the pod vanished. */
  stopReason?: "user" | "idle" | "external" | null;
  /**
   * From the pod's /health watchdog: false means the pod can't terminate itself when
   * idle (only the app's auto-stop protects it). Absent when the pod doesn't report it.
   */
  watchdogArmed?: boolean | null;
}

export interface VolumeInfo {
  totalBytes: number;
  freeBytes: number;
}

/** Returned by `refresh_status`, `get_status` and the `status-update` event. */
export interface StatusSnapshot {
  /** Which volume this snapshot's `volume`/`checkedAt` describe (image or video volume). */
  profile: GpuProfile;
  /** All models (image and video), with presence from each one's own volume cache. */
  models: ModelView[];
  /** null until the volume has been checked once. */
  volume: VolumeInfo | null;
  /** RFC 3339 timestamp, null if never checked. */
  checkedAt: string | null;
}

// ---------- Models ----------

export interface DeletePreview {
  deleteFiles: string[];
  freedBytes: number;
  keptFiles: KeptFile[];
}

export interface KeptFile {
  filename: string;
  reason: string;
}

export interface DeleteResult {
  freedBytes: number;
  keptFiles: KeptFile[];
  /** The delete task that was started (null when nothing needed deleting). */
  task: Task | null;
}

// ---------- LoRAs ----------

export type LoraSource = "huggingface" | "civitai";

export interface ResolvedLora {
  source: LoraSource;
  name: string;
  downloadUrl: string;
  filename: string;
  sizeBytes?: number;
  sha256?: string;
  baseModel?: string;
  suggestedModelId?: ModelId;
  triggerWords: string[];
  previewUrl?: string;
}

export interface AddLoraInput {
  url: string;
  modelId: ModelId;
  name?: string;
  triggerWords?: string[];
}

export interface Lora {
  id: string;
  name: string;
  modelId: ModelId;
  source: LoraSource;
  sourceUrl: string;
  filename: string;
  sizeBytes: number | null;
  triggerWords: string[];
  present: boolean;
  task: Task | null;
}

// ---------- Generation & gallery ----------

export interface ImportedReference {
  refId: string;
  thumbPath: string;
}

export interface GenerateInput {
  model: ModelId;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: string;
  count: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  referenceIds: string[];
  loras: { loraId: string; strength: number }[];
  /** img2img start image: an id from `import_reference(_bytes)` (models with `supportsImg2Img`). */
  initImageId?: string;
  /** img2img start image picked "From gallery": a General record id (read in place). */
  initImageGalleryId?: string;
  /** img2img start image that is a vault item (spec v6; needs the vault unlocked). Excludes `initImageId`. */
  initImageVaultId?: string;
  /** img2img strength, 0.05–1.0 (backend default 0.6). Ignored without a start image. */
  denoise?: number;
  /** Where the outputs are saved (spec v6). Backend default "general". */
  destination?: Destination;
}

/** `generate_video` (spec v5). One pod job per video; runs on the video GPU profile (auto-started). */
export interface GenerateVideoInput {
  model: ModelId;
  prompt: string;
  negativePrompt?: string;
  /** i2v start image: an id from `import_reference(_bytes)` ("Browse computer"); omit for text→video. */
  initImageId?: string;
  /**
   * i2v start image picked "From gallery": an ImageRecord id (kind "image" only). The backend reads
   * the gallery file in place (no copy). Mutually exclusive with `initImageId`.
   */
  initImageGalleryId?: string;
  /** i2v start image that is a vault item (spec v6; needs the vault unlocked). */
  initImageVaultId?: string;
  durationS: number;
  fps: number;
  /** A resolution id from the model's `limits.resolutions` (see `resolutionId`). */
  resolution: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  audio: boolean;
  /** Where the video is saved (spec v6). Backend default "general". */
  destination?: Destination;
}

/** img2img strength slider ("How much to change"). */
export const DENOISE_MIN = 0.05;
export const DENOISE_MAX = 1;
export const DENOISE_STEP = 0.05;
export const DENOISE_DEFAULT = 0.6;

export interface ImageRecord {
  id: string;
  path: string;
  model: ModelId;
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  references: string[];
  loras: { name: string; strength: number }[];
  /** RFC 3339 timestamp. */
  createdAt: string;
  durationMs: number | null;
  runpod: { delayMs: number | null; executionMs: number | null };
  /** img2img start image (stored file path); null/absent for text-to-image. */
  initImage?: string | null;
  /** img2img strength (denoise); null/absent for text-to-image. */
  denoise?: number | null;
  /** "video" records (spec v5): `path` is the .mp4; `aspectRatio` holds the resolution id. Absent → "image". */
  kind?: "image" | "video";
  durationS?: number | null;
  fps?: number | null;
  hasAudio?: boolean | null;
  /** JPEG poster frame for video tiles. */
  posterPath?: string | null;
  /**
   * Vault item (spec v6): `path`, `posterPath`, `initImage` and `references` are `vault://localhost/<blobId>`
   * URLs, used directly (never through convertFileSrc). General records: false or absent.
   */
  vault?: boolean;
  /** Vault items: small JPEG preview for grid tiles (videos reuse the poster). */
  thumbPath?: string | null;
}

export interface ImagePage {
  items: ImageRecord[];
  /** Numeric cursor for the next `list_images({before})`, null at the end. */
  nextBefore: number | null;
}

// ---------- Vault (spec v6, docs/vault-contract.md) ----------

export type Destination = "general" | "vault";

export interface VaultStatus {
  /** A vault has been created. */
  exists: boolean;
  unlocked: boolean;
  /** 1..240, default 10. */
  autoLockMinutes: number;
  /** null while locked. */
  itemCount: number | null;
  /** A started migration has items left (resumes on unlock). */
  migrationPending: boolean;
}

export type MigrationPhase = "encrypting" | "verifying" | "cleaning" | "done" | "error";

export interface MigrationProgress {
  phase: MigrationPhase | string;
  done: number;
  total: number;
  counts: { images: number; videos: number; posters: number; startImages: number; references: number };
  errors: number;
  error: string | null;
}

/** Vault error codes: the backend's error strings start with `"<CODE>: "`. */
export type VaultErrorCode = "WRONG_PASSWORD" | "WEAK_PASSWORD" | "VAULT_EXISTS" | "NO_VAULT" | "VAULT_LOCKED";

export const VAULT_PASSWORD_MIN = 8;
export const VAULT_AUTOLOCK_MIN = 1;
export const VAULT_AUTOLOCK_MAX = 240;

/** The error code prefix of a failed command ("WRONG_PASSWORD: …" → "WRONG_PASSWORD"), or null. */
export function errorCode(e: unknown): string | null {
  const m = (e instanceof Error ? e.message : typeof e === "string" ? e : "").match(/^([A-Z][A-Z0-9_]+)(?::|$)/);
  return m ? m[1] : null;
}

/** A vault media URL (`vault://…`, or the Windows-style `http://vault.localhost/…`). */
export const isVaultUrl = (p: string | null | undefined): boolean => !!p && (p.startsWith("vault:") || p.startsWith("http://vault.localhost/"));

// ---------- Events ----------

export type JobStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "loading" | "sampling" | "saving" | "downloading";

/** Fine-grained generate stages reported by the worker (v2 progress). */
export type JobStage =
  | "loading_text_encoder"
  | "encoding_prompt"
  | "loading_model"
  | "preparing_init_image"
  | "preparing_references"
  | "sampling"
  | "decoding"
  | "saving"
  // video (spec v5)
  | "video_decoding"
  | "audio_decoding"
  | "encoding_video";

export interface JobProgress {
  /** v1 phase ("loading" | "sampling" | "saving"), or the pod start phase while `starting`. */
  phase: JobPhase | string | null;
  step: number | null;
  totalSteps: number | null;
  /** The v2 fields below are absent with an older worker and during pod start. */
  stage?: JobStage | string;
  /** The stages that apply to this generation, in display order. */
  stages?: string[];
  /** Since the worker started this image. */
  elapsedMs?: number;
  /** Since the current stage started. */
  stageElapsedMs?: number;
  /** A loader stage was cached: the model was already in GPU memory. */
  cached?: boolean;
  /** Stages that were cached and didn't run. */
  cachedStages?: string[];
  /** Milliseconds spent in each stage already finished. */
  stageTimes?: Record<string, number>;
  /** Stage `copying_models`: percent of the model files copied to the pod's local disk. */
  copyPercent?: number;
}

export interface Job {
  jobId: string;
  /** "video" for `generate_video` jobs; absent/"image" otherwise. */
  kind?: "image" | "video";
  status: JobStatus;
  total: number;
  completed: number;
  /** null outside `starting`/`running`; each field may be null. */
  progress: JobProgress | null;
  images: ImageRecord[];
  error: string | null;
  /** Where the outputs go (spec v6). Absent from older cores → "general". */
  destination?: Destination;
}

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  kind: "download" | "delete";
  target: { type: "model" | "lora"; id: string };
  status: TaskStatus;
  bytes: number;
  totalBytes: number;
  file: string | null;
  error: string | null;
}

export interface EventMap {
  "job-update": Job;
  "task-update": Task;
  "status-update": StatusSnapshot;
  /** One profile's state (see `profile`). */
  "gpu-update": GpuState;
  /**
   * The user is quitting while a GPU pod may be billing; answer with `confirm_quit`.
   * Payload: the state of EVERY profile (image, video); list the ones not stopped.
   */
  "quit-requested": GpuState[];
  /** Vault state on create / unlock / lock / auto-lock / password change, and whenever vault items change. */
  "vault-update": VaultStatus;
  /** Migration of the pre-v6 content into the vault (on create, or resumed on unlock). */
  "vault-migration": MigrationProgress;
}

export const isTaskActive = (t: Task | null | undefined): t is Task =>
  !!t && (t.status === "queued" || t.status === "running");

export const isJobActive = (j: Job): boolean =>
  j.status === "queued" || j.status === "starting" || j.status === "running";

/** Ready to run jobs: an API key, plus an endpoint ID for the legacy serverless backend. */
export const isConfigured = (s: Settings | null | undefined): boolean =>
  !!s && s.hasApiKey && (s.backend !== "serverless" || !!s.endpointId);

/** The GPU pod has to be started before work can run. */
export const gpuIsOff = (g: GpuState | null | undefined): boolean => !!g && (g.status === "stopped" || g.status === "error");
