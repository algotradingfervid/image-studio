// App-wide data: settings, models, LoRAs and the cached volume status, kept live
// through `task-update` events.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import type { GpuProfile, Lora, ModelView, Settings, StatusSnapshot, Task } from "../api";

type VolumeStatus = Pick<StatusSnapshot, "volume" | "checkedAt">;
import { useToast } from "./toast";

interface Library {
  settings: Settings | null;
  /** All models (image and video). Image-only consumers use `imageModels`. */
  models: ModelView[];
  /** `kind !== "video"`. */
  imageModels: ModelView[];
  /** `kind === "video"` (spec v5). */
  videoModels: ModelView[];
  loras: Lora[];
  /** The image volume's status. */
  status: VolumeStatus | null;
  /** The video volume's status (spec v5). */
  videoStatus: VolumeStatus | null;
  loaded: boolean;
  /** The image volume refresh is running. */
  refreshing: boolean;
  videoRefreshing: boolean;
  reloadSettings(): Promise<void>;
  reloadModels(): Promise<void>;
  reloadLoras(): Promise<void>;
  /** Re-read the cached status of one profile's volume, or both (no GPU). */
  reloadStatus(profile?: GpuProfile): Promise<void>;
  /** Ask the worker for fresh status (starts that profile's GPU). */
  refreshStatus(profile?: GpuProfile): Promise<void>;
  /** Apply a task returned by a command before its first event arrives. */
  applyTask(task: Task): void;
}

const Ctx = createContext<Library | null>(null);

export function useLibrary(): Library {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLibrary outside provider");
  return v;
}

const terminal = (t: Task) => t.status === "completed" || t.status === "failed" || t.status === "cancelled";

export function LibraryProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [loras, setLoras] = useState<Lora[]>([]);
  const [status, setStatus] = useState<VolumeStatus | null>(null);
  const [videoStatus, setVideoStatus] = useState<VolumeStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [videoRefreshing, setVideoRefreshing] = useState(false);
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const lorasRef = useRef(loras);
  lorasRef.current = loras;

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch (e) {
      toast.error("Couldn't load settings", e);
    }
  }, [toast]);

  const reloadModels = useCallback(async () => {
    try {
      setModels(await api.listModels());
    } catch (e) {
      toast.error("Couldn't load models", e);
    }
  }, [toast]);

  const reloadLoras = useCallback(async () => {
    try {
      setLoras(await api.listLoras());
    } catch (e) {
      toast.error("Couldn't load LoRAs", e);
    }
  }, [toast]);

  const applyStatus = useCallback((s: StatusSnapshot) => {
    if (s.models?.length) setModels(s.models);
    // The snapshot's volume/checkedAt describe one profile's volume (older cores: the image one).
    const v = { volume: s.volume, checkedAt: s.checkedAt };
    if (s.profile === "video") setVideoStatus(v);
    else setStatus(v);
  }, []);

  const reloadStatus = useCallback(
    async (profile?: GpuProfile) => {
      const profiles: GpuProfile[] = profile ? [profile] : ["image", "video"];
      try {
        // Sequential so the models list from the last one wins consistently.
        for (const p of profiles) {
          const snap = await api.getStatus(p);
          applyStatus({ ...snap, profile: snap.profile ?? p });
        }
      } catch (e) {
        toast.error("Couldn't load the volume status", e);
      }
    },
    [applyStatus, toast],
  );

  const refreshStatus = useCallback(
    async (profile: GpuProfile = "image") => {
      const setBusy = profile === "video" ? setVideoRefreshing : setRefreshing;
      setBusy(true);
      try {
        const snap = await api.refreshStatus(profile);
        applyStatus({ ...snap, profile: snap.profile ?? profile });
      } catch (e) {
        toast.error(profile === "video" ? "Video volume refresh failed" : "Refresh failed", e);
      } finally {
        setBusy(false);
      }
    },
    [applyStatus, toast],
  );

  const applyTask = useCallback((t: Task) => {
    const live = terminal(t) ? null : t;
    if (t.target.type === "model") setModels((ms) => ms.map((m) => (m.id === t.target.id ? { ...m, task: live } : m)));
    else setLoras((ls) => ls.map((l) => (l.id === t.target.id ? { ...l, task: live } : l)));
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([reloadSettings(), reloadModels().then(() => reloadStatus()), reloadLoras()]).finally(() => alive && setLoaded(true));
    const un = api.onEvent("task-update", (t) => {
      applyTask(t);
      if (!terminal(t)) return;
      const name =
        t.target.type === "model"
          ? modelsRef.current.find((m) => m.id === t.target.id)?.name
          : lorasRef.current.find((l) => l.id === t.target.id)?.name;
      const what = name ?? t.target.id;
      const verb = t.kind === "download" ? "Download" : "Delete";
      if (t.status === "failed") toast.error(`${verb} failed: ${what}`, t.error ?? undefined);
      else if (t.status === "completed") toast.success(t.kind === "download" ? `Downloaded ${what}` : `Deleted ${what}`);
      else if (t.status === "cancelled") toast.info(`${verb} cancelled`, what);
      // The Rust core refreshes its status cache after a download/delete finishes.
      void reloadModels();
      void reloadLoras();
    });
    // The Rust core pushes a fresh snapshot after its own refreshes.
    const unStatus = api.onEvent("status-update", applyStatus);
    return () => {
      alive = false;
      void un.then((f) => f());
      void unStatus.then((f) => f());
    };
  }, [applyStatus, applyTask, reloadLoras, reloadModels, reloadSettings, reloadStatus, toast]);

  const imageModels = useMemo(() => models.filter((m) => m.kind !== "video"), [models]);
  const videoModels = useMemo(() => models.filter((m) => m.kind === "video"), [models]);

  const value = useMemo<Library>(
    () => ({
      settings,
      models,
      imageModels,
      videoModels,
      loras,
      status,
      videoStatus,
      loaded,
      refreshing,
      videoRefreshing,
      reloadSettings,
      reloadModels,
      reloadLoras,
      reloadStatus,
      refreshStatus,
      applyTask,
    }),
    [settings, models, imageModels, videoModels, loras, status, videoStatus, loaded, refreshing, videoRefreshing, reloadSettings, reloadModels, reloadLoras, reloadStatus, refreshStatus, applyTask],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
