import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import * as api from "../../../api";
import type { ImageRecord, Job, Shot, StoryView } from "../../../api";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { useGpu } from "../../../state/gpu";
import { useToast } from "../../../state/toast";
import type { JobView } from "../JobCard";
import { ShotCard } from "./ShotCard";
import "./workspace.css";

/** Same restriction VideoPanel restates for every H3 model in the paid confirmation (UI-054). */
const H3_LICENCE = "Runs in Canada — licence excludes EU/UK/KR/US";
const SAVE_DEBOUNCE_MS = 600;
const NEW_PREFIX = "new:";

/**
 * Takes being rendered, per story → shot id → job id. Module-level so switching tabs (which
 * unmounts the workspace) keeps the cards' render status.
 */
const renderingStore = new Map<string, Record<string, string>>();

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
  continuity: "cut",
  approvedTakeId: null,
});

/** Positions 1..n in list order; the first shot is always a cut; new shots go out with an empty id. */
const toWire = (shots: Shot[]): Shot[] =>
  shots.map((s, i) => ({
    ...s,
    id: s.id.startsWith(NEW_PREFIX) ? "" : s.id,
    position: i + 1,
    continuity: i === 0 ? "cut" : s.continuity,
  }));

export function StoryWorkspace(props: {
  storyId: string | null;
  jobs: JobView[];
  onOpenImage: (im: ImageRecord) => void;
  onChanged?: () => void;
}): JSX.Element {
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
  onOpenImage,
  onChanged,
}: {
  storyId: string;
  jobs: JobView[];
  onOpenImage: (im: ImageRecord) => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const gpu = useGpu();
  const [view, setView] = useState<StoryView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "error">("idle");
  const [rendering, setRenderingState] = useState<Record<string, string>>(() => renderingStore.get(storyId) ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | "plan" | "render" | "assemble" | "approve">(null);
  const [confirm, setConfirm] = useState<null | { kind: "replan" } | { kind: "delete"; index: number }>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);

  const keyOf = useRef(new Map<string, string>());
  const newCounter = useRef(0);
  const version = useRef(0);
  const timer = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const renderingRef = useRef(rendering);
  renderingRef.current = rendering;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

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

  /** Adopt a server view. `withShots`: also replace the local shot list (no newer local edits). */
  const adopt = useCallback((v: StoryView, withShots = true) => {
    setView(v);
    if (withShots) setShots(v.shots);
  }, []);

  const refetch = useCallback(async () => {
    try {
      const v = await api.getStory(storyId);
      if (!alive.current) return;
      // Unsaved edits win over the refetched shot list.
      adopt(v, timer.current === null && inflight.current === null);
    } catch (e) {
      if (alive.current) setLoadError(api.errorMessage(e));
    }
  }, [storyId, adopt]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // ---- saving shot edits (debounced) ----
  const save = useCallback(async () => {
    timer.current = null;
    const v = version.current;
    const sent = shotsRef.current;
    setSaveState("saving");
    try {
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
      adopt(res, unchanged);
      setSaveState(timer.current !== null ? "pending" : "idle");
    } catch (e) {
      if (!alive.current) return;
      setSaveState("error");
      toast.error("Couldn't save the shots", e);
    }
  }, [storyId, adopt, toast]);

  const runSave = useCallback(() => {
    const p = (inflight.current ?? Promise.resolve()).then(save);
    const mine = p.finally(() => {
      if (inflight.current === mine) inflight.current = null;
    });
    inflight.current = mine;
    return mine;
  }, [save]);

  /** Save any pending edit now and wait for every save to land. */
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      await runSave();
    } else if (inflight.current) {
      await inflight.current;
    }
  }, [runSave]);

  const edit = useCallback(
    (next: Shot[]) => {
      version.current += 1;
      setShots(next);
      shotsRef.current = next;
      setSaveState("pending");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void runSave(), SAVE_DEBOUNCE_MS);
    },
    [runSave],
  );

  // Leaving the story: send what's pending.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void api.saveShots(storyId, toWire(shotsRef.current)).catch(() => {});
      }
    },
    [storyId],
  );

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
      const started = await api.renderStory(storyId);
      if (!started.length) toast.info("Nothing to render", "Every shot that can render has a take. Use Reroll for a new take.");
      track(started);
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
      const v = await api.planStory(storyId);
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
      const res = await api.approveTake(shotId, takeId);
      adopt(res.view, timer.current === null);
      if (res.queued) track([res.queued]);
      onChangedRef.current?.();
    } catch (e) {
      toast.error("Couldn't approve the take", e);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const openResult = async (id: string | null) => {
    if (!id) return;
    try {
      const page = await api.listImages({ limit: 60 });
      const rec = page.items.find((r) => r.id === id);
      if (rec) onOpenImage(rec);
      else toast.info("Open it from the gallery", "Switch to the Image tab to find the story video.");
    } catch (e) {
      toast.error("Couldn't open the story video", e);
    }
  };

  const assemble = async () => {
    setBusy("assemble");
    try {
      await flush();
      const v = await api.assembleStory(storyId);
      adopt(v, timer.current === null);
      onChangedRef.current?.();
      const id = v.story.resultImageId;
      toast.notify({
        kind: "success",
        title: "Story saved to the gallery",
        actions: id ? [{ label: "Open", onClick: () => void openResult(id) }] : undefined,
      });
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
    try {
      const v = await api.updateStory({ ...story, title });
      if (alive.current) setView((cur) => (cur ? { ...cur, story: v.story } : v));
      onChangedRef.current?.();
    } catch (e) {
      toast.error("Couldn't rename the story", e);
    }
  };

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
  if (loadError && !view) {
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

  const assembleTitle = !shots.length
    ? "Plan the story first"
    : !allApproved
      ? `Approve a take for every shot (${shots.filter((s) => s.approvedTakeId).length} of ${shots.length})`
      : dirty
        ? "Saving your edits…"
        : undefined;

  return (
    <div className="story-ws">
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
          </p>
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

      {story.status === "assembled" && story.resultImageId && (
        <p className="notice notice--inline story-ws__done">
          <Icon name="check" /> Assembled — the story video is in the gallery.
          <button type="button" className="link-btn" onClick={() => void openResult(story.resultImageId)}>
            Open
          </button>
        </p>
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
                  onDelete={() => setConfirm({ kind: "delete", index: i })}
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
        <p>Replaces all shots and their takes' approvals. The local model writes a new shot list from the brief.</p>
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
                const i = confirm.index;
                setConfirm(null);
                edit(shots.filter((_, j) => j !== i));
              }}
            >
              <Icon name="trash" size={14} /> Delete shot
            </button>
          </>
        }
      >
        <p>Removes the shot and its text from the story.</p>
      </Dialog>
    </div>
  );
}
