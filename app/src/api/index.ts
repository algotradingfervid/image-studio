// Typed wrappers for every Tauri command and event in docs/spec.md.
//
// Argument convention (matches app/src-tauri/src/commands.rs): invoke args are
// FLAT camelCase objects, never wrapped — e.g. `download_model` gets `{ id }`,
// `generate` gets `{ model, prompt, aspectRatio, ... }`. Errors reject with a
// plain string; `call()` normalises them to `Error`.

import { convertFileSrc } from "@tauri-apps/api/core";
import { getBackend, inTauri, type Unlisten } from "./backend";
import type {
  AddLoraInput,
  ConnectionTest,
  DeletePreview,
  DeleteResult,
  EventMap,
  GenerateInput,
  GpuState,
  ImagePage,
  Job,
  ImportedReference,
  Lora,
  ModelView,
  ResolvedLora,
  SaveSettingsInput,
  Settings,
  StatusSnapshot,
  Task,
} from "./types";

export * from "./types";
export { inTauri };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const backend = await getBackend();
  try {
    return await backend.invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(errorMessage(e));
  }
}

function callObj<T>(cmd: string, obj: object): Promise<T> {
  return call<T>(cmd, obj as Record<string, unknown>);
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

// ---------- Settings and status ----------

export const getSettings = () => call<Settings>("get_settings");
/** Only send fields the user changed — an empty string CLEARS that field. */
export const saveSettings = (input: SaveSettingsInput) => callObj<Settings>("save_settings", input);
export const testConnection = () => call<ConnectionTest>("test_connection");
export const listModels = () => call<ModelView[]>("list_models");
/** Asks the worker for fresh status — auto-starts the GPU pod when stopped (can take minutes). */
export const refreshStatus = () => call<StatusSnapshot>("refresh_status");
/** Cached status from SQLite (no GPU). volume/checkedAt may be null. */
export const getStatus = () => call<StatusSnapshot>("get_status");

// ---------- GPU pod ----------

export const getGpuState = () => call<GpuState>("get_gpu_state");
/** Returns at once (usually "starting"); progress continues via `gpu-update`. No-op if already starting/running. */
export const startGpu = () => call<GpuState>("start_gpu");
/** Resolves after the pod is gone (emits "stopping" then "stopped"). */
export const stopGpu = () => call<GpuState>("stop_gpu");

// ---------- Models ----------

export const downloadModel = (id: string) => call<Task>("download_model", { id });
export const cancelTask = (taskId: string) => call<void>("cancel_task", { taskId });
export const deletePreview = (id: string) => call<DeletePreview>("delete_preview", { id });
export const deleteModel = (id: string) => call<DeleteResult>("delete_model", { id });

// ---------- LoRAs ----------

export const resolveLoraLink = (url: string) => call<ResolvedLora>("resolve_lora_link", { url });
export const addLora = (input: AddLoraInput) => callObj<Lora>("add_lora", input);
export const listLoras = () => call<Lora[]>("list_loras");
/** Returns the delete task, or null when the LoRA was removed immediately. */
export const deleteLora = (id: string) => call<Task | null>("delete_lora", { id });

// ---------- Generation and gallery ----------

export const importReference = (path: string) => call<ImportedReference>("import_reference", { path });
export const importReferenceBytes = (base64: string, mime: string) =>
  call<ImportedReference>("import_reference_bytes", { base64, mime });
export const generate = (input: GenerateInput) => callObj<{ jobId: string }>("generate", input);
export const cancelJob = (jobId: string) => call<void>("cancel_job", { jobId });
/** Active jobs, for restoring job cards on app start. */
export const listJobs = () => call<Job[]>("list_jobs");
export const listImages = (input: { limit?: number; before?: number | null }) =>
  callObj<ImagePage>("list_images", input.before == null ? { limit: input.limit } : input);
export const deleteImage = (id: string) => call<void>("delete_image", { id });
/** Copies the stored image file to `destPath` (chosen in the save dialog). */
export const exportImage = (input: { id: string; destPath: string }) => callObj<void>("export_image", input);

// ---------- Events ----------

export async function onEvent<K extends keyof EventMap>(
  event: K,
  handler: (payload: EventMap[K]) => void,
): Promise<Unlisten> {
  const backend = await getBackend();
  return backend.listen(event, handler);
}

// ---------- Native helpers ----------

/** URL for an image stored on disk (Tauri asset protocol), or passthrough in the mock. */
export function fileSrc(path: string): string {
  if (!path) return "";
  if (!inTauri || path.startsWith("data:") || path.startsWith("http") || path.startsWith("blob:")) return path;
  return convertFileSrc(path);
}

export async function pickSavePath(defaultName: string) {
  return (await getBackend()).pickSavePath(defaultName);
}

export async function pickImagePaths() {
  return (await getBackend()).pickImagePaths();
}

export async function onFileDrop(handler: Parameters<Awaited<ReturnType<typeof getBackend>>["onFileDrop"]>[0]) {
  return (await getBackend()).onFileDrop(handler);
}

/** Clipboard: Tauri clipboard-manager plugin in the app, navigator.clipboard in the browser mock. */
export async function copyText(text: string): Promise<void> {
  if (inTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } else {
    await navigator.clipboard.writeText(text);
  }
}

/** Read a File/Blob as raw base64 (no data: prefix) for `import_reference_bytes`. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("Could not read file"));
    r.readAsDataURL(blob);
  });
}
