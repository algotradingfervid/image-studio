import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode, type RefObject } from "react";
import * as api from "../../api";
import { DENOISE_MAX, DENOISE_MIN, DENOISE_STEP, fileSrc, isTaskActive, type Lora, type ModelView, type ResolvedLora } from "../../api";
import { Dialog } from "../../components/Dialog";
import { AspectShape, Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { ASPECTS } from "../../lib/aspect";
import { formatBytes, pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useVault } from "../../state/vault";
import "../../styles/create.css";

export const MAX_LORAS = 3;

// ---------------- Shared helpers ----------------

const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;
export const NOT_AN_IMAGE = "That file isn't an image. Use a PNG, JPG or WebP.";

/** Natural size of an image URL, or null when it can't be decoded. */
export function measureImage(src: string): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Keeps only files that really are images (type/extension, then a decode check). */
export async function realImageFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const f of files) {
    if (!(f.type.startsWith("image/") || (!f.type && IMAGE_NAME.test(f.name)))) continue;
    const url = URL.createObjectURL(f);
    try {
      if (await measureImage(url)) out.push(f);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return out;
}

export type Orientation = "landscape" | "portrait" | "square";
export const orientationOf = (w: number, h: number): Orientation => (w / h > 1.05 ? "landscape" : w / h < 0.95 ? "portrait" : "square");

const COMMON_RATIOS: [number, number][] = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [5, 4],
  [4, 5],
  [21, 9],
];
/** "3:4" for a 896×1152 image (the app's own sizes first, then the closest common ratio within 4 %), else "W:H" reduced. */
export function ratioLabel(w: number, h: number): string {
  const r = w / h;
  const own = ASPECTS.find((a) => Math.abs(a.w / a.h - r) / r < 0.01);
  if (own) return own.key;
  const err = ([a, b]: [number, number]) => Math.abs(a / b - r) / r;
  const near = [...COMMON_RATIOS].sort((x, y) => err(x) - err(y))[0];
  if (near && err(near) < 0.04) return `${near[0]}:${near[1]}`;
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
  const d = g(w, h) || 1;
  return `${w / d}:${h / d}`;
}

/** Escapes a string for use inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}(?=$|[^\\p{L}\\p{N}])`, "iu");
/** The trigger word appears in the prompt (case-insensitive, whole word). */
export const promptHasWord = (prompt: string, w: string) => !!w && wordRe(w).test(prompt);
/** Removes one trigger word and its comma separator from the prompt. */
export function removeWordFromPrompt(prompt: string, w: string): string {
  const re = new RegExp(`(,\\s*)?(^|(?<=[^\\p{L}\\p{N}]))${esc(w)}(?=$|[^\\p{L}\\p{N}])(\\s*,)?`, "iu");
  return prompt
    .replace(re, (_m, pre: string | undefined, _b, post: string | undefined) => (pre && post ? ", " : ""))
    .replace(/^\s*,\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------- Panel scroll hint + draft persistence ----------------

/** Sets `data-more-below="true"` on the scroll container while content continues below its fold (UX-018 hook). */
export function useMoreBelow(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const more = el.scrollTop + el.clientHeight < el.scrollHeight - 4;
      if (el.dataset.moreBelow !== String(more)) el.dataset.moreBelow = String(more);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
}

/** The non-vault form draft in localStorage (UX-058). Vault-derived drafts are never written. */
export function readDraft<T>(key: string): Partial<T> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : null;
  } catch {
    return null;
  }
}
export function writeDraft(key: string, draft: object | null) {
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---------------- In-panel notice (restores, removals, vault lock) ----------------

export interface PanelNotice {
  tone: "info" | "ok" | "warn";
  title: string;
  detail?: string;
  /** Shows an Undo button; the notice closes when it's used. */
  undo?: () => void;
  /** Stays until dismissed (otherwise hides after 8 s). */
  sticky?: boolean;
  /** Mentions vault content: cleared the moment the vault locks. */
  vault?: boolean;
}

export function usePanelNotice() {
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);
  const show = useCallback((n: PanelNotice) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = n.sticky ? null : window.setTimeout(() => setNotice(null), 8000);
    setNotice(n);
  }, []);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  return { notice, show, clear };
}

export function PanelNoticeView({ notice, onDismiss }: { notice: PanelNotice | null; onDismiss: () => void }) {
  return (
    <div className="panel-notice-slot" role="status" aria-live="polite">
      {notice && (
        <div className={`panel-notice panel-notice--${notice.tone}`}>
          <Icon name={notice.tone === "warn" ? "alert" : notice.tone === "ok" ? "check" : notice.title.startsWith("Vault") ? "lock" : "info"} size={14} />
          <div className="panel-notice__body">
            <span className="panel-notice__title">{notice.title}</span>
            {notice.detail && <span className="panel-notice__detail">{notice.detail}</span>}
          </div>
          {notice.undo && (
            <button
              type="button"
              className="btn btn--sm panel-notice__undo"
              onClick={() => {
                notice.undo?.();
                onDismiss();
              }}
            >
              <Icon name="restore" size={13} /> Undo
            </button>
          )}
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss" onClick={onDismiss}>
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Vault lock/unlock cycle for a Create form (owner rule: nothing from the vault visible while locked).
 * `onLock` clears the form's vault-derived values and returns what it removed (kept in memory only,
 * never persisted); `onUnlock` gets it back on the next unlock in this app session.
 * `stashNow` runs the same clearing outside a lock (`submitted`: a vault job was sent while locked).
 */
export function useVaultLockCycle<T>(onLock: (submitted: boolean) => T | null, onUnlock: (stash: T) => void) {
  const vault = useVault();
  const fns = useRef({ onLock, onUnlock });
  fns.current = { onLock, onUnlock };
  const stash = useRef<T | null>(null);
  const epoch = useRef(vault.lockEpoch);
  useEffect(() => {
    if (epoch.current === vault.lockEpoch) return;
    epoch.current = vault.lockEpoch;
    const s = fns.current.onLock(false);
    if (s) stash.current = s;
  }, [vault.lockEpoch]);
  const was = useRef(vault.unlocked);
  useEffect(() => {
    const prev = was.current;
    was.current = vault.unlocked;
    if (!prev && vault.unlocked && stash.current) {
      const s = stash.current;
      stash.current = null;
      fns.current.onUnlock(s);
    }
  }, [vault.unlocked]);
  return {
    stashNow: () => {
      const s = fns.current.onLock(true);
      if (s) stash.current = s;
    },
  };
}

export interface RefItem {
  refId: string;
  thumbPath: string;
}
export interface LoraPick {
  loraId: string;
  strength: number;
}

// ---------------- Model cards ----------------

const MODEL_GLYPH: Record<string, string> = { chroma: "Ch", zimage: "Zi", flux2: "F2", qwen: "Qw" };

export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelView[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      className="model-grid"
      role="radiogroup"
      aria-label="Model"
      onKeyDown={radioKeys(
        models.map((m) => m.id),
        value,
        onChange,
      )}
    >
      {models.map((m) => {
        const selected = m.id === value;
        const task = isTaskActive(m.task) ? m.task : null;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!value && m === models[0]) ? 0 : -1}
            className={`model-card ${selected ? "is-selected" : ""} ${m.installed ? "" : "is-missing"}`}
            onClick={() => onChange(m.id)}
          >
            <span className="model-card__glyph" aria-hidden>
              {MODEL_GLYPH[m.id] ?? m.name.slice(0, 2)}
            </span>
            <span className="model-card__text">
              <span className="model-card__name">{m.name}</span>
              <span className="model-card__meta">
                {task ? (
                  <span className="badge badge--accent">Downloading {Math.round(pct(task.bytes, task.totalBytes))}%</span>
                ) : (
                  <>
                    {!m.installed && <span className="badge badge--muted">Not installed</span>}
                    {m.maxReferences > 0 && <span className="tag">refs ×{m.maxReferences}</span>}
                    {m.supportsImg2Img && <span className="tag">img2img</span>}
                    {m.installed && <span className="tag">{m.defaults.steps ? `${m.defaults.steps} steps` : m.precision}</span>}
                  </>
                )}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------- Image / Video switch ----------------

export type CreateMode = "image" | "video";

const MODES: { id: CreateMode; label: string; icon: "image" | "video" }[] = [
  { id: "image", label: "Image", icon: "image" },
  { id: "video", label: "Video", icon: "video" },
];

/** Segmented Image | Video switch with radio semantics (arrow keys move the selection). */
export function ModeSwitch({ value, onChange }: { value: CreateMode; onChange: (m: CreateMode) => void }) {
  return (
    <div
      className="mode-switch"
      role="radiogroup"
      aria-label="What to create"
      onKeyDown={radioKeys(
        MODES.map((m) => m.id),
        value,
        onChange,
      )}
    >
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={m.id === value}
          tabIndex={m.id === value ? 0 : -1}
          className={m.id === value ? "is-selected" : ""}
          onClick={() => onChange(m.id)}
        >
          <Icon name={m.icon} size={15} />
          {m.label}
        </button>
      ))}
    </div>
  );
}

// ---------------- References ----------------

export function References({
  max,
  refs,
  busy,
  dragActive,
  onRemove,
  onFiles,
  onPick,
  onPickGallery,
}: {
  max: number;
  refs: RefItem[];
  busy: boolean;
  dragActive: boolean;
  onRemove: (refId: string) => void;
  onFiles: (files: File[]) => void;
  onPick: () => void;
  /** "From gallery": pick one of your images as a reference. */
  onPickGallery?: () => void;
}) {
  const [over, setOver] = useState(false);
  const full = refs.length >= max;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) onFiles(files);
  };
  return (
    <div className="refs">
      <div
        className={`dropzone ${over || dragActive ? "is-over" : ""} ${full ? "is-full" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {refs.map((r, i) => (
          <figure key={r.refId} className="ref-thumb">
            <img src={fileSrc(r.thumbPath)} alt={`Reference ${i + 1}`} />
            <button type="button" className="ref-thumb__remove" aria-label={`Remove reference ${i + 1}`} onClick={() => onRemove(r.refId)}>
              <Icon name="x" size={12} />
            </button>
            <figcaption className="ref-thumb__n">{i + 1}</figcaption>
          </figure>
        ))}
        {!full && !onPickGallery && (
          <button type="button" className="dropzone__add" onClick={onPick} disabled={busy}>
            <Icon name={busy ? "refresh" : "upload"} className={busy ? "spin" : ""} />
            <span>{refs.length === 0 ? "Drop, paste (⌘V) or choose images" : "Add"}</span>
          </button>
        )}
        {!full && onPickGallery && (
          <div className="refs__add">
            <button type="button" className="btn btn--sm" onClick={onPickGallery} disabled={busy}>
              <Icon name="image" size={14} /> From gallery
            </button>
            <button type="button" className="btn btn--sm" onClick={onPick} disabled={busy}>
              <Icon name={busy ? "refresh" : "upload"} size={14} className={busy ? "spin" : ""} /> Browse computer
            </button>
            {refs.length === 0 && <span className="hint">{busy ? "Adding…" : "or drop / paste (⌘V) images"}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Start image (img2img) ----------------

export function StartImage({
  image,
  denoise,
  busy,
  dragActive,
  onDenoise,
  note,
  onRemove,
  onFiles,
  onPick,
  onPickGallery,
  caption,
}: {
  image: Pick<RefItem, "thumbPath"> | null;
  /** One line under the controls: where the image came from. */
  caption?: ReactNode;
  /** img2img strength; omit (with `onDenoise`) for a plain start frame (video i2v). */
  denoise?: number;
  busy: boolean;
  dragActive: boolean;
  onDenoise?: (v: number) => void;
  /** Shown instead of the strength slider when there is no `denoise`. */
  note?: string;
  onRemove: () => void;
  onFiles: (files: File[]) => void;
  /** "Browse computer": the native/browser file picker. */
  onPick: () => void;
  /** "From gallery": open the gallery picker (offered when given). */
  onPickGallery?: () => void;
}) {
  const [over, setOver] = useState(false);
  const id = useId();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) onFiles(files.slice(0, 1));
  };
  const dragProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop,
  };

  if (!image) {
    if (onPickGallery) {
      return (
        <div className={`dropzone dropzone--single start-sources ${over || dragActive ? "is-over" : ""}`} {...dragProps}>
          <div className="start-sources__btns">
            <button type="button" className="btn btn--sm" onClick={onPickGallery} disabled={busy}>
              <Icon name="image" size={14} /> From gallery
            </button>
            <button type="button" className="btn btn--sm" onClick={onPick} disabled={busy}>
              <Icon name={busy ? "refresh" : "upload"} size={14} className={busy ? "spin" : ""} /> Browse computer
            </button>
          </div>
          <span className="hint">{busy ? "Adding…" : "or drop / paste (⌘V) an image"}</span>
        </div>
      );
    }
    return (
      <div className={`dropzone dropzone--single ${over || dragActive ? "is-over" : ""}`} {...dragProps}>
        <button type="button" className="dropzone__add" onClick={onPick} disabled={busy}>
          <Icon name={busy ? "refresh" : "upload"} className={busy ? "spin" : ""} />
          <span>{busy ? "Adding…" : "Drop, paste (⌘V) or choose an image"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className={`start-image ${over || dragActive ? "is-over" : ""}`} {...dragProps}>
      <figure className="ref-thumb start-image__thumb">
        <img src={fileSrc(image.thumbPath)} alt="Start image" />
        {!onPickGallery && (
          <button type="button" className="ref-thumb__remove" aria-label="Remove start image" title="Remove start image" onClick={onRemove}>
            <Icon name="x" size={12} />
          </button>
        )}
        {busy && (
          <span className="start-image__busy" aria-label="Replacing the start image">
            <Icon name="refresh" className="spin" />
          </span>
        )}
      </figure>
      <div className="strength">
        {denoise != null && onDenoise ? (
          <>
            <div className="strength__head">
              <label className="field__label" htmlFor={`${id}-denoise`}>
                How much to change
              </label>
              <output className="mono strength__value" htmlFor={`${id}-denoise`}>
                {denoise.toFixed(2)}
              </output>
            </div>
            <input
              id={`${id}-denoise`}
              type="range"
              min={DENOISE_MIN}
              max={DENOISE_MAX}
              step={DENOISE_STEP}
              value={denoise}
              aria-valuetext={`${denoise.toFixed(2)} (${denoise < 0.35 ? "close to the start image" : denoise > 0.75 ? "mostly reimagined" : "balanced"})`}
              onChange={(e) => onDenoise(Math.round(Number(e.target.value) * 100) / 100)}
            />
            <div className="strength__ends" aria-hidden>
              <span>Keep close</span>
              <span>Reimagine</span>
            </div>
          </>
        ) : (
          note && <p className="hint start-image__note">{note}</p>
        )}
        {onPickGallery ? (
          <div className="start-image__replace" role="group" aria-label="Replace the start image">
            <span className="hint">Replace:</span>
            <button type="button" className="link-btn" onClick={onPickGallery} disabled={busy}>
              From gallery
            </button>
            <button type="button" className="link-btn" onClick={onPick} disabled={busy}>
              Browse computer
            </button>
            <button type="button" className="link-btn start-image__remove" onClick={onRemove} disabled={busy} aria-label="Remove start image">
              <Icon name="x" size={12} /> Remove
            </button>
          </div>
        ) : (
          <button type="button" className="link-btn strength__replace" onClick={onPick} disabled={busy}>
            Replace image
          </button>
        )}
        {caption && <p className="hint start-image__caption">{caption}</p>}
      </div>
    </div>
  );
}

// ---------------- LoRA picker ----------------

export function LoraPicker({
  model,
  library,
  picks,
  prompt,
  onChange,
  onRemoved,
  onToggleWord,
  onOpenLibrary,
  onAddFromLink,
}: {
  model: ModelView | undefined;
  library: Lora[];
  picks: LoraPick[];
  /** The prompt, to show which trigger words are already in it. */
  prompt: string;
  onChange: (p: LoraPick[]) => void;
  /** A LoRA was removed with its Remove button. */
  onRemoved?: (l: Lora) => void;
  /** Trigger-word chip: insert the word (`on`) or take it out of the prompt. */
  onToggleWord: (w: string, on: boolean) => void;
  onOpenLibrary: () => void;
  /** "Add LoRA from link…": opens the link dialog. */
  onAddFromLink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const compatible = library.filter((l) => model && l.modelId === model.id);
  const available = compatible.filter((l) => l.present && !picks.some((p) => p.loraId === l.id));
  const downloading = compatible.filter((l) => !l.present && isTaskActive(l.task));
  const added = compatible.filter((l) => picks.some((p) => p.loraId === l.id));
  const modelName = model?.name ?? "this model";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div className="lora-picker">
      {picks.map((p) => {
        const l = library.find((x) => x.id === p.loraId);
        if (!l) return null;
        return (
          <div key={p.loraId} className="lora-pick">
            <div className="lora-pick__row">
              <span className="lora-pick__name" title={l.filename}>
                {l.name}
              </span>
              <button
                type="button"
                className="lora-pick__remove"
                aria-label={`Remove ${l.name}`}
                title={`Remove ${l.name}`}
                onClick={() => {
                  onChange(picks.filter((x) => x.loraId !== p.loraId));
                  onRemoved?.(l);
                }}
              >
                <Icon name="x" size={12} />
                Remove
              </button>
            </div>
            <div className="lora-pick__strength">
              <label className="lora-pick__label" htmlFor={`${menuId}-${p.loraId}`}>
                Strength
              </label>
              <div className="lora-strength">
                <input
                  id={`${menuId}-${p.loraId}`}
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  list={`${menuId}-ticks`}
                  value={p.strength}
                  aria-valuetext={p.strength === 0 ? "0.00, no effect" : p.strength.toFixed(2)}
                  onChange={(e) => onChange(picks.map((x) => (x.loraId === p.loraId ? { ...x, strength: Number(e.target.value) } : x)))}
                />
                <div className="lora-strength__ends" aria-hidden>
                  <span>0</span>
                  <span>1</span>
                  <span>2</span>
                </div>
              </div>
              <button
                type="button"
                className="mono lora-strength__value"
                title="Reset to 1.00"
                aria-label={`Strength ${p.strength.toFixed(2)}. Reset ${l.name} to 1.00`}
                onClick={() => onChange(picks.map((x) => (x.loraId === p.loraId ? { ...x, strength: 1 } : x)))}
              >
                {p.strength.toFixed(2)}
              </button>
            </div>
            {p.strength === 0 && <p className="hint lora-pick__zero">No effect at 0 — this LoRA still uses a slot.</p>}
            {l.triggerWords.length > 0 && (
              <div className="chips chips--words" role="group" aria-label={`Trigger words for ${l.name}`}>
                {l.triggerWords.map((w) => {
                  const on = promptHasWord(prompt, w);
                  return (
                    <button
                      key={w}
                      type="button"
                      className={`chip chip--word ${on ? "is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => onToggleWord(w, !on)}
                      title={on ? "In the prompt — click to take it out" : "Add to the prompt"}
                    >
                      <Icon name={on ? "check" : "plus"} size={11} />
                      {w}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <datalist id={`${menuId}-ticks`}>
        <option value="1" />
      </datalist>

      <div className="lora-picker__add">
        <button
          ref={btnRef}
          type="button"
          className="btn btn--ghost btn--sm"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={picks.length >= MAX_LORAS}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="plus" /> Add LoRA
        </button>
        <span className="hint">
          {picks.length}/{MAX_LORAS}
        </span>
        {open && (
          <div
            ref={menuRef}
            id={menuId}
            className="menu lora-menu"
            role="menu"
            aria-label={`LoRAs for ${modelName}`}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
                const i = items.indexOf(document.activeElement as HTMLElement);
                items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
              }
            }}
          >
            {available.map((l) => (
              <button
                key={l.id}
                type="button"
                role="menuitem"
                className="menu__item lora-menu__item"
                onClick={() => {
                  onChange([...picks, { loraId: l.id, strength: 1 }]);
                  close();
                }}
              >
                <span className="lora-menu__name">{l.name}</span>
                <span className="hint lora-menu__sub">
                  {l.triggerWords.length ? l.triggerWords.join(" · ") : l.source === "civitai" ? "Civitai · no trigger words" : "Hugging Face · no trigger words"}
                </span>
              </button>
            ))}
            {downloading.map((l) => (
              <button key={l.id} type="button" role="menuitem" className="menu__item lora-menu__item" disabled aria-disabled>
                <span className="lora-menu__name">{l.name}</span>
                <span className="hint lora-menu__sub">
                  Downloading {l.task ? Math.round(pct(l.task.bytes, l.task.totalBytes)) : 0}% — ready soon
                </span>
              </button>
            ))}
            {available.length === 0 && (
              <div className="menu__empty">
                <p>
                  {compatible.length === 0
                    ? `No LoRAs for ${modelName} yet. Paste a ${modelName} LoRA link from Hugging Face or Civitai.`
                    : [
                        added.length ? `${added.map((l) => l.name).join(", ")} ${added.length === 1 ? "is" : "are"} already added.` : "",
                        downloading.length ? "" : `No other LoRAs for ${modelName}.`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                </p>
              </div>
            )}
            <div className="lora-menu__foot" role="none">
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setOpen(false);
                  onAddFromLink();
                }}
              >
                <span>
                  <Icon name="link" size={13} /> Add LoRA from link…
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setOpen(false);
                  onOpenLibrary();
                }}
              >
                <span>
                  <Icon name="layers" size={13} /> Open LoRA library
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Add LoRA from link" inside the Create screen (owner decision): resolve a Hugging Face / Civitai
 * link, confirm the name, model and trigger words, then add it (the download needs the image GPU,
 * so it goes through the start confirmation first, like the Models screen).
 */
export function AddLoraLinkDialog({
  open,
  model,
  onClose,
  onAdded,
}: {
  open: boolean;
  model: ModelView | undefined;
  onClose: () => void;
  onAdded: (l: Lora) => void;
}) {
  const lib = useLibrary();
  const gpu = useGpu();
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ link: string; data: ResolvedLora } | null>(null);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [words, setWords] = useState("");
  const [adding, setAdding] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setError(null);
    setPreview(null);
    setName("");
    setWords("");
    setModelId(model?.id ?? "");
  }, [open, model?.id]);

  const resolve = async (e: FormEvent) => {
    e.preventDefault();
    const link = url.trim();
    if (!link || resolving) return;
    setResolving(true);
    setError(null);
    setPreview(null);
    try {
      const data = await api.resolveLoraLink(link);
      setPreview({ link, data });
      setName(data.name);
      setWords(data.triggerWords.join(", "));
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setResolving(false);
    }
  };

  const add = async () => {
    if (!preview || !modelId || !name.trim() || adding) return;
    // Owner's rule: confirm before anything that starts a billed GPU. Cancel adds nothing.
    if (!(await gpu.confirmStart(`download ${name.trim()}`, "image"))) return;
    setAdding(true);
    setError(null);
    try {
      const triggerWords = words
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean);
      const l = await api.addLora({ url: preview.link, modelId, name: name.trim(), triggerWords });
      await lib.reloadLoras();
      onAdded(l);
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const target = lib.imageModels.find((m) => m.id === modelId);
  const suggested = preview?.data.suggestedModelId ? lib.imageModels.find((m) => m.id === preview.data.suggestedModelId) : undefined;
  const mismatch = !!preview && ((suggested && suggested.id !== modelId) || (!suggested && !!preview.data.baseModel));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add LoRA from link"
      className="lora-link-dialog"
      initialFocusRef={urlRef}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!preview || !modelId || !name.trim() || adding} onClick={() => void add()}>
            {adding ? (
              <>
                <Icon name="refresh" className="spin" /> Adding…
              </>
            ) : (
              <>
                <Icon name="download" /> Add and download
              </>
            )}
          </button>
        </>
      }
    >
      <p className="hint">
        Paste a {model ? `${model.name} ` : ""}LoRA link: a Hugging Face file (…/blob/main/x.safetensors) or a Civitai model page. It downloads to
        your volume and is added to this form when ready.
      </p>
      <form className="link-form" onSubmit={resolve}>
        <label className="visually-hidden" htmlFor={`${id}-url`}>
          LoRA link
        </label>
        <div className="input-icon">
          <Icon name="link" />
          <input
            ref={urlRef}
            id={`${id}-url`}
            className="input"
            type="url"
            placeholder="https://civitai.com/models/… or https://huggingface.co/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button type="submit" className="btn" disabled={resolving || !url.trim()}>
          {resolving ? (
            <>
              <Icon name="refresh" className="spin" /> Checking…
            </>
          ) : (
            "Check link"
          )}
        </button>
      </form>
      {error && (
        <p className="notice notice--error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
      {preview && (
        <div className="lora-link-dialog__preview" aria-label="Resolved LoRA">
          <div className="lora-preview__meta">
            <span className="badge">{preview.data.source === "civitai" ? "Civitai" : "Hugging Face"}</span>
            {preview.data.baseModel && <span className="tag">base: {preview.data.baseModel}</span>}
            {preview.data.sizeBytes ? <span className="tag mono">{formatBytes(preview.data.sizeBytes)}</span> : null}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-name`}>
              Name
            </label>
            <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-model`}>
              Made for model
            </label>
            <select id={`${id}-model`} className="input select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="" disabled>
                Choose a model…
              </option>
              {lib.imageModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {mismatch && (
              <p className="hint field-warn">
                <Icon name="alert" size={12} />{" "}
                {suggested
                  ? `This LoRA looks made for ${suggested.name}; it only works with the model it was trained for.`
                  : `Its base model (${preview.data.baseModel}) doesn't match any installed model; it may not work with ${target?.name ?? "the one you pick"}.`}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-words`}>
              Trigger words <span className="section__aside">(comma separated, optional)</span>
            </label>
            <input id={`${id}-words`} className="input" value={words} onChange={(e) => setWords(e.target.value)} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------- Aspect + count ----------------

export function AspectPicker({
  value,
  onChange,
  disabled = false,
  describedBy,
  highlight,
}: {
  value: string;
  onChange: (k: string) => void;
  /** While disabled: the chip matching the start image's shape. */
  highlight?: string;
  /** img2img: the size follows the start image. */
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <div
      className={`chips ${disabled ? "is-disabled" : ""}`}
      role="radiogroup"
      aria-label="Aspect ratio"
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onKeyDown={
        disabled
          ? undefined
          : radioKeys(
              ASPECTS.map((a) => a.key),
              value,
              onChange,
            )
      }
    >
      {ASPECTS.map((a) => (
        <button
          key={a.key}
          type="button"
          role="radio"
          aria-checked={a.key === value}
          tabIndex={a.key === value ? 0 : -1}
          className={`chip chip--aspect ${a.key === value && !disabled ? "is-selected" : ""} ${disabled && a.key === highlight ? "is-matched" : ""}`}
          disabled={disabled}
          onClick={() => onChange(a.key)}
          title={`${a.w} × ${a.h}`}
        >
          <AspectShape w={a.w} h={a.h} />
          {a.key}
        </button>
      ))}
    </div>
  );
}

export function CountPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const opts = [1, 2, 3, 4];
  return (
    <div className="segmented" role="radiogroup" aria-label="Number of images" onKeyDown={radioKeys(opts, value, onChange)}>
      {opts.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === value}
          tabIndex={n === value ? 0 : -1}
          className={n === value ? "is-selected" : ""}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// ---------------- Advanced ----------------

export interface AdvancedValues {
  seed: string;
  randomSeed: boolean;
  steps: string;
  cfg: string;
  negativePrompt: string;
}

export const SEED_MAX = 4294967295;
export const STEPS_MAX = 150;
export const CFG_MAX = 30;

export function advancedDefaults(m: ModelView | undefined): AdvancedValues {
  return {
    seed: "",
    randomSeed: true,
    steps: m && m.defaults.steps > 0 ? String(m.defaults.steps) : "",
    cfg: m && m.defaults.cfg > 0 ? String(m.defaults.cfg) : "",
    negativePrompt: m?.supportsNegativePrompt ? m.defaults.negativePrompt : "",
  };
}

export interface AdvIssues {
  seed?: string;
  steps?: string;
  cfg?: string;
  /** Allowed but costly (many more steps than the model needs). */
  stepsWarn?: string;
}

/** Validation for Seed / Steps / CFG: values are never rewritten, problems are shown and block Generate. */
export function advIssues(v: AdvancedValues, m: ModelView | undefined): AdvIssues {
  const out: AdvIssues = {};
  const seed = v.seed.trim();
  if (!v.randomSeed && seed !== "" && (!/^\d+$/.test(seed) || Number(seed) > SEED_MAX)) out.seed = `Use a whole number from 0 to ${SEED_MAX}.`;
  const steps = v.steps.trim();
  if (steps !== "") {
    const n = Number(steps);
    if (!/^\d+$/.test(steps) || n < 1 || n > STEPS_MAX) out.steps = `Use a whole number from 1 to ${STEPS_MAX}.`;
    else if (m && m.defaults.steps > 0 && n >= m.defaults.steps * 2.5)
      out.stepsWarn = `${m.name} works well at ${m.defaults.steps} steps; ${n} takes about ${Math.round(n / m.defaults.steps)}× as long on the GPU.`;
  }
  const cfg = v.cfg.trim();
  if (cfg !== "" && (!/^\d+(\.\d+)?$/.test(cfg) || Number(cfg) > CFG_MAX)) out.cfg = `Use a number from 0 to ${CFG_MAX}.`;
  return out;
}

/** "Fix Steps in Advanced" while any field is invalid, else null. */
export function advBlocker(v: AdvancedValues, m: ModelView | undefined): string | null {
  const i = advIssues(v, m);
  const bad = [i.seed && "Seed", i.steps && "Steps", i.cfg && "CFG"].filter(Boolean);
  return bad.length ? `Fix ${bad.join(", ")} in Advanced` : null;
}

export function Advanced({
  model,
  values,
  onChange,
  open,
  onToggle,
}: {
  model: ModelView | undefined;
  values: AdvancedValues;
  onChange: (v: AdvancedValues) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const set = (patch: Partial<AdvancedValues>) => onChange({ ...values, ...patch });
  const defaults = advancedDefaults(model);
  const issues = advIssues(values, model);
  const customNeg = !!model?.supportsNegativePrompt && values.negativePrompt.trim() !== defaults.negativePrompt.trim();
  const isDefault =
    values.randomSeed === defaults.randomSeed && values.steps === defaults.steps && values.cfg === defaults.cfg && values.negativePrompt === defaults.negativePrompt;
  const dSteps = model?.defaults.steps ? String(model.defaults.steps) : "";
  const dCfg = model?.defaults.cfg ? String(model.defaults.cfg) : "";
  const randomEffective = values.randomSeed || values.seed.trim() === "";
  const summary = [
    randomEffective ? "random seed" : `seed ${values.seed}`,
    `${values.steps.trim() || dSteps || "default"} steps`,
    `CFG ${values.cfg.trim() || dCfg || "default"}`,
    customNeg ? "custom negative" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // Opening the drawer brings it into view above the sticky footer (UX-022).
  const toggle = () => {
    const opening = !open;
    onToggle();
    if (!opening) return;
    requestAnimationFrame(() => {
      const el = sectionRef.current;
      const scroller = el?.closest<HTMLElement>(".panel__scroll");
      if (!el || !scroller) return;
      const tall = el.getBoundingClientRect().height > scroller.clientHeight;
      el.scrollIntoView({ block: tall ? "start" : "nearest", behavior: "smooth" });
    });
  };

  const err = (key: keyof AdvIssues) => (issues[key] ? `${id}-${key}-err` : undefined);

  return (
    <section className="advanced" ref={sectionRef}>
      <button type="button" className="advanced__toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <Icon name="sliders" />
        <span>Advanced</span>
        {!isDefault && <span className="dot" aria-label="(modified)" />}
        {(issues.seed || issues.steps || issues.cfg) && <span className="dot dot--danger" aria-label="(needs fixing)" />}
        <span className="advanced__summary">{summary}</span>
        <Icon name="chevronDown" className={`chev ${open ? "is-open" : ""}`} />
      </button>
      <div id={id} className="advanced__body" hidden={!open}>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-seed`}>
            Seed
          </label>
          <div className="seed-row">
            <input
              id={`${id}-seed`}
              className={`input mono ${issues.seed ? "is-invalid" : ""}`}
              inputMode="numeric"
              maxLength={12}
              placeholder={values.randomSeed ? "Random each run" : "Empty = random"}
              value={values.randomSeed ? "" : values.seed}
              disabled={values.randomSeed}
              aria-invalid={!!issues.seed || undefined}
              aria-describedby={err("seed") ?? (!values.randomSeed && values.seed.trim() === "" ? `${id}-seed-help` : undefined)}
              onChange={(e) => set({ seed: e.target.value })}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Roll a new seed"
              title="Roll a new seed"
              onClick={() => set({ randomSeed: false, seed: String(Math.floor(Math.random() * 2 ** 32)) })}
            >
              <Icon name="dice" />
            </button>
            <label className="switch">
              <input type="checkbox" checked={values.randomSeed} onChange={(e) => set({ randomSeed: e.target.checked })} />
              <span className="switch__track" aria-hidden />
              <span>Random</span>
            </label>
          </div>
          {issues.seed ? (
            <p className="field-error" id={`${id}-seed-err`} role="alert">
              {issues.seed}
            </p>
          ) : (
            !values.randomSeed &&
            values.seed.trim() === "" && (
              <p className="hint field-help" id={`${id}-seed-help`}>
                Empty — a random seed will be used.
              </p>
            )
          )}
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-steps`}>
              Steps
            </label>
            <input
              id={`${id}-steps`}
              className={`input mono ${issues.steps ? "is-invalid" : ""}`}
              inputMode="numeric"
              maxLength={6}
              placeholder={dSteps ? `Default (${dSteps})` : "Model default"}
              value={values.steps}
              aria-invalid={!!issues.steps || undefined}
              aria-describedby={err("steps") ?? `${id}-steps-help`}
              onChange={(e) => set({ steps: e.target.value })}
            />
            {issues.steps ? (
              <p className="field-error" id={`${id}-steps-err`} role="alert">
                {issues.steps}
              </p>
            ) : (
              <p className={`hint field-help ${issues.stepsWarn ? "field-warn" : ""}`} id={`${id}-steps-help`}>
                {issues.stepsWarn ?? `1–${STEPS_MAX}${dSteps ? `, default ${dSteps}` : ""}`}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-cfg`}>
              CFG
            </label>
            <input
              id={`${id}-cfg`}
              className={`input mono ${issues.cfg ? "is-invalid" : ""}`}
              inputMode="decimal"
              maxLength={6}
              placeholder={dCfg ? `Default (${dCfg})` : "Model default"}
              value={values.cfg}
              aria-invalid={!!issues.cfg || undefined}
              aria-describedby={err("cfg") ?? `${id}-cfg-help`}
              onChange={(e) => set({ cfg: e.target.value })}
            />
            {issues.cfg ? (
              <p className="field-error" id={`${id}-cfg-err`} role="alert">
                {issues.cfg}
              </p>
            ) : (
              <p className="hint field-help" id={`${id}-cfg-help`}>
                0–{CFG_MAX}
                {dCfg ? `, default ${dCfg}` : ""}
              </p>
            )}
          </div>
        </div>
        {model?.supportsNegativePrompt && (
          <div className="field">
            <label className="field__label" htmlFor={`${id}-neg`}>
              Negative prompt
            </label>
            <textarea
              id={`${id}-neg`}
              className="input textarea textarea--sm"
              rows={3}
              value={values.negativePrompt}
              onChange={(e) => set({ negativePrompt: e.target.value })}
            />
          </div>
        )}
        <div className="advanced__foot">
          <span className="hint">
            {model ? `${model.name} defaults: ${model.defaults.steps || "auto"} steps, CFG ${model.defaults.cfg || "auto"}` : ""}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" disabled={isDefault} onClick={() => onChange(defaults)}>
            <Icon name="restore" /> Reset to defaults
          </button>
        </div>
      </div>
    </section>
  );
}
