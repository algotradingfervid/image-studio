// App-wide data: settings, models, LoRAs and the cached volume status, kept live
// through `task-update` events.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import type { Lora, ModelView, Settings, StatusSnapshot, Task } from "../api";
import { useToast } from "./toast";

interface Library {
  settings: Settings | null;
  models: ModelView[];
  loras: Lora[];
  status: Pick<StatusSnapshot, "volume" | "checkedAt"> | null;
  loaded: boolean;
  refreshing: boolean;
  reloadSettings(): Promise<void>;
  reloadModels(): Promise<void>;
  reloadLoras(): Promise<void>;
  /** Re-read the cached status (no GPU). */
  reloadStatus(): Promise<void>;
  /** Ask the worker for fresh status (starts a GPU). */
  refreshStatus(): Promise<void>;
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
  const [status, setStatus] = useState<Library["status"]>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
    setStatus({ volume: s.volume, checkedAt: s.checkedAt });
  }, []);

  const reloadStatus = useCallback(async () => {
    try {
      applyStatus(await api.getStatus());
    } catch (e) {
      toast.error("Couldn't load the volume status", e);
    }
  }, [applyStatus, toast]);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      applyStatus(await api.refreshStatus());
    } catch (e) {
      toast.error("Refresh failed", e);
    } finally {
      setRefreshing(false);
    }
  }, [applyStatus, toast]);

  const applyTask = useCallback((t: Task) => {
    const live = terminal(t) ? null : t;
    if (t.target.type === "model") setModels((ms) => ms.map((m) => (m.id === t.target.id ? { ...m, task: live } : m)));
    else setLoras((ls) => ls.map((l) => (l.id === t.target.id ? { ...l, task: live } : l)));
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([reloadSettings(), reloadModels().then(reloadStatus), reloadLoras()]).finally(() => alive && setLoaded(true));
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

  const value = useMemo<Library>(
    () => ({ settings, models, loras, status, loaded, refreshing, reloadSettings, reloadModels, reloadLoras, reloadStatus, refreshStatus, applyTask }),
    [settings, models, loras, status, loaded, refreshing, reloadSettings, reloadModels, reloadLoras, reloadStatus, refreshStatus, applyTask],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
