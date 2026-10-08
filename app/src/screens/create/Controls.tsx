import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { fileSrc, isTaskActive, type Lora, type ModelView } from "../../api";
import { AspectShape, Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { ASPECTS } from "../../lib/aspect";
import { pct } from "../../lib/format";

export const MAX_LORAS = 3;

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
                ) : m.installed ? (
                  <>
                    {m.maxReferences > 0 && <span className="tag">refs ×{m.maxReferences}</span>}
                    <span className="tag">{m.defaults.steps ? `${m.defaults.steps} steps` : m.precision}</span>
                  </>
                ) : (
                  <span className="badge badge--muted">Not installed</span>
                )}
              </span>
            </span>
          </button>
        );
      })}
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
}: {
  max: number;
  refs: RefItem[];
  busy: boolean;
  dragActive: boolean;
  onRemove: (refId: string) => void;
  onFiles: (files: File[]) => void;
  onPick: () => void;
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
        {!full && (
          <button type="button" className="dropzone__add" onClick={onPick} disabled={busy}>
            <Icon name={busy ? "refresh" : "upload"} className={busy ? "spin" : ""} />
            <span>{refs.length === 0 ? "Drop, paste (⌘V) or choose images" : "Add"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------- LoRA picker ----------------

export function LoraPicker({
  model,
  library,
  picks,
  onChange,
  onInsertWord,
  onOpenLibrary,
}: {
  model: ModelView | undefined;
  library: Lora[];
  picks: LoraPick[];
  onChange: (p: LoraPick[]) => void;
  onInsertWord: (w: string) => void;
  onOpenLibrary: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const compatible = library.filter((l) => model && l.modelId === model.id);
  const available = compatible.filter((l) => l.present && !picks.some((p) => p.loraId === l.id));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

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
              <label className="lora-pick__strength">
                <span className="visually-hidden">Strength for {l.name}</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={p.strength}
                  onChange={(e) => onChange(picks.map((x) => (x.loraId === p.loraId ? { ...x, strength: Number(e.target.value) } : x)))}
                />
                <output className="mono">{p.strength.toFixed(2)}</output>
              </label>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={`Remove ${l.name}`}
                onClick={() => onChange(picks.filter((x) => x.loraId !== p.loraId))}
              >
                <Icon name="x" />
              </button>
            </div>
            {l.triggerWords.length > 0 && (
              <div className="chips chips--words" aria-label={`Trigger words for ${l.name}`}>
                {l.triggerWords.map((w) => (
                  <button key={w} type="button" className="chip chip--word" onClick={() => onInsertWord(w)} title="Insert into prompt">
                    <Icon name="plus" size={11} />
                    {w}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

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
            className="menu"
            role="menu"
            aria-label="Compatible LoRAs"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                btnRef.current?.focus();
              }
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
                const i = items.indexOf(document.activeElement as HTMLElement);
                items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
              }
            }}
          >
            {available.length === 0 ? (
              <div className="menu__empty">
                <p>
                  {compatible.length === 0
                    ? `No LoRAs for ${model?.name ?? "this model"} yet.`
                    : "All compatible LoRAs are added or still downloading."}
                </p>
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn--sm"
                  onClick={() => {
                    setOpen(false);
                    onOpenLibrary();
                  }}
                >
                  Open LoRA library
                </button>
              </div>
            ) : (
              available.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => {
                    onChange([...picks, { loraId: l.id, strength: 1 }]);
                    setOpen(false);
                    btnRef.current?.focus();
                  }}
                >
                  <span>{l.name}</span>
                  <span className="hint">{l.source === "civitai" ? "Civitai" : "Hugging Face"}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Aspect + count ----------------

export function AspectPicker({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div
      className="chips"
      role="radiogroup"
      aria-label="Aspect ratio"
      onKeyDown={radioKeys(
        ASPECTS.map((a) => a.key),
        value,
        onChange,
      )}
    >
      {ASPECTS.map((a) => (
        <button
          key={a.key}
          type="button"
          role="radio"
          aria-checked={a.key === value}
          tabIndex={a.key === value ? 0 : -1}
          className={`chip chip--aspect ${a.key === value ? "is-selected" : ""}`}
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

export function advancedDefaults(m: ModelView | undefined): AdvancedValues {
  return {
    seed: "",
    randomSeed: true,
    steps: m && m.defaults.steps > 0 ? String(m.defaults.steps) : "",
    cfg: m && m.defaults.cfg > 0 ? String(m.defaults.cfg) : "",
    negativePrompt: m?.supportsNegativePrompt ? m.defaults.negativePrompt : "",
  };
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
  const set = (patch: Partial<AdvancedValues>) => onChange({ ...values, ...patch });
  const defaults = advancedDefaults(model);
  const isDefault =
    values.randomSeed === defaults.randomSeed &&
    values.steps === defaults.steps &&
    values.cfg === defaults.cfg &&
    values.negativePrompt === defaults.negativePrompt;
  const num = (e: ChangeEvent<HTMLInputElement>) => e.target.value.replace(/[^\d.]/g, "");

  return (
    <section className="advanced">
      <button type="button" className="advanced__toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <Icon name="sliders" />
        <span>Advanced</span>
        {!isDefault && <span className="dot" aria-label="(modified)" />}
        <span className="advanced__summary">
          {values.randomSeed ? "random seed" : `seed ${values.seed || "—"}`} · {values.steps || "auto"} steps · CFG {values.cfg || "auto"}
        </span>
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
              className="input mono"
              inputMode="numeric"
              placeholder={values.randomSeed ? "Random each run" : "e.g. 42"}
              value={values.randomSeed ? "" : values.seed}
              disabled={values.randomSeed}
              onChange={(e) => set({ seed: e.target.value.replace(/\D/g, "").slice(0, 10) })}
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
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-steps`}>
              Steps
            </label>
            <input
              id={`${id}-steps`}
              className="input mono"
              inputMode="numeric"
              placeholder="Model default"
              value={values.steps}
              onChange={(e) => set({ steps: num(e).replace(/\./g, "").slice(0, 3) })}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-cfg`}>
              CFG
            </label>
            <input
              id={`${id}-cfg`}
              className="input mono"
              inputMode="decimal"
              placeholder="Model default"
              value={values.cfg}
              onChange={(e) => set({ cfg: num(e).slice(0, 5) })}
            />
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
