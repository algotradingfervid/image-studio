import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX, type MutableRefObject } from "react";
import * as api from "../../../api";
import type { ImageRecord, Job, Shot, Story, StoryPatch, StoryView, Voice } from "../../../api";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { useGpu } from "../../../state/gpu";
import { useToast } from "../../../state/toast";
import { LOCK_DISCARD_TOAST, useVault } from "../../../state/vault";
import type { JobView } from "../JobCard";
import { ShotCard } from "./ShotCard";
import "./workspace.css";

/** Same restriction VideoPanel restates for every H3 model in the paid confirmation (UI-054). */
const H3_LICENCE = "Runs in Canada — licence excludes EU/UK/KR/US";
const SAVE_DEBOUNCE_MS = 600;
const NEW_PREFIX = "new:";
/** The inline export confirm ignores clicks this long after it opens (as the Lightbox's, UX-006). */
const ARM_MS = 400;

/**
 * Takes being rendered, per story → shot id → job id. Module-level so switching tabs (which
 * unmounts the workspace) keeps the cards' render status.
 */
const renderingStore = new Map<string, Record<string, string>>();

/** Shot saves still running after their workspace unmounted, per story: the next load waits for them. */
const pendingSaves = new Map<string, Promise<unknown>>();

const blankShot = (storyId: string, n: number, cast: string[]): Shot => ({
  id: `${NEW_PREFIX}${n}`,
  storyId,
  position: 0,
  durationS: 8,
  characters: cast.slice(0, 1),
  setting: "",
  camera: "",
  action: "",
  dialogue: [],
  sound: "",
  continuity: "cut",
  approvedTakeId: null,
});

/** The story's voices from the edited phrases, in cast order; empty phrases are dropped. */
const voicesFrom = (draft: Record<string, string>, base: Story): Voice[] =>
  base.cast.map((id) => ({ characterId: id, voice: (draft[id] ?? "").trim() })).filter((v) => v.voice);

/** Positions 1..n in list order; the first shot is always a cut; new shots go out with an empty id. */
const toWire = (shots: Shot[]): Shot[] =>
  shots.map((s, i) => ({
    ...s,
    id: s.id.startsWith(NEW_PREFIX) ? "" : s.id,
    position: i + 1,
    continuity: i === 0 ? "cut" : s.continuity,
  }));

/** What the screen can ask of the open workspace (the left panel's Plan story uses it). */
export interface WorkspaceHandle {
  storyId: string;
  /** Send every pending edit (shots, voices, title) now and wait until all have landed. */
  flush: () => Promise<void>;
  /** A plan replaced the story: drop pending edits; nothing is sent when the workspace goes. */
  discard: () => void;
}

interface WorkspaceProps {
  storyId: string | null;
  jobs: JobView[];
  onChanged?: () => void;
  /** The story is being planned from the left panel: everything is read-only. */
  planning?: boolean;
  /** Set to the open workspace's handle (null while none is open). */
  handle?: MutableRefObject<WorkspaceHandle | null>;
  /** Whether any of the story's shots is rendering (the panel blocks Delete / Plan again meanwhile). */
  onRenderingChange?: (rendering: boolean) => void;
  /** Changes when the story was saved elsewhere (the panel): reload it. */
  refreshKey?: number;
}

export function StoryWorkspace(props: WorkspaceProps): JSX.Element {
  if (!props.storyId) {
    return (
      <div className="empty story-ws__empty">
        <div className="empty__art">
          <Icon name="video" size={26} />
        </div>
        <h3>No story selected</h3>
        <p>Create or pick a story on the left.</p>
      </div>
    );
  }
  return <Workspace key={props.storyId} {...props} storyId={props.storyId} />;
}

function Workspace({
  storyId,
  jobs,
  onChanged,
  planning = false,
  handle,
  onRenderingChange,
  refreshKey,
}: WorkspaceProps & { storyId: string }) {
  const toast = useToast();
  const gpu = useGpu();
  const vault = useVault();
  const id = useId();
  const [view, setView] = useState<StoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "error">("idle");
  const [rendering, setRenderingState] = useState<Record<string, string>>(() => renderingStore.get(storyId) ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<null | { kind: "replan" } | { kind: "delete"; index: number; key: string }>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleDraftRef = useRef(titleDraft);
  titleDraftRef.current = titleDraft;
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  /** Unsaved voice phrases (character id → phrase); null = show the saved ones. */
  const [voiceDraft, setVoiceDraft] = useState<Record<string, string> | null>(null);
  const voiceDraftRef = useRef(voiceDraft);
  voiceDraftRef.current = voiceDraft;
  const voiceTimer = useRef<number | null>(null);
  const voiceVersion = useRef(0);
  const [voiceError, setVoiceError] = useState(false);
  /** Story updates (voices, title) run one at a time, each built from the latest story. */
  const storyOps = useRef<Promise<void> | null>(null);
  const storyRef = useRef<Story | null>(null);
  storyRef.current = view?.story ?? null;
  /**
   * Requests are numbered in send order; a response is adopted only if no later-sent request's
   * response is already on screen (a slow save must not restore an older story over a refetch).
   */
  const sentSeq = useRef(0);
  const shownSeq = useRef(0);

  const keyOf = useRef(new Map<string, string>());
  const newCounter = useRef(0);
  const version = useRef(0);
  const timer = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const renderingRef = useRef(rendering);
  renderingRef.current = rendering;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const alive = useRef(true);
  /** Set by `discard()`: a plan replaced the story, so pending edits are never sent. */
  const discarded = useRef(false);
  const [busy, setBusy] = useState<null | "plan" | "render" | "assemble" | "approve">(null);
  /** While a plan runs (from here or the panel) nothing can be edited. */
  const readOnly = planning || busy === "plan";
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  useEffect(() => {
    // Set on (re)mount too: StrictMode's simulated unmount would otherwise leave it false.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setRendering = useCallback(
    (fn: (r: Record<string, string>) => Record<string, string>) => {
      setRenderingState((r) => {
        const next = fn(r);
        renderingStore.set(storyId, next);
        return next;
      });
    },
    [storyId],
  );

  const nextSeq = useCallback(() => ++sentSeq.current, []);
  /** True (and marks it shown) when request `n`'s response is not older than the view on screen. */
  const isFresh = useCallback((n: number) => {
    if (n < shownSeq.current) return false;
    shownSeq.current = n;
    return true;
  }, []);

  /** Adopt a server view. `withShots`: also replace the local shot list (no newer local edits). */
  const adopt = useCallback((v: StoryView, withShots = true) => {
    setView(v);
    storyRef.current = v.story;
    if (withShots) {
      setShots(v.shots);
      shotsRef.current = v.shots;
    }
  }, []);

  const refetch = useCallback(async () => {
    try {
      await pendingSaves.get(storyId);
      const n = nextSeq();
      const v = await api.getStory(storyId);
      if (!alive.current || !isFresh(n)) return;
      // Unsaved edits win over the refetched shot list.
      adopt(v, timer.current === null && inflight.current === null);
    } catch (e) {
      if (!alive.current) return;
      // With a story on screen keep it: a failed refresh is not worth hiding the workspace.
      if (storyRef.current) toastRef.current.error("Couldn't refresh the story", e);
      else setLoadError(api.errorMessage(e));
    }
  }, [storyId, adopt, nextSeq, isFresh]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Opened while the vault was locked (the lock screen): unlocking loads the story.
  const lockedOut = !!loadError?.startsWith("VAULT_LOCKED");
  useEffect(() => {
    if (!vault.unlocked || !lockedOut) return;
    setLoadError(null);
    void refetch();
  }, [vault.unlocked, lockedOut, refetch]);

  // The panel saved the story (brief, length, aspect, style, cast): show its cast, target and issues.
  const firstRefresh = useRef(refreshKey);
  useEffect(() => {
    if (firstRefresh.current === refreshKey) return;
    firstRefresh.current = refreshKey;
    void refetch();
  }, [refreshKey, refetch]);

  // ---- saving shot edits (debounced) ----
  const save = useCallback(async () => {
    timer.current = null;
    const v = version.current;
    const sent = shotsRef.current;
    setSaveState("saving");
    try {
      const n = nextSeq();
      const res = await api.saveShots(storyId, toWire(sent));
      if (!alive.current) return;
      const unchanged = version.current === v;
      if (unchanged) {
        // New shots got real ids: keep their React keys so focus stays where it is.
        res.shots.forEach((s, i) => {
          const before = sent[i];
          if (before && before.id !== s.id) keyOf.current.set(s.id, keyOf.current.get(before.id) ?? before.id);
        });
      }
      if (isFresh(n)) adopt(res, unchanged);
      else if (unchanged) {
        // A newer view is on screen: keep it, but take the saved shots (new shots' real ids).
        setShots(res.shots);
        shotsRef.current = res.shots;
      }
      setSaveState(timer.current !== null ? "pending" : "idle");
    } catch (e) {
      // The toast provider lives at the app root: report the failure even after this workspace is gone.
      if (api.errorCode(e) === "VAULT_LOCKED" && storyRef.current?.vault) toast.notify(LOCK_DISCARD_TOAST);
      else toast.error("Could not save your shot edits", e);
      if (alive.current) setSaveState("error");
    }
  }, [storyId, adopt, toast, nextSeq, isFresh]);

  const runSave = useCallback(() => {
    const p = (inflight.current ?? Promise.resolve()).then(save);
    const mine = p.finally(() => {
      if (inflight.current === mine) inflight.current = null;
    });
    inflight.current = mine;
    return mine;
  }, [save]);

  // ---- story updates: voices (debounced like shot edits) and title, one at a time ----
  /**
   * Queue a story update; `make` builds the patch (only the fields this workspace edits) from the
   * latest story when its turn comes.
   */
  const runStoryOp = useCallback(
    (make: (base: Story) => StoryPatch | null, onDone?: (res: StoryView) => void, onError?: (e: unknown) => void) => {
      const op = async () => {
        const base = storyRef.current;
        const patch = base ? make(base) : null;
        if (!patch) return;
        const n = nextSeq();
        try {
          const res = await api.updateStory(storyId, patch);
          if (!alive.current) return;
          if (isFresh(n)) {
            storyRef.current = res.story;
            setView((cur) => (cur ? { ...cur, story: res.story, issues: res.issues } : res));
          }
          onDone?.(res);
        } catch (e) {
          onError?.(e);
        }
      };
      const p = (storyOps.current ?? Promise.resolve()).then(op);
      const mine = p.finally(() => {
        if (storyOps.current === mine) storyOps.current = null;
      });
      storyOps.current = mine;
      return mine;
    },
    [storyId, nextSeq, isFresh],
  );

  const runVoiceSave = useCallback(() => {
    voiceTimer.current = null;
    const v = voiceVersion.current;
    return runStoryOp(
      (base) => {
        const draft = voiceDraftRef.current;
        return draft ? { voices: voicesFrom(draft, base) } : null;
      },
      () => {
        setVoiceError(false);
        if (voiceVersion.current === v) {
          voiceDraftRef.current = null;
          setVoiceDraft(null);
        }
      },
      (e) => {
        toastRef.current.error("Couldn't save the voices", e);
        if (alive.current) setVoiceError(true);
      },
    );
  }, [runStoryOp]);

  /** Send a pending voice edit now and wait for every story update to land. */
  const flushVoices = useCallback(async () => {
    if (voiceTimer.current !== null) {
      window.clearTimeout(voiceTimer.current);
      await runVoiceSave();
    } else if (storyOps.current) {
      await storyOps.current;
    }
  }, [runVoiceSave]);

  /** Save any pending edit (shots and voices) now and wait for every save to land. */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      await runSave();
    } else if (inflight.current) {
      await inflight.current;
    }
    await flushVoices();
  }, [runSave, flushVoices]);

  const edit = useCallback(
    (list: Shot[]) => {
      if (readOnlyRef.current) return;
      const next = list[0]?.continuity === "continues" ? [{ ...list[0], continuity: "cut" as const }, ...list.slice(1)] : list;
      version.current += 1;
      setShots(next);
      shotsRef.current = next;
      setSaveState("pending");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void runSave(), SAVE_DEBOUNCE_MS);
    },
    [runSave],
  );

  // The vault locked under a vault story (the workspace remounts on lockEpoch): its pending edits
  // can't be saved, so they are dropped — before the cleanups below would try to send them.
  useEffect(
    () => () => {
      if (!storyRef.current?.vault || vault.isUnlocked()) return;
      const pending =
        timer.current !== null ||
        voiceTimer.current !== null ||
        voiceDraftRef.current !== null ||
        titleDraftRef.current !== null ||
        saveStateRef.current !== "idle";
      discard();
      if (pending) toastRef.current.notify(LOCK_DISCARD_TOAST);
    },
    // Unmount only (discard and isUnlocked are stable; discard is declared further down).
    [storyId],
  );

  // Leaving the story: send what's pending (unless a plan replaced it).
  useEffect(
    () => () => {
      let p: Promise<unknown> | null = inflight.current;
      if (timer.current !== null && !discarded.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
        const wire = toWire(shotsRef.current);
        const t = toastRef.current;
        p = (inflight.current ?? Promise.resolve())
          .then(() => api.saveShots(storyId, wire))
          .catch((e) => t.error("Could not save your shot edits", e));
      }
      if (p) {
        const mine = p.catch(() => {});
        pendingSaves.set(storyId, mine);
        void mine.finally(() => {
          if (pendingSaves.get(storyId) === mine) pendingSaves.delete(storyId);
        });
      }
    },
    [storyId],
  );

  /** A plan replaced the story: pending edits are dropped and never sent (not even on unmount). */
  const discard = useCallback(() => {
    discarded.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    version.current += 1;
    voiceVersion.current += 1;
    voiceDraftRef.current = null;
  }, []);

  useEffect(() => {
    if (!handle) return;
    const mine: WorkspaceHandle = { storyId, flush, discard };
    handle.current = mine;
    return () => {
      if (handle.current === mine) handle.current = null;
    };
  }, [handle, storyId, flush, discard]);

  // ---- job tracking ----
  useEffect(() => {
    const un = api.onEvent("job-update", (job: Job) => {
      const entry = Object.entries(renderingRef.current).find(([, id]) => id === job.jobId);
      if (!entry) return;
      const [shotId] = entry;
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        setRendering((r) => {
          const { [shotId]: _, ...rest } = r;
          return rest;
        });
        if (job.status === "failed") setErrors((e) => ({ ...e, [shotId]: job.error ?? "The render failed" }));
        void refetch();
      }
    });
    return () => void un.then((f) => f());
  }, [refetch, setRendering]);

  // A job may have finished while this workspace was unmounted.
  useEffect(() => {
    const done = Object.entries(rendering).filter(([, id]) => {
      const j = jobs.find((x) => x.jobId === id);
      return j && (j.status === "completed" || j.status === "failed" || j.status === "cancelled");
    });
    if (!done.length) return;
    setRendering((r) => {
      const next = { ...r };
      for (const [s] of done) delete next[s];
      return next;
    });
    const failed = done.map(([s, id]) => [s, jobs.find((x) => x.jobId === id)!] as const).filter(([, j]) => j.status === "failed");
    if (failed.length) setErrors((e) => ({ ...e, ...Object.fromEntries(failed.map(([s, j]) => [s, j.error ?? "The render failed"])) }));
    void refetch();
    // Runs on jobs changes only.
  }, [jobs]);

  const track = (pairs: { shotId: string; jobId: string }[]) => {
    if (!pairs.length) return;
    setErrors((e) => {
      const next = { ...e };
      for (const p of pairs) delete next[p.shotId];
      return next;
    });
    setRendering((r) => ({ ...r, ...Object.fromEntries(pairs.map((p) => [p.shotId, p.jobId])) }));
  };

  // ---- derived ----
  const story = view?.story ?? null;
  const cast = view?.cast ?? [];
  const takesByShot = useMemo(() => {
    const m = new Map<string, ImageRecord[]>();
    const sorted = [...(view?.takes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const t of sorted) if (t.shotId) m.set(t.shotId, [...(m.get(t.shotId) ?? []), t]);
    return m;
  }, [view?.takes]);
  const storyIssues = (view?.issues ?? []).filter((i) => i.shot === null).map((i) => i.message);
  const issuesAt = (pos: number) => (view?.issues ?? []).filter((i) => i.shot === pos).map((i) => i.message);
  const issueCount = view?.issues.length ?? 0;
  const dirty = saveState === "pending" || saveState === "saving";
  const blocked = issueCount > 0 ? "Fix the problems listed on the shots first" : null;
  const allApproved = shots.length > 0 && shots.every((s) => !!s.approvedTakeId);
  const anyRendering = Object.keys(rendering).length > 0;
  const onRenderingChangeRef = useRef(onRenderingChange);
  onRenderingChangeRef.current = onRenderingChange;
  useEffect(() => {
    onRenderingChangeRef.current?.(anyRendering);
  }, [anyRendering]);
  useEffect(() => () => onRenderingChangeRef.current?.(false), []);

  // ---- actions ----
  const renderOne = async (shot: Shot) => {
    setBusy("render");
    try {
      await flush();
      const fresh = shotsRef.current.find((s) => s.id === shot.id || keyOf.current.get(s.id) === shot.id) ?? shot;
      if (fresh.id.startsWith(NEW_PREFIX)) throw new Error("This shot isn't saved yet");
      if (!(await gpu.confirmStart("render the story's shots", "video", { licence: H3_LICENCE }))) return;
      const { jobId } = await api.renderShot(fresh.id);
      track([{ shotId: fresh.id, jobId }]);
    } catch (e) {
      toast.error("Couldn't render the shot", e);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const renderAll = async () => {
    setBusy("render");
    try {
      await flush();
      if (!(await gpu.confirmStart("render the story's shots", "video", { licence: H3_LICENCE }))) return;
      const { queued, error } = await api.renderStory(storyId);
      // Every queued render is tracked, also when another shot couldn't start.
      track(queued);
      if (error) {
        toast.error(queued.length ? "Some shots couldn't render" : "Couldn't render the story", error);
        void refetch();
      } else if (!queued.length) toast.info("Nothing to render", "Every shot that can render has a take. Use Reroll for a new take.");
    } catch (e) {
      toast.error("Couldn't render the story", e);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const replan = async () => {
    setConfirm(null);
    setBusy("plan");
    try {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (inflight.current) await inflight.current;
      // Voice edits and renames land before the plan, so no late reply can bring back the old story.
      await flushVoices();
      const n = nextSeq();
      const v = await api.planStory(storyId);
      // The plan replaces everything sent before it.
      shownSeq.current = Math.max(shownSeq.current, n);
      voiceVersion.current += 1;
      voiceDraftRef.current = null;
      setVoiceDraft(null);
      version.current += 1;
      setRendering(() => ({}));
      setErrors({});
      adopt(v);
      setSaveState("idle");
      onChangedRef.current?.();
    } catch (e) {
      toast.error("Couldn't plan the story", e);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const approve = async (shotId: string, takeId: string) => {
    setBusy("approve");
    try {
      await flush();
      // The backend renders the next shot right away when it continues this one and has no takes.
      const list = shotsRef.current;
      const i = list.findIndex((s) => s.id === shotId);
      const next = i >= 0 ? list[i + 1] : undefined;
      if (next && next.continuity === "continues" && !takesByShot.get(next.id)?.length) {
        const ok = await gpu.confirmStart(`render shot ${i + 2} (continues shot ${i + 1})`, "video", { licence: H3_LICENCE });
        if (!ok) {
          toast.info(`Not approved — approving shot ${i + 1} starts shot ${i + 2} on the GPU`);
          return;
        }
      }
      const n = nextSeq();
      const res = await api.approveTake(shotId, takeId);
      if (isFresh(n)) adopt(res.view, timer.current === null);
      if (res.queued) track([res.queued]);
      onChangedRef.current?.();
    } catch (e) {
      toast.error("Couldn't approve the take", e);
      // The approval may have been saved before starting the next shot failed: show what the backend has.
      void refetch();
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // A vault film's Export opens the Lightbox's inline confirm first (the copy is not encrypted).
  const [confirmExport, setConfirmExport] = useState(false);
  const exportArmedAt = useRef(0);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const openExportConfirm = () => {
    exportArmedAt.current = Date.now() + ARM_MS;
    setConfirmExport(true);
  };
  const closeExportConfirm = () => {
    setConfirmExport(false);
    requestAnimationFrame(() => exportBtnRef.current?.focus());
  };

  const exportFilm = async () => {
    const film = view?.result;
    if (!film) return;
    if (film.vault) {
      if (Date.now() < exportArmedAt.current) return;
      setConfirmExport(false);
    }
    try {
      const dest = await api.pickSavePath(`${(story?.title || "story").replace(/[\\/:]/g, "-")}.mp4`);
      if (!dest) return;
      await api.exportImage({ id: film.id, destPath: dest });
      // A vault film's path holds the story title: not shown, so nothing of it outlives a lock on screen.
      if (film.vault) toast.success("Film exported — not encrypted");
      else toast.success("Film exported", dest);
    } catch (e) {
      toast.error("Couldn't export the film", e);
    }
  };

  const assemble = async () => {
    setBusy("assemble");
    try {
      await flush();
      const n = nextSeq();
      const v = await api.assembleStory(storyId);
      if (isFresh(n)) adopt(v, timer.current === null);
      onChangedRef.current?.();
      toast.notify({ kind: "success", title: "Film assembled" });
    } catch (e) {
      toast.error("Couldn't assemble the story", e);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const saveTitle = async () => {
    if (!story || titleDraft === null) return;
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (title === story.title) return;
    await runStoryOp(
      () => ({ title }),
      () => onChangedRef.current?.(),
      (e) => toast.error("Couldn't rename the story", e),
    );
  };

  const editVoice = (characterId: string, voice: string) => {
    if (!story || readOnlyRef.current) return;
    const current = voiceDraft ?? Object.fromEntries(story.voices.map((x) => [x.characterId, x.voice]));
    const next = { ...current, [characterId]: voice };
    voiceVersion.current += 1;
    setVoiceDraft(next);
    voiceDraftRef.current = next;
    if (voiceTimer.current !== null) window.clearTimeout(voiceTimer.current);
    voiceTimer.current = window.setTimeout(() => void runVoiceSave(), SAVE_DEBOUNCE_MS);
  };

  // Leaving the story: send pending voice edits (unless a plan replaced them).
  useEffect(
    () => () => {
      if (voiceTimer.current === null || discarded.current) return;
      window.clearTimeout(voiceTimer.current);
      voiceTimer.current = null;
      const base = storyRef.current;
      const draft = voiceDraftRef.current;
      if (!base || !draft) return;
      const t = toastRef.current;
      // After any story update still running; only the voices are sent.
      const p = (storyOps.current ?? Promise.resolve())
        .then(() => {
          const latest = storyRef.current ?? base;
          return api.updateStory(storyId, { voices: voicesFrom(draft, latest) });
        })
        .catch((e) => t.error("Couldn't save the voices", e));
      const prev = pendingSaves.get(storyId);
      const mine = Promise.all([prev, p]).catch(() => {});
      pendingSaves.set(storyId, mine);
      void mine.finally(() => {
        if (pendingSaves.get(storyId) === mine) pendingSaves.delete(storyId);
      });
    },
    [storyId],
  );

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= shots.length) return;
    const next = [...shots];
    [next[i], next[j]] = [next[j], next[i]];
    edit(next);
  };

  const addShot = () => {
    newCounter.current += 1;
    edit([...shots, blankShot(storyId, newCounter.current, story?.cast ?? [])]);
  };

  // ---- render ----
  if ((view?.story.vault || lockedOut) && !vault.unlocked) {
    return (
      <div className="empty story-ws__empty story-ws__locked">
        <div className="empty__art">
          <Icon name="lock" size={26} />
        </div>
        <h3>This story is in the vault.</h3>
        <p>Unlock to continue.</p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => vault.requestUnlock()}>
          <Icon name="unlock" size={14} /> Unlock
        </button>
      </div>
    );
  }
  if (loadError && !view && !lockedOut) {
    return (
      <div className="story-ws">
        <p className="notice notice--error" role="alert">
          <Icon name="alert" /> {loadError}
        </p>
        <button type="button" className="btn btn--sm" onClick={() => void refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!view || !story) {
    return (
      <div className="story-ws story-ws__loading">
        <Icon name="refresh" className="spin" /> Loading story…
      </div>
    );
  }

  const deleteTakes = confirm?.kind === "delete" ? (takesByShot.get(shots[confirm.index]?.id ?? "")?.length ?? 0) : 0;
  const deleteText =
    deleteTakes === 0
      ? "Removes the shot and its text from the story."
      : `Removes the shot and its text from the story, and deletes its ${deleteTakes === 1 ? "take (rendered video)" : `${deleteTakes} takes (rendered videos)`}${shots[confirm?.kind === "delete" ? confirm.index : -1]?.approvedTakeId ? ", including the approved one" : ""}.`;

  const assembleTitle = !shots.length
    ? "Plan the story first"
    : !allApproved
      ? `Approve a take for every shot (${shots.filter((s) => s.approvedTakeId).length} of ${shots.length})`
      : dirty
        ? "Saving your edits…"
        : undefined;

  return (
    <div className="story-ws">
      {/* Read-only while a plan runs: a disabled fieldset disables every control inside it. */}
      <fieldset className="story-ws__lock" disabled={readOnly} aria-busy={readOnly}>
      {planning && (
        <p className="notice notice--inline" role="status">
          <Icon name="refresh" className="spin" /> Planning the story… editing is paused until the new shot list arrives.
        </p>
      )}
      <header className="story-ws__head">
        <div className="story-ws__titles">
          {titleDraft === null ? (
            <h2 className="story-ws__title">
              <button type="button" className="story-ws__title-btn" title="Rename" onClick={() => setTitleDraft(story.title)}>
                {story.title || "Untitled story"}
              </button>
            </h2>
          ) : (
            <input
              className="input story-ws__title-input"
              aria-label="Story title"
              autoFocus
              value={titleDraft}
              maxLength={120}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTitle();
                if (e.key === "Escape") setTitleDraft(null);
              }}
            />
          )}
          {story.logline && <p className="story-ws__logline">{story.logline}</p>}
          <p className="story-ws__meta">
            {shots.length} {shots.length === 1 ? "shot" : "shots"} · {shots.reduce((n, s) => n + s.durationS, 0)} s of {story.targetS} s · {story.aspect}
            {saveState === "saving" && <span className="story-ws__save"> · Saving…</span>}
            {saveState === "pending" && <span className="story-ws__save"> · Unsaved edits</span>}
            {saveState === "error" && <span className="story-ws__save is-error"> · Not saved</span>}
            {voiceError && <span className="story-ws__save is-error"> · Voices not saved</span>}
          </p>
          {cast.length > 0 && (
            <fieldset className="story-ws__voices">
              <legend className="story-ws__voices-label">Voices</legend>
              {cast.map((c) => {
                const value = voiceDraft?.[c.id] ?? story.voices.find((x) => x.characterId === c.id)?.voice ?? "";
                return (
                  <label key={c.id} className="story-ws__voice">
                    <span className="story-ws__voice-name">{c.name}</span>
                    <input
                      className="input"
                      aria-label={`${c.name}'s voice`}
                      placeholder="a low, steady female voice with a calm pace"
                      value={value}
                      maxLength={200}
                      onChange={(e) => editVoice(c.id, e.target.value)}
                    />
                  </label>
                );
              })}
            </fieldset>
          )}
        </div>
        <div className="btn-row story-ws__actions">
          <button type="button" className="btn btn--sm" disabled={!!busy || anyRendering} onClick={() => (shots.length ? setConfirm({ kind: "replan" }) : void replan())}>
            {busy === "plan" ? <Icon name="refresh" className="spin" size={14} /> : <Icon name="wand" size={14} />}{" "}
            {busy === "plan" ? "Planning…" : shots.length ? "Re-plan" : "Plan story"}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!!busy || !shots.length || !!blocked}
            title={blocked ?? (!shots.length ? "Plan the story first" : undefined)}
            onClick={() => void renderAll()}
          >
            {busy === "render" ? <Icon name="refresh" className="spin" size={14} /> : <Icon name="play" size={14} />} Render all
          </button>
          <button type="button" className="btn btn--sm" disabled={!!busy || !allApproved || dirty} title={assembleTitle} onClick={() => void assemble()}>
            {busy === "assemble" ? <Icon name="refresh" className="spin" size={14} /> : <Icon name="layers" size={14} />}{" "}
            {busy === "assemble" ? "Assembling…" : "Assemble"}
          </button>
        </div>
      </header>

      {storyIssues.length > 0 && (
        <div className="notice notice--warn story-ws__issues" role="status">
          <Icon name="alert" />
          <ul className="plain">
            {storyIssues.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {view.result && (
        <section className="story-film" aria-labelledby={`${id}-film`}>
          <h3 id={`${id}-film`} className="story-film__title">
            <Icon name="layers" size={14} /> Final film
          </h3>
          <video
            className="story-film__player"
            controls
            playsInline
            preload="metadata"
            src={api.fileSrc(view.result.path)}
            poster={view.result.posterPath ? api.fileSrc(view.result.posterPath) : undefined}
          />
          <div
            className="story-film__actions confirm-slot"
            onKeyDown={(e) => {
              if (e.key === "Escape" && confirmExport) {
                e.stopPropagation();
                closeExportConfirm();
              }
            }}
          >
            {!view.result.vault && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void api.revealImage(view.result!.id).catch((e) => toast.error("Couldn't show the film", e))}
              >
                Show in Finder
              </button>
            )}
            {view.result.vault && confirmExport ? (
              <button type="button" className="btn btn--sm" onClick={closeExportConfirm} aria-describedby={`${id}-export`} autoFocus>
                <Icon name="x" size={14} /> Cancel
              </button>
            ) : (
              <button
                ref={exportBtnRef}
                type="button"
                className="btn btn--sm"
                onClick={() => (view.result?.vault ? openExportConfirm() : void exportFilm())}
                title={view.result.vault ? "Vault films are exported as an unencrypted copy" : undefined}
              >
                <Icon name="download" size={14} /> Export…
              </button>
            )}
            {view.result.vault && <span className="hint">Encrypted in the vault.</span>}
            {view.result.vault && confirmExport && (
              <div className="confirm confirm-pop confirm--note" role="group" aria-label="Export from the vault">
                <span id={`${id}-export`}>
                  <Icon name="alert" size={13} /> The exported copy is <strong>not encrypted</strong> — anyone with access to where you save it can open it.
                </span>
                <div className="btn-row confirm-pop__row">
                  <button type="button" className="btn btn--warn-outline btn--sm" onClick={() => void exportFilm()}>
                    <Icon name="download" size={13} /> Choose where to save…
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {shots.length === 0 ? (
        <div className="empty story-ws__empty">
          <h3>No shots yet</h3>
          <p>{busy === "plan" ? "Planning the shots…" : "Plan the story to get a shot list, or add shots yourself."}</p>
          <button type="button" className="btn btn--sm story-ws__add" onClick={addShot}>
            <Icon name="plus" size={14} /> Add shot
          </button>
        </div>
      ) : (
        <ol className="plain story-ws__shots">
          {shots.map((s, i) => {
            const key = keyOf.current.get(s.id) ?? s.id;
            const prev = shots[i - 1];
            const waitsFor = i > 0 && s.continuity === "continues" && !prev?.approvedTakeId ? i : null;
            return (
              <li key={key}>
                <ShotCard
                  shot={s}
                  index={i}
                  count={shots.length}
                  cast={cast}
                  aspect={story.aspect}
                  takes={takesByShot.get(s.id) ?? []}
                  issues={issuesAt(i + 1)}
                  waitsFor={waitsFor}
                  blocked={blocked}
                  rendering={!!rendering[s.id]}
                  job={jobs.find((j) => j.jobId === rendering[s.id])}
                  error={errors[s.id] ?? null}
                  busy={!!busy}
                  onChange={(next) => edit(shots.map((x, j) => (j === i ? next : x)))}
                  onMove={(dir) => move(i, dir)}
                  onDelete={() => setConfirm({ kind: "delete", index: i, key })}
                  onRender={() => void renderOne(s)}
                  onApprove={(takeId) => void approve(s.id, takeId)}
                />
              </li>
            );
          })}
          <li>
            <button type="button" className="btn btn--sm story-ws__add" onClick={addShot}>
              <Icon name="plus" size={14} /> Add shot
            </button>
          </li>
        </ol>
      )}

      </fieldset>

      <Dialog
        open={confirm?.kind === "replan"}
        onClose={() => setConfirm(null)}
        title="Re-plan the story?"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void replan()}>
              Re-plan
            </button>
          </>
        }
      >
        <p>
          Replaces all shots and deletes every take (rendered video) of the current shots, approved ones included. The local model writes a new
          shot list from the brief.
        </p>
      </Dialog>

      <Dialog
        open={confirm?.kind === "delete"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "delete" ? `Delete shot ${confirm.index + 1}?` : "Delete shot?"}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                if (confirm?.kind !== "delete") return;
                const k = confirm.key;
                setConfirm(null);
                edit(shots.filter((x) => (keyOf.current.get(x.id) ?? x.id) !== k));
              }}
            >
              <Icon name="trash" size={14} /> Delete shot
            </button>
          </>
        }
      >
        <p>{deleteText}</p>
      </Dialog>
    </div>
  );
}
