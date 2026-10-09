import { useCallback, useEffect, useState } from "react";
import { inTauri, isConfigured } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GpuPills } from "./components/GpuPill";
import { Icon, type IconName } from "./components/Icon";
import { radioKeys } from "./components/radio";
import { CreateScreen } from "./screens/create/CreateScreen";
import { ModelsScreen } from "./screens/models/ModelsScreen";
import { SettingsScreen } from "./screens/settings/SettingsScreen";
import { GpuProvider, PROFILE_LABEL, PROFILES, useGpu } from "./state/gpu";
import { LibraryProvider, useLibrary } from "./state/library";
import { ToastProvider } from "./state/toast";
import { useVault, VaultProvider } from "./state/vault";

export type Tab = "create" | "models" | "settings";

const TABS: { id: Tab; label: string; icon: IconName; key: string }[] = [
  { id: "create", label: "Create", icon: "wand", key: "1" },
  { id: "models", label: "Models", icon: "cube", key: "2" },
  { id: "settings", label: "Settings", icon: "gear", key: "3" },
];

const TAB_KEY = "imagestudio.tab";

/** `#models` / `#settings` in the address, else the tab open at the last quit (UX-058). */
function initialTab(): Tab {
  const fromHash = window.location.hash.slice(1);
  if (TABS.some((t) => t.id === fromHash)) return fromHash as Tab;
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    if (TABS.some((t) => t.id === saved)) return saved as Tab;
  } catch {
    // Storage blocked: start on Create.
  }
  return "create";
}

function Shell() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const vault = useVault();
  const lib = useLibrary();
  const s = lib.settings;
  const needsSetup = !!s && !isConfigured(s);
  const gpu = useGpu();
  // Startup banner: a pod of either profile was found running at launch and re-adopted.
  const [keptPods, setKeptPods] = useState<Set<string>>(() => new Set());
  const leftRunning = PROFILES.filter((p) => gpu.podMode || p === "video")
    .map((p) => gpu.profiles[p])
    .filter((x) => {
        const g = x.state;
      return !keptPods.has(x.profile) && !!g?.leftRunning && (g.status === "running" || g.status === "starting");
    });
  const activeDownloads = lib.models.filter((m) => m.task && (m.task.status === "running" || m.task.status === "queued")).length;

  // Each tab has an address: switching pushes a history entry (Back returns to the previous
  // tab), reload reopens it, and the choice survives relaunch.
  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (window.location.hash.slice(1) !== next) {
      const url = `${window.location.pathname}${window.location.search}#${next}`;
      window.history.pushState(null, "", url);
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Storage blocked: the hash still keeps the tab for this session.
    }
  }, [tab]);
  useEffect(() => {
    if (window.location.hash.slice(1) !== tab) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${tab}`);
    }
    const onHash = () => {
      const h = window.location.hash.slice(1);
      setTabState(TABS.some((t) => t.id === h) ? (h as Tab) : "create");
    };
    window.addEventListener("popstate", onHash);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onHash);
      window.removeEventListener("hashchange", onHash);
    };
    // Mount only: later tab changes write the hash in setTab.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const t = TABS.find((x) => x.key === e.key);
      if (t) {
        e.preventDefault();
        setTab(t.id);
      }
      if (e.key === ",") {
        e.preventDefault();
        setTab("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    // Stop the browser from navigating to files dropped outside a drop zone.
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, [setTab]);

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand__mark" aria-hidden />
          <span className="brand__name" title="Image Studio">Image Studio</span>
          {!inTauri && <span className="badge badge--mock" title="Running in a browser with the in-memory mock">Dev mock</span>}
        </div>
        <nav
          className="tabs"
          role="tablist"
          aria-label="Sections"
          onKeyDown={radioKeys(
            TABS.map((t) => t.id),
            tab,
            setTab,
          )}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
              title={`${t.label} (⌘${t.key})`}
            >
              <Icon name={t.icon} />
              <span className="tab__label">{t.label}</span>
              {t.id === "models" && activeDownloads > 0 && <span className="tab__dot" aria-label={`${activeDownloads} downloading`} />}
            </button>
          ))}
        </nav>
        <div className="toolbar__end" data-tauri-drag-region>
          {vault.unlocked && (
            <div className="vault-pill" role="status" aria-label="Vault unlocked">
              <Icon name="lockOpen" size={13} />
              <span className="vault-pill__text">
                Vault<span className="vault-pill__more"> unlocked</span>
              </span>
              <button
                type="button"
                className="btn btn--sm vault-pill__btn"
                onClick={() => void vault.lock()}
                title="Lock the vault now — its items disappear until you unlock"
              >
                <Icon name="lock" size={13} /> Lock
              </button>
            </div>
          )}
          <GpuPills />
        </div>
      </header>

      {needsSetup && (
        <div className="banner" role="status">
          <Icon name="key" />
          <span>
            Add your RunPod API key to start generating.
          </span>
          {tab !== "settings" && (
            <button type="button" className="link-btn" onClick={() => setTab("settings")}>
              Open Settings →
            </button>
          )}
        </div>
      )}

      {leftRunning.length > 0 && (
        <div className="banner banner--warn" role="status">
          <Icon name="alert" />
          <span>
            {leftRunning.length > 1 ? "GPU pods are still running: " : "A GPU pod is still running: "}
            {leftRunning
              .map((x) => `${PROFILE_LABEL[x.profile]}${x.state?.gpuType ? ` (${x.gpuName}, ${x.costLabel})` : ` (${x.costLabel})`}`)
              .join(" and ")}
            .
          </span>
          <span className="banner__actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => leftRunning.forEach((x) => gpu.stop(x.profile))}
            >
              <Icon name="stop" size={13} /> {leftRunning.length > 1 ? "Stop them" : "Stop it"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setKeptPods((k) => new Set([...k, ...leftRunning.map((x) => x.profile)]))}
            >
              {leftRunning.length > 1 ? "Keep them" : "Keep it"}
            </button>
          </span>
        </div>
      )}

      {TABS.map((t) => (
        <section
          key={t.id}
          id={`panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${t.id}`}
          className="screen"
          hidden={tab !== t.id}
        >
          {t.id === "create" && <CreateScreen active={tab === "create"} onNavigate={setTab} />}
          {t.id === "models" && <ModelsScreen active={tab === "models"} />}
          {t.id === "settings" && <SettingsScreen />}
        </section>
      ))}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <LibraryProvider>
          <GpuProvider>
            <VaultProvider>
              <Shell />
            </VaultProvider>
          </GpuProvider>
        </LibraryProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
