import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import * as api from "../../../api";
import type { Character, Destination, LlmStatus, PlanProgress, Story } from "../../../api";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { radioKeys } from "../../../components/radio";
import { useToast } from "../../../state/toast";
import { LOCK_DISCARD_TOAST, useVault } from "../../../state/vault";
import { useMoreBelow } from "../Controls";
import { CharacterForm } from "./CharacterForm";
import "./stories.css";

const MAX_CAST = 2;
const STYLE_MAX = 300;
const SAVE_DELAY_MS = 600;
/** 30 s … 3 min in 15 s steps (spec §3 step 2). */
const LENGTHS = Array.from({ length: 11 }, (_, i) => 30 + i * 15);
const ASPECTS: Story["aspect"][] = ["16:9", "9:16", "1:1"];
const DEFAULTS = { brief: "", targetS: 60, aspect: "16:9" as Story["aspect"], style: "", cast: [] as string[] };
/** Shown when the planner can't be reached (same words as the core's hint, spec §4). */
const LM_HINT = "Start LM Studio's server (Developer → Start server, or `lms server start`) and load a model.";
const SAVE_TO: Destination[] = ["general", "vault"];
/** Toast key of "{vault character} saved": dismissed when the vault locks. */
const VAULT_NAME_TOAST = "story-vault-character-saved";

type Fields = typeof DEFAULTS;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const lengthLabel = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m === 0 ? `${r} s` : r === 0 ? `${m} min` : `${m} min ${r} s`;
};

function storyLabel(s: Story): string {
  const name = s.title.trim() || clip(s.brief.trim(), 40) || "Untitled story";
  const d = new Date(s.updatedAt || s.createdAt);
  return isNaN(d.getTime()) ? name : `${name} · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** Picker entry (an <option> holds text only, so the vault mark is a word). */
const optionLabel = (s: Story) => (s.vault ? `Vault · ${storyLabel(s)}` : storyLabel(s));

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** "Attempt 1 of 3 · writing 1,840 of ~4,600 tokens · 1:42" */
function progressLine(p: PlanProgress | null, elapsedS: number): string {
  const attempt = p && p.maxAttempts > 1 && p.attempt > 1 ? `Attempt ${p.attempt} of ${p.maxAttempts} · ` : "";
  const what =
    !p || p.phase === "waiting"
      ? "reading the brief"
      : `writing ${p.tokens.toLocaleString()} of ~${p.expectedTokens.toLocaleString()} tokens`;
  return `${attempt}${what} · ${clock(elapsedS)}`;
}

const fieldsOf = (s: Story): Fields => ({ brief: s.brief, targetS: s.targetS, aspect: s.aspect, style: s.style, cast: s.cast });

/**
 * The Stories tab's left panel (spec §3): story picker, Cast (1–2 characters), Brief and Plan story.
 * Edits to a saved story auto-save; a new story is created on its first Plan.
 */
export function StoriesPanel({
  hidden,
  active,
  modeSwitch,
  selectedStoryId,
  onSelectStory,
  onPlanned,
  refreshKey,
  beforePlan,
  onPlanningChange,
  onSaved,
  rendering = false,
}: {
  hidden: boolean;
  active: boolean;
  modeSwitch: ReactNode;
  selectedStoryId: string | null;
  onSelectStory: (id: string | null) => void;
  onPlanned?: () => void;
  /** Changes when the story was edited elsewhere (the workspace): reload the list. */
  refreshKey?: number;
  /** Runs before a saved story is planned: the workspace sends its pending edits. */
  beforePlan?: (storyId: string) => Promise<void>;
  /** Planning started / ended (the workspace is read-only meanwhile). */
  onPlanningChange?: (planning: boolean) => void;
  /** The panel saved the story's fields (the workspace reloads it). */
  onSaved?: () => void;
  /** A shot of the selected story is rendering: Delete story and Plan again wait. */
  rendering?: boolean;
}) {
  const id = useId();
  const toast = useToast();
  const vault = useVault();
  const scrollRef = useRef<HTMLDivElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  useMoreBelow(scrollRef);

  // ---------- stories and characters ----------
  const [stories, setStories] = useState<Story[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loaded, setLoaded] = useState(false);
  const loadedOnce = useRef(false);
  /** The lists on screen were read with the vault unlocked (so they hold its stories). */
  const [listUnlocked, setListUnlocked] = useState(false);

  const load = useCallback(async () => {
    const unlockedNow = vault.isUnlocked();
    try {
      const [ss, cs] = await Promise.all([api.listStories(), api.listCharacters()]);
      setStories(ss);
      setCharacters(cs);
      setListUnlocked(unlockedNow);
    } catch (e) {
      toast.error("Couldn't load your stories", e);
    } finally {
      setLoaded(true);
    }
  }, [toast, vault.isUnlocked]);

  useEffect(() => {
    if (!active || loadedOnce.current) return;
    loadedOnce.current = true;
    void load();
  }, [active, load]);

  const firstRefresh = useRef(refreshKey);
  useEffect(() => {
    if (firstRefresh.current === refreshKey || !loadedOnce.current) return;
    firstRefresh.current = refreshKey;
    void api
      .listStories()
      .then(setStories)
      .catch(() => {
        /* the list stays as it was */
      });
  }, [refreshKey]);

  const upsert = (s: Story) => setStories((ss) => (ss.some((x) => x.id === s.id) ? ss.map((x) => (x.id === s.id ? s : x)) : [s, ...ss]));

  const story = selectedStoryId ? (stories.find((s) => s.id === selectedStoryId) ?? null) : null;

  // ---------- the form (brief, length, aspect, style, cast) ----------
  const [fields, setFields] = useState<Fields>(DEFAULTS);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const storyRef = useRef(story);
  storyRef.current = story;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  /** The user changed a saved story's fields since the last save. */
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  /** Vault story ids seen while unlocked: such a selection is kept through a lock (the workspace shows the lock screen). */
  const lockedIds = useRef(new Set<string>());
  useEffect(() => {
    if (vault.unlocked) for (const s of stories) if (s.vault) lockedIds.current.add(s.id);
  }, [stories, vault.unlocked]);
  /** The selected story is a vault story out of reach: locked, or its list is still reloading after the unlock. */
  const lockedSel = !!selectedStoryId && !story && lockedIds.current.has(selectedStoryId) && !(vault.unlocked && listUnlocked);

  // Load the selected story's fields when the selection changes (or the list first arrives).
  const shownFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!loaded) return;
    if (selectedStoryId && !story) {
      if (lockedSel) return;
      // Deleted elsewhere, or a stale remembered id.
      onSelectStory(null);
      return;
    }
    if (shownFor.current === selectedStoryId) return;
    shownFor.current = selectedStoryId;
    dirty.current = false;
    if (story) setFields(fieldsOf(story));
  }, [loaded, selectedStoryId, story, onSelectStory, lockedSel]);

  const saveNow = useCallback(async () => {
    window.clearTimeout(timer.current);
    const s = storyRef.current;
    if (!dirty.current || !s) return;
    dirty.current = false;
    try {
      // Only the fields this panel edits: the workspace's voices and title are never sent from here.
      const { brief, targetS, aspect, style, cast } = fieldsRef.current;
      const v = await api.updateStory(s.id, { brief, targetS, aspect, style, cast });
      upsert(v.story);
      onSavedRef.current?.();
    } catch (e) {
      // The vault locked while the save ran: the edit is lost, say so as the workspace does (spec §8).
      if (api.errorCode(e) === "VAULT_LOCKED" && s.vault) return toast.notify(LOCK_DISCARD_TOAST);
      toast.error("Couldn't save the story", e);
      // A story with takes keeps its aspect: show the saved one again and save the other fields.
      if (/aspect/i.test(api.errorMessage(e)) && fieldsRef.current.aspect !== s.aspect) {
        dirty.current = true;
        setFields((f) => ({ ...f, aspect: s.aspect }));
      }
    }
  }, [toast]);

  const edit = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
    if (storyRef.current) dirty.current = true;
  };

  // Debounced auto-save of a saved story.
  useEffect(() => {
    if (!dirty.current || !story) return;
    timer.current = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer.current);
  }, [fields, story, saveNow]);

  // ---------- where a new story is saved, and the vault locking / unlocking ----------
  const [saveTo, setSaveTo] = useState<Destination>("general");
  const saveToRef = useRef(saveTo);
  saveToRef.current = saveTo;
  /** The store of the story being edited (a new one: the Save-to choice). */
  const inVault = story ? story.vault : vault.exists && saveTo === "vault";

  /** Back to General: a General story can't use vault characters, so they leave the cast now (not at Plan). */
  const chooseSaveTo = (d: Destination) => {
    setSaveTo(d);
    if (d !== "general") return;
    const keep = fieldsRef.current.cast.filter((cid) => !characters.find((c) => c.id === cid)?.vault);
    if (keep.length === fieldsRef.current.cast.length) return;
    setFields((f) => ({ ...f, cast: keep }));
    toast.info("Vault characters left the cast", "Only a vault story can use a vault character.");
  };

  const seenUnlocked = useRef(vault.unlocked);
  useEffect(() => {
    if (seenUnlocked.current === vault.unlocked) return;
    seenUnlocked.current = vault.unlocked;
    if (!vault.unlocked) {
      // Nothing of the vault stays on screen: its stories and characters go now, the reload confirms.
      const gone = new Set(characters.filter((c) => c.vault).map((c) => c.id));
      setStories((ss) => ss.filter((s) => !s.vault));
      setCharacters((cs) => cs.filter((c) => !c.vault));
      setListUnlocked(false);
      toast.dismissKey(VAULT_NAME_TOAST);
      const s = storyRef.current;
      if (s?.vault || (!s && saveToRef.current === "vault")) {
        // The panel form resets; a saved vault story's pending edits are dropped (they can't be saved locked).
        window.clearTimeout(timer.current);
        if (s && dirty.current) toast.notify(LOCK_DISCARD_TOAST);
        dirty.current = false;
        shownFor.current = undefined;
        setFields(DEFAULTS);
      } else if (gone.size) setFields((f) => ({ ...f, cast: f.cast.filter((c) => !gone.has(c)) }));
      setSaveTo("general");
    }
    if (loadedOnce.current) void load();
  }, [vault.unlocked, characters, load, toast]);

  const selectStory = async (next: string | null) => {
    await saveNow();
    if (next === null) {
      setFields(DEFAULTS);
      shownFor.current = null;
    }
    onSelectStory(next);
  };

  const newStory = async () => {
    await selectStory(null);
    setFields(DEFAULTS);
    requestAnimationFrame(() => briefRef.current?.focus());
  };

  // ---------- delete ----------
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    if (!story) return;
    setDeleting(true);
    try {
      window.clearTimeout(timer.current);
      dirty.current = false;
      await api.deleteStory(story.id);
      setStories((ss) => ss.filter((x) => x.id !== story.id));
      setConfirmDelete(false);
      shownFor.current = null;
      setFields(DEFAULTS);
      onSelectStory(null);
      toast.success("Story deleted");
    } catch (e) {
      toast.error("Couldn't delete the story", e);
    } finally {
      setDeleting(false);
    }
  };

  // ---------- cast ----------
  const castChars = fields.cast.map((cid) => characters.find((c) => c.id === cid)).filter((c): c is Character => !!c);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  /** The character the form edits; null for a new one. */
  const [editing, setEditing] = useState<Character | null>(null);
  const editCharacter = (c: Character) => {
    setEditing(c);
    setFormOpen(true);
  };
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `${id}-cast-menu`;
  const available = characters.filter((c) => !fields.cast.includes(c.id));
  const castFull = fields.cast.length >= MAX_CAST;

  useLayoutEffect(() => {
    if (!menuOpen) return setMenuUp(false);
    const menu = menuRef.current;
    const btn = addBtnRef.current;
    const scroller = scrollRef.current;
    if (!menu || !btn || !scroller) return;
    const area = scroller.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const h = menu.offsetHeight + 6;
    setMenuUp(b.bottom + h > area.bottom && b.top - h >= area.top);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !addBtnRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    addBtnRef.current?.focus({ preventScroll: true });
  };

  const addToCast = (cid: string) => edit({ cast: fieldsRef.current.cast.includes(cid) ? fieldsRef.current.cast : [...fieldsRef.current.cast, cid].slice(0, MAX_CAST) });
  const removeFromCast = (cid: string) => {
    edit({ cast: fieldsRef.current.cast.filter((x) => x !== cid) });
    requestAnimationFrame(() => addBtnRef.current?.focus({ preventScroll: true }));
  };

  // ---------- planner status ----------
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmChecking, setLlmChecking] = useState(false);
  const checkLlm = useCallback(async () => {
    setLlmChecking(true);
    try {
      setLlm(await api.llmStatus());
      setLlmError(null);
    } catch (e) {
      setLlm(null);
      setLlmError(api.errorMessage(e));
    } finally {
      setLlmChecking(false);
    }
  }, []);
  useEffect(() => {
    if (active) void checkLlm();
  }, [active, checkLlm]);

  // ---------- plan ----------
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [planStarted, setPlanStarted] = useState(0);
  const [now, setNow] = useState(0);
  /** The last plan's failure, kept on screen until the next plan or dismissed (a toast is easy to miss). */
  const [planError, setPlanError] = useState<string | null>(null);
  useEffect(() => {
    if (!planning) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    void api.onEvent("story-plan-progress", (e) => setProgress(e.progress)).then((u) => (gone ? u() : (unlisten = u)));
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      gone = true;
      unlisten?.();
      window.clearInterval(tick);
    };
  }, [planning]);
  const [confirmReplan, setConfirmReplan] = useState(false);
  const blockers = [
    lockedSel ? "Unlock the vault to continue" : "",
    fields.cast.length === 0 ? "Add a character to the cast" : "",
    !fields.brief.trim() ? "Write a brief" : "",
  ].filter(Boolean);
  const blocked = blockers.length > 0;

  const runPlan = async () => {
    setConfirmReplan(false);
    setPlanError(null);
    setProgress(null);
    setPlanStarted(Date.now());
    setNow(Date.now());
    setPlanning(true);
    // The workspace goes read-only first, so no edit starts after its flush below.
    onPlanningChange?.(true);
    try {
      let sid = storyRef.current?.id;
      if (!sid) {
        const f = fieldsRef.current;
        const destination: Destination = vault.exists && saveToRef.current === "vault" ? "vault" : "general";
        const v = await api.createStory({ brief: f.brief.trim(), targetS: f.targetS, aspect: f.aspect, style: f.style.trim(), cast: f.cast, destination });
        sid = v.story.id;
        upsert(v.story);
        shownFor.current = sid;
        onSelectStory(sid);
      } else {
        await saveNow();
        // The workspace's pending shot / voice edits land before the plan replaces them.
        await beforePlan?.(sid);
      }
      const planned = await api.planStory(sid);
      upsert(planned.story);
      onPlanned?.();
    } catch (e) {
      // VAULT_LOCKED (locked before or while planning): the sentence without its code, and Unlock.
      const locked = api.errorCode(e) === "VAULT_LOCKED";
      const msg = api.errorMessage(e).replace(/^VAULT_LOCKED: /, "");
      if (!locked) setPlanError(msg);
      toast.notify({
        kind: "error",
        title: "Couldn't plan the story",
        actions: locked ? [{ label: "Unlock", onClick: () => vault.requestUnlock() }] : undefined,
        // The LM Studio hint only for connection failures, not for validation errors.
        message: !/LM Studio/i.test(msg) && /connect|reach|refused|timed? ?out|network/i.test(msg) ? `${msg} — the planner runs on your Mac: ${LM_HINT}` : msg,
        durationMs: 12000,
      });
      void checkLlm();
    } finally {
      setPlanning(false);
      setProgress(null);
      onPlanningChange?.(false);
    }
  };

  /** A plan replaces every shot: not while one renders (the core refuses it too). */
  const replanWaits = !!story && rendering;

  const plan = () => {
    if (planning || blocked || replanWaits) return;
    // A planned story's shot list is replaced by a new plan: confirm first.
    if (story && story.status !== "draft") return setConfirmReplan(true);
    void runPlan();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      plan();
    }
  };

  const llmLine = llmChecking && !llm && !llmError ? (
    <>Checking the planner…</>
  ) : llm?.reachable ? (
    <>
      Planner: <span title={llm.model}>{clip(llm.model, 22)}</span> via LM Studio
    </>
  ) : (
    <>
      {llmError ? `Couldn't check the planner: ${llmError}` : (llm?.error ?? `The planner isn't reachable. ${LM_HINT}`)}{" "}
      <button type="button" className="link-btn" onClick={() => void checkLlm()} disabled={llmChecking}>
        {llmChecking ? "Checking…" : "Retry"}
      </button>
    </>
  );
  const plannerDown = !!llmError || (!!llm && !llm.reachable);

  const styleLeft = STYLE_MAX - fields.style.length;

  return (
    <>
      <form
        className="panel stories-panel"
        aria-label="Story settings"
        hidden={hidden}
        onKeyDown={onKeyDown}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          plan();
        }}
      >
        <div className="panel__scroll" ref={scrollRef}>
          {modeSwitch}

          <section className="section">
            <div className="section__head">
              <label className="section__title" htmlFor={`${id}-story`}>
                Story
                {story?.vault && (
                  <span className="tag story-vault-tag">
                    <Icon name="lock" size={11} /> Vault
                  </span>
                )}
              </label>
              {story && (
                <button
                  type="button"
                  className="link-btn link-btn--danger story-delete"
                  disabled={rendering || planning}
                  title={rendering ? "Wait for the shots to finish rendering" : undefined}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete story
                </button>
              )}
            </div>
            <div className="story-picker">
              <select
                id={`${id}-story`}
                className="input select"
                value={selectedStoryId ?? ""}
                disabled={!loaded || planning}
                onChange={(e) => void selectStory(e.target.value || null)}
              >
                <option value="">{loaded ? "New story (not saved yet)" : "Loading…"}</option>
                {lockedSel && <option value={selectedStoryId ?? ""}>Vault story (locked)</option>}
                {stories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {optionLabel(s)}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--sm" onClick={() => void newStory()} disabled={planning}>
                <Icon name="plus" size={14} /> New story
              </button>
            </div>
            {story && story.status !== "draft" && (
              <p className="hint section__note">
                {story.status === "assembled" ? "Assembled — the final film is on the right." : "Planned — review the shots on the right."} Changes here save automatically.
              </p>
            )}
          </section>

          <section className="section" aria-labelledby={`${id}-cast-title`}>
            <div className="section__head">
              <h2 className="section__title" id={`${id}-cast-title`}>
                Cast <span className="section__aside">(1–{MAX_CAST}) — reused across stories</span>
              </h2>
              <span className="hint mono">
                {fields.cast.length}/{MAX_CAST}
              </span>
            </div>
            {castChars.length > 0 && (
              <ul className="story-cast" aria-label="Characters in this story">
                {castChars.map((c) => (
                  <li key={c.id} className="chip story-cast__chip" title={c.description}>
                    <span className="story-cast__name">{c.name}</span>
                    {c.source === "real_person" && <span className="tag">Real person</span>}
                    <button type="button" className="chip__x" aria-label={`Edit ${c.name}`} title="Edit character" onClick={() => editCharacter(c)}>
                      <Icon name="edit" size={12} />
                    </button>
                    <button type="button" className="chip__x" aria-label={`Remove ${c.name} from the cast`} onClick={() => removeFromCast(c.id)}>
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="story-cast__add">
              <button
                ref={addBtnRef}
                type="button"
                className="btn btn--ghost btn--sm"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                disabled={castFull || !loaded}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <Icon name="plus" /> Add character
              </button>
              {castFull && <span className="hint">A story has at most {MAX_CAST} characters.</span>}
              {menuOpen && (
                <div
                  ref={menuRef}
                  id={menuId}
                  className={`menu lora-menu story-cast__menu ${menuUp ? "is-up" : ""}`}
                  role="menu"
                  aria-label="Characters"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      closeMenu();
                    }
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
                      const i = items.indexOf(document.activeElement as HTMLElement);
                      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                    }
                  }}
                >
                  {available.map((c) => (
                    <div key={c.id} className="story-cast__menu-row" role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="menu__item lora-menu__item"
                        disabled={c.vault && !inVault}
                        title={c.vault && !inVault ? "Only a vault story can use a vault character" : undefined}
                        onClick={() => {
                          addToCast(c.id);
                          closeMenu();
                        }}
                      >
                        <span className="lora-menu__name">
                          {c.name}
                          {c.vault && (
                            <span className="tag story-vault-tag">
                              <Icon name="lock" size={11} /> Vault
                            </span>
                          )}
                        </span>
                        <span className="hint lora-menu__sub">{clip(c.description, 60)}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="icon-btn"
                        aria-label={`Edit ${c.name}`}
                        title="Edit character"
                        onClick={() => {
                          setMenuOpen(false);
                          editCharacter(c);
                        }}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                    </div>
                  ))}
                  {available.length === 0 && (
                    <div className="menu__empty">
                      <p>{characters.length === 0 ? "No characters yet. Create one with a name, a description and 1–3 reference images." : "Every saved character is already in this story."}</p>
                    </div>
                  )}
                  <div className="lora-menu__foot" role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="menu__item"
                      onClick={() => {
                        setMenuOpen(false);
                        setFormOpen(true);
                      }}
                    >
                      <span>
                        <Icon name="plus" size={13} /> New character…
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {!story && !lockedSel && vault.exists && (
            <div className="save-to story-save-to">
              <div className="save-to__row">
                <span className="section__title" id={`${id}-save-to`}>
                  Save to
                </span>
                <div
                  className="segmented save-to__seg"
                  role="radiogroup"
                  aria-labelledby={`${id}-save-to`}
                  aria-describedby={saveTo === "vault" ? `${id}-save-to-note` : undefined}
                  onKeyDown={radioKeys(vault.unlocked ? SAVE_TO : ["general"], saveTo, chooseSaveTo)}
                >
                  {SAVE_TO.map((d) => {
                    const on = d === saveTo;
                    const disabled = d === "vault" && !vault.unlocked;
                    return (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        disabled={disabled}
                        title={disabled ? "Unlock the vault to create a vault story" : undefined}
                        className={on ? "is-selected" : ""}
                        onClick={() => chooseSaveTo(d)}
                      >
                        {d === "vault" && <Icon name="lock" size={13} />}
                        {d === "general" ? "General" : "Vault"}
                      </button>
                    );
                  })}
                </div>
              </div>
              {saveTo === "vault" && (
                <p id={`${id}-save-to-note`} className="hint save-to__note">
                  Encrypted in the vault. The GPU pod and LM Studio still see what they need to render and plan.
                </p>
              )}
            </div>
          )}

          <section className="section">
            <div className="section__head">
              <label className="section__title" htmlFor={`${id}-brief`}>
                Brief
              </label>
              <span className="hint">
                <kbd>⌘</kbd>
                <kbd>↵</kbd> to plan
              </span>
            </div>
            <textarea
              id={`${id}-brief`}
              ref={briefRef}
              className="input textarea prompt"
              rows={5}
              placeholder="What happens — who, where, the turn, how it ends…"
              value={fields.brief}
              onChange={(e) => edit({ brief: e.target.value })}
              spellCheck
            />

            <div className="field-row story-brief__row">
              <div className="field">
                <label className="field__label" htmlFor={`${id}-length`}>
                  Target length
                </label>
                <select id={`${id}-length`} className="input select" value={fields.targetS} onChange={(e) => edit({ targetS: Number(e.target.value) })}>
                  {LENGTHS.map((s) => (
                    <option key={s} value={s}>
                      {lengthLabel(s)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="field__label" id={`${id}-aspect`}>
                  Aspect
                </span>
                <div
                  className="segmented story-aspect"
                  role="radiogroup"
                  aria-labelledby={`${id}-aspect`}
                  onKeyDown={radioKeys(ASPECTS, fields.aspect, (a) => edit({ aspect: a }))}
                >
                  {ASPECTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={a === fields.aspect}
                      tabIndex={a === fields.aspect ? 0 : -1}
                      className={a === fields.aspect ? "is-selected" : ""}
                      onClick={() => edit({ aspect: a })}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="field story-style">
              <div className="field__label-row">
                <label className="field__label" htmlFor={`${id}-style`}>
                  Style <span className="section__aside">(optional)</span>
                </label>
                <span className={`hint mono ${styleLeft < 30 ? "field-warn" : ""}`}>
                  {fields.style.length}/{STYLE_MAX}
                </span>
              </div>
              <input
                id={`${id}-style`}
                className="input"
                value={fields.style}
                maxLength={STYLE_MAX}
                placeholder="35 mm film, warm grain, handheld"
                autoComplete="off"
                onChange={(e) => edit({ style: e.target.value })}
              />
            </div>
          </section>
        </div>

        <div className="panel__foot">
          <button type="submit" className="btn btn--generate" disabled={blocked || planning || replanWaits} aria-describedby={`${id}-plan-hint`}>
            <Icon name={planning ? "refresh" : "story"} size={18} className={planning ? "spin" : undefined} />
            <span>{planning ? "Planning… (local LLM)" : story && story.status !== "draft" ? "Plan again" : "Plan story"}</span>
            <span className="kbd-group" aria-hidden>
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </span>
          </button>
          {planning && (
            <div className="story-plan-progress" role="status">
              <span>{progressLine(progress, Math.max(0, Math.round((now - planStarted) / 1000)))}</span>
              <progress
                max={progress?.expectedTokens || 1}
                value={progress?.phase === "writing" ? Math.min(progress.tokens, progress.expectedTokens) : undefined}
                aria-label="Plan progress"
              />
            </div>
          )}
          {!planning && planError && (
            <div className="notice notice--inline story-plan-error" role="alert">
              <span>
                <strong>Last plan failed:</strong> {planError}
              </span>
              <button type="button" className="link-btn" onClick={() => setPlanError(null)}>
                Dismiss
              </button>
            </div>
          )}
          <p id={`${id}-plan-hint`} className={`hint panel__hint ${blocked || plannerDown ? "panel__hint--block" : ""}`} aria-live="polite">
            {blocked ? `${blockers.join(" · ")}.` : null}
            {blocked ? " " : null}
            {!blocked && replanWaits ? "Wait for the shots to finish rendering. " : null}
            <span className="story-llm">{llmLine}</span>
          </p>
        </div>
      </form>

      <CharacterForm
        open={formOpen}
        character={editing}
        defaultVault={inVault}
        onClose={() => {
          setEditing(null);
          setFormOpen(false);
          requestAnimationFrame(() => addBtnRef.current?.focus({ preventScroll: true }));
        }}
        onSaved={(c) => {
          setCharacters((cs) => (cs.some((x) => x.id === c.id) ? cs.map((x) => (x.id === c.id ? c : x)) : [...cs, c]));
          const edited = !!editing;
          setEditing(null);
          setFormOpen(false);
          // The workspace reloads the cast: the next render compiles with the new references.
          onSavedRef.current?.();
          // A vault character's name is keyed so a lock can take the toast down with it.
          const say = (title: string, message?: string) => toast.notify({ kind: "success", title, message, key: c.vault ? VAULT_NAME_TOAST : undefined });
          if (edited) say(`${c.name} saved`);
          else if (fieldsRef.current.cast.length < MAX_CAST) {
            addToCast(c.id);
            say(`${c.name} saved and added to the cast`);
          } else say(`${c.name} saved`, "The cast is full — remove someone to add them.");
        }}
      />

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this story?"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" disabled={deleting} onClick={() => void doDelete()}>
              <Icon name={deleting ? "refresh" : "trash"} className={deleting ? "spin" : undefined} /> Delete story
            </button>
          </>
        }
      >
        <p>
          <strong>{story ? storyLabel(story) : ""}</strong>
        </p>
        <p className="hint">Its shot list and every rendered take are deleted. Characters stay in your library. This can't be undone.</p>
      </Dialog>

      <Dialog
        open={confirmReplan}
        onClose={() => setConfirmReplan(false)}
        title="Plan this story again?"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmReplan(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void runPlan()}>
              <Icon name="story" /> Plan again
            </button>
          </>
        }
      >
        <p className="hint">A new plan replaces the current shot list, including any edits you made to it.</p>
      </Dialog>
    </>
  );
}
