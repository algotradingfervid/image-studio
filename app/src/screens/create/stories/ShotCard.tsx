import { useEffect, useRef, useState } from "react";
import { fileSrc, type Character, type ImageRecord, type Job, type Shot } from "../../../api";
import { ProgressBar } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";

/** Mirrors the validator (validate.rs): at most 2.5 spoken words per second, 5–15 s, ≤ 2 characters. */
export const WORDS_PER_S = 2.5;
export const MIN_SHOT_S = 5;
export const MAX_SHOT_S = 15;
export const MAX_CAST_PER_SHOT = 2;

/** Same word split as the validator: runs of letters / digits. */
export function countWords(text: string): number {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

/** Mirrors the validator: a line's delivery phrase is at most 15 words. */
export const MAX_DELIVERY_WORDS = 15;

export const maxWords = (durationS: number) => Math.floor(WORDS_PER_S * durationS);

export const dialogueWords = (s: Shot) => s.dialogue.reduce((n, d) => n + countWords(d.line), 0);

const STAGE_LABEL: Record<string, string> = {
  copying_models: "Copying model to fast disk",
  loading_text_encoder: "Loading text encoder",
  encoding_prompt: "Encoding prompt",
  loading_model: "Loading model",
  preparing_init_image: "Preparing start image",
  preparing_references: "Preparing references",
  sampling: "Generating",
  decoding: "Decoding",
  saving: "Saving",
  video_decoding: "Decoding video",
  audio_decoding: "Decoding audio",
  encoding_video: "Encoding MP4",
};

/** Short JobCard-like stage text for a take's job. */
function jobStageText(job: Job | undefined): { text: string; pct: number | null } {
  if (!job) return { text: "Queued", pct: null };
  const p = job.progress;
  if (job.status === "queued") return { text: "Queued", pct: null };
  if (job.status === "starting") return { text: p?.phase ? `Starting GPU · ${p.phase}` : "Starting GPU", pct: null };
  if (job.status === "running") {
    const stage = p?.stage ? (STAGE_LABEL[p.stage] ?? p.stage) : p?.phase ? String(p.phase) : "Running";
    if (p?.step != null && p.totalSteps) {
      return { text: `${stage} · step ${p.step} of ${p.totalSteps}`, pct: (p.step / p.totalSteps) * 100 };
    }
    return { text: stage, pct: null };
  }
  return { text: job.status, pct: null };
}

export interface ShotCardProps {
  shot: Shot;
  index: number;
  count: number;
  cast: Character[];
  aspect: string;
  /** Newest first. */
  takes: ImageRecord[];
  issues: string[];
  /** Position of the previous shot when this one continues it and the previous has no approved take. */
  waitsFor: number | null;
  /** Story-wide issues block every render (the backend refuses). */
  blocked: string | null;
  rendering: boolean;
  job: Job | undefined;
  error: string | null;
  busy: boolean;
  onChange: (next: Shot) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onRender: () => void;
  onApprove: (takeId: string) => void;
}

export function ShotCard(props: ShotCardProps) {
  const { shot, index, count, cast, aspect, takes, issues, waitsFor, blocked, rendering, job, error, busy } = props;
  const n = index + 1;
  const actionRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [durText, setDurText] = useState(String(shot.durationS));

  // Keep the duration field in step with outside changes (save result, re-plan).
  useEffect(() => {
    setDurText((t) => (Number(t) === shot.durationS ? t : String(shot.durationS)));
  }, [shot.durationS]);

  // A new take arrives: show it.
  const latestId = takes[0]?.id ?? null;
  useEffect(() => {
    setViewedId(null);
  }, [latestId]);

  const viewed = takes.find((t) => t.id === viewedId) ?? takes[0] ?? null;
  const older = takes.filter((t) => t.id !== viewed?.id);
  const set = (patch: Partial<Shot>) => props.onChange({ ...shot, ...patch });
  const names = new Map(cast.map((c) => [c.id, c.name]));
  const nameOf = (id: string) => names.get(id) ?? "Unknown character";

  const words = dialogueWords(shot);
  const max = maxWords(shot.durationS);

  const toggleChar = (id: string, on: boolean) => {
    const characters = on ? [...shot.characters, id] : shot.characters.filter((c) => c !== id);
    set({ characters });
  };

  const renderDisabled = rendering || busy || waitsFor !== null || !!blocked;
  const renderTitle = waitsFor !== null ? `Waits for shot ${waitsFor} to be approved` : (blocked ?? undefined);
  const stage = rendering ? jobStageText(job) : null;
  const ratio = aspect === "9:16" ? "9 / 16" : aspect === "1:1" ? "1 / 1" : "16 / 9";

  return (
    <article className="card shot-card" aria-labelledby={`shot-${shot.id || index}-title`}>
      <header className="shot-card__head">
        <h3 className="shot-card__title" id={`shot-${shot.id || index}-title`}>
          Shot {n}
        </h3>
        {shot.approvedTakeId && (
          <span className="badge badge--ok">
            <Icon name="check" size={12} /> Approved
          </span>
        )}
        <span className={`shot-card__words ${words > max ? "is-over" : ""}`} title="Spoken words / words that fit">
          {words}/{max} words
        </span>
        <div className="shot-card__order">
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`Move shot ${n} up`} disabled={index === 0} onClick={() => props.onMove(-1)}>
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label={`Move shot ${n} down`}
            disabled={index === count - 1}
            onClick={() => props.onMove(1)}
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label={`Delete shot ${n}`} onClick={props.onDelete}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </header>

      <div className="shot-card__body">
        <div className="shot-card__media">
          <div className="shot-card__player" style={{ aspectRatio: ratio }}>
            {viewed ? (
              <video
                key={viewed.id}
                controls
                preload="metadata"
                poster={viewed.posterPath ? fileSrc(viewed.posterPath) : undefined}
                src={fileSrc(viewed.path)}
                aria-label={`Shot ${n} take`}
              />
            ) : (
              <div className="shot-card__placeholder">
                <Icon name="video" size={22} />
                <span>{rendering ? "Rendering…" : "No take yet"}</span>
              </div>
            )}
            {viewed && viewed.id === shot.approvedTakeId && <span className="badge badge--ok shot-card__take-badge">Approved</span>}
          </div>

          {stage && (
            <div className="shot-card__status" role="status">
              <span className="stage__spin" aria-hidden="true" /> {stage.text}
              <ProgressBar value={stage.pct ?? 0} indeterminate={stage.pct === null} label={`Shot ${n} render progress`} />
            </div>
          )}
          {error && !rendering && <p className="field-error">Render failed: {error}</p>}
          {waitsFor !== null && !rendering && <p className="shot-card__hint">Waits for shot {waitsFor} to be approved</p>}

          <div className="btn-row shot-card__actions">
            {takes.length === 0 ? (
              <button type="button" className="btn btn--sm btn--primary" disabled={renderDisabled} title={renderTitle} onClick={props.onRender}>
                <Icon name="play" size={14} /> Render
              </button>
            ) : (
              <>
                {viewed && viewed.id !== shot.approvedTakeId && (
                  <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => props.onApprove(viewed.id)}>
                    <Icon name="check" size={14} /> {viewed.id === takes[0]?.id ? "Approve" : "Use this take"}
                  </button>
                )}
                {editing ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={renderDisabled}
                    title={renderTitle}
                    onClick={() => {
                      setEditing(false);
                      props.onRender();
                    }}
                  >
                    <Icon name="refresh" size={14} /> Re-render
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn--sm" disabled={renderDisabled} title={renderTitle} onClick={props.onRender}>
                      <Icon name="dice" size={14} /> Reroll
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={rendering}
                      onClick={() => {
                        setEditing(true);
                        actionRef.current?.focus();
                      }}
                    >
                      Edit &amp; re-render
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          {editing && <p className="shot-card__hint">Edit the shot, then Re-render: the new take uses the edited text.</p>}

          {older.length > 0 && (
            <div className="shot-card__takes">
              <p className="shot-card__takes-label">{viewed?.id === takes[0]?.id ? "Earlier takes" : "Other takes"}</p>
              <ul className="plain shot-card__thumbs">
                {older.map((t) => {
                  const k = takes.length - takes.indexOf(t);
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="shot-card__thumb"
                        style={{ aspectRatio: ratio }}
                        aria-label={`View take ${k}${t.id === shot.approvedTakeId ? " (approved)" : ""}`}
                        onClick={() => setViewedId(t.id)}
                      >
                        {t.posterPath ? <img src={fileSrc(t.posterPath)} alt="" /> : <Icon name="video" size={14} />}
                        {t.id === shot.approvedTakeId && <span className="shot-card__thumb-ok" aria-hidden="true"><Icon name="check" size={10} /></span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="shot-card__fields">
          <div className="shot-card__row">
            <label className="field shot-card__dur">
              <span className="field__label">Duration (s)</span>
              <input
                className="input"
                type="number"
                min={MIN_SHOT_S}
                max={MAX_SHOT_S}
                step={1}
                value={durText}
                onChange={(e) => {
                  setDurText(e.target.value);
                  const v = Number(e.target.value);
                  if (e.target.value !== "" && Number.isInteger(v) && v > 0) set({ durationS: v });
                }}
                onBlur={() => setDurText(String(shot.durationS))}
              />
            </label>
            <fieldset className="field shot-card__cont">
              <legend className="field__label">Continuity</legend>
              <div className="segmented" role="radiogroup" aria-label={`Shot ${n} continuity`}>
                <button type="button" role="radio" aria-checked={shot.continuity === "cut"} className={shot.continuity === "cut" ? "is-selected" : ""} onClick={() => set({ continuity: "cut" })}>
                  Cut
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={shot.continuity === "continues"}
                  className={shot.continuity === "continues" ? "is-selected" : ""}
                  disabled={index === 0}
                  title={index === 0 ? "The first shot always starts with a cut" : undefined}
                  onClick={() => set({ continuity: "continues" })}
                >
                  Continues previous
                </button>
              </div>
            </fieldset>
          </div>

          <fieldset className="field">
            <legend className="field__label">Characters (up to {MAX_CAST_PER_SHOT})</legend>
            {cast.length === 0 ? (
              <p className="shot-card__hint">This story has no cast.</p>
            ) : (
              <div className="shot-card__cast">
                {cast.map((c) => {
                  const on = shot.characters.includes(c.id);
                  return (
                    <label key={c.id} className="shot-card__check">
                      <input type="checkbox" checked={on} disabled={!on && shot.characters.length >= MAX_CAST_PER_SHOT} onChange={(e) => toggleChar(c.id, e.target.checked)} />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <label className="field">
            <span className="field__label">Setting</span>
            <input className="input" value={shot.setting} onChange={(e) => set({ setting: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Camera</span>
            <input className="input" value={shot.camera} onChange={(e) => set({ camera: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Action</span>
            <textarea ref={actionRef} className="input textarea textarea--sm" rows={3} value={shot.action} onChange={(e) => set({ action: e.target.value })} />
          </label>

          <fieldset className="field">
            <legend className="field__label">Dialogue</legend>
            {shot.dialogue.length > 0 && (
              <ul className="plain shot-card__lines">
                {shot.dialogue.map((d, i) => {
                  const speakers = shot.characters.includes(d.speaker) || !d.speaker ? shot.characters : [...shot.characters, d.speaker];
                  const setLine = (patch: Partial<typeof d>) => set({ dialogue: shot.dialogue.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                  const deliveryWords = countWords(d.delivery ?? "");
                  return (
                    <li key={i} className="shot-card__line">
                      <select className="select input" aria-label={`Line ${i + 1} speaker`} value={d.speaker} onChange={(e) => setLine({ speaker: e.target.value })}>
                        {!d.speaker && <option value="">Speaker…</option>}
                        {speakers.map((id) => (
                          <option key={id} value={id}>
                            {nameOf(id)}
                            {shot.characters.includes(id) ? "" : " (not in shot)"}
                          </option>
                        ))}
                      </select>
                      <input
                        className={`input shot-card__delivery ${deliveryWords > MAX_DELIVERY_WORDS ? "is-over" : ""}`}
                        aria-label={`Line ${i + 1} delivery`}
                        title={`Delivery: what the speaker does while saying the line, and how (at most ${MAX_DELIVERY_WORDS} words)`}
                        placeholder="Delivery, e.g. turns to Ivo and says quietly"
                        value={d.delivery ?? ""}
                        onChange={(e) => setLine({ delivery: e.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => set({ dialogue: shot.dialogue.filter((_, j) => j !== i) })}
                      >
                        <Icon name="x" size={14} />
                      </button>
                      <input
                        className="input shot-card__line-text"
                        aria-label={`Line ${i + 1}`}
                        placeholder="What is said, word for word (no quotation marks)"
                        value={d.line}
                        onChange={(e) => setLine({ line: e.target.value })}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="link-btn shot-card__add-line"
              disabled={shot.characters.length === 0}
              title={shot.characters.length === 0 ? "Pick a character for this shot first" : undefined}
              onClick={() => set({ dialogue: [...shot.dialogue, { speaker: shot.characters[0] ?? "", delivery: "", line: "" }] })}
            >
              <Icon name="plus" size={13} /> Add line
            </button>
          </fieldset>

          <label className="field">
            <span className="field__label">Sound</span>
            <textarea
              className="input textarea textarea--sm"
              rows={2}
              placeholder="Rain on the concrete, distant traffic… (real sounds only; no dialogue or music)"
              value={shot.sound ?? ""}
              onChange={(e) => set({ sound: e.target.value })}
            />
          </label>

          {issues.length > 0 && (
            <ul className="plain shot-card__issues" aria-label={`Shot ${n} problems`}>
              {issues.map((m, i) => (
                <li key={i} className="field-error">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}
