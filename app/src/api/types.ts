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
  id: ModelId;
  name: string;
  description: string;
  license: string;
  precision: string;
  maxReferences: number;
  supportsNegativePrompt: boolean;
  defaults: ModelDefaults;
  civitaiBaseModels: string[];
  installed: boolean;
  files: ModelFileView[];
  presentBytes: number;
  totalBytes: number;
  task: Task | null;
}

// ---------- Settings ----------

export interface Settings {
  hasApiKey: boolean;
  endpointId: string;
  hasCivitaiKey: boolean;
}

export interface SaveSettingsInput {
  apiKey?: string;
  endpointId?: string;
  civitaiKey?: string;
}

export interface ConnectionTest {
  ok: boolean;
  workers: { idle: number; running: number };
  jobs: { inQueue: number; inProgress: number };
  error?: string | null;
}

export interface VolumeInfo {
  totalBytes: number;
  freeBytes: number;
}

/** Returned by `refresh_status`, `get_status` and the `status-update` event. */
export interface StatusSnapshot {
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
}

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
}

export interface ImagePage {
  items: ImageRecord[];
  /** Numeric cursor for the next `list_images({before})`, null at the end. */
  nextBefore: number | null;
}

// ---------- Events ----------

export type JobStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export type JobPhase = "loading" | "sampling" | "saving" | "downloading";

export interface Job {
  jobId: string;
  status: JobStatus;
  total: number;
  completed: number;
  /** null outside `running`; each field may be null. */
  progress: { phase: JobPhase | string | null; step: number | null; totalSteps: number | null } | null;
  images: ImageRecord[];
  error: string | null;
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
}

export const isTaskActive = (t: Task | null | undefined): t is Task =>
  !!t && (t.status === "queued" || t.status === "running");

export const isJobActive = (j: Job): boolean =>
  j.status === "queued" || j.status === "starting" || j.status === "running";
