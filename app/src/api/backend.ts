// Chooses between the real Tauri bridge and the in-memory dev mock.
// The mock module is only *imported* (dynamically) when not running inside Tauri,
// so inside the app it is never loaded or executed.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { EventMap } from "./types";

export type Unlisten = () => void;

export interface Backend {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): Promise<Unlisten>;
  /** Native save dialog. Returns the chosen path or null if cancelled. */
  pickSavePath(defaultName: string): Promise<string | null>;
  /** Native open dialog for reference images; null means "use the browser file input". */
  pickImagePaths(): Promise<string[] | null>;
  /** Subscribe to native file drops (Tauri intercepts OS drops). */
  onFileDrop(handler: (e: { type: "enter" | "leave" | "drop"; paths: string[] }) => void): Promise<Unlisten>;
  readonly isMock: boolean;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function createTauriBackend(): Promise<Backend> {
  const event = await import("@tauri-apps/api/event");
  return {
    isMock: false,
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    listen: async (name, handler) => event.listen(name, (e) => handler(e.payload as never)),
    pickSavePath: async (defaultName) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { title, filter } = saveFilter(defaultName);
      return save({ title, defaultPath: defaultName, filters: [filter] });
    },
    pickImagePaths: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const res = await open({
        title: "Add reference images",
        multiple: true,
        directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "heic", "gif", "bmp", "tiff"] }],
      });
      if (!res) return [];
      return Array.isArray(res) ? res : [res];
    },
    onFileDrop: async (handler) => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      return getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter") handler({ type: "enter", paths: p.paths });
        else if (p.type === "drop") handler({ type: "drop", paths: p.paths });
        else if (p.type === "leave") handler({ type: "leave", paths: [] });
      });
    },
  };
}

/** Save-dialog title and filter from the default name's extension (png/jpg/webp/mp4; default png). */
export function saveFilter(defaultName: string): { title: string; filter: { name: string; extensions: string[] } } {
  const ext = defaultName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "png";
  switch (ext) {
    case "mp4":
      return { title: "Save video", filter: { name: "MP4 video", extensions: ["mp4"] } };
    case "jpg":
    case "jpeg":
      return { title: "Save image", filter: { name: "JPEG image", extensions: ["jpg", "jpeg"] } };
    case "webp":
      return { title: "Save image", filter: { name: "WebP image", extensions: ["webp"] } };
    default:
      return { title: "Save image", filter: { name: "PNG image", extensions: ["png"] } };
  }
}

let backendPromise: Promise<Backend> | null = null;

export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = inTauri
      ? createTauriBackend()
      : import("./mock").then((m) => m.createMockBackend());
  }
  return backendPromise;
}
