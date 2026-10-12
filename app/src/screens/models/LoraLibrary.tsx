import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import * as api from "../../api";
import { isTaskActive, type Lora, type ResolvedLora } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { findLoraDuplicate, LORA_LINK_HELP, LORA_LINK_LABEL, loraDuplicateText, loraLinkProblem } from "../create/Controls";
import { useToast } from "../../state/toast";

const NAME_MAX = 60;

export function LoraLibrary() {
  const lib = useLibrary();
  const gpu = useGpu();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ link: string; data: ResolvedLora } | null>(null);
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [words, setWords] = useState<string[]>([]);
  const [wordDraft, setWordDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  const resolve = async (e: FormEvent) => {
    e.preventDefault();
    const link = url.trim();
    if (!link) return;
    // Same check and wording as Create's "Add LoRA from link" (UI-017/UI-018); the browser's bubble is off (noValidate).
    const problem = loraLinkProblem(link);
    if (problem) {
      setPreview(null);
      setResolveError(problem);
      urlRef.current?.focus();
      return;
    }
    setResolving(true);
    setResolveError(null);
    setPreview(null);
    try {
      const data = await api.resolveLoraLink(link);
      setPreview({ link, data });
      setName(data.name);
      setModelId(data.suggestedModelId ?? "");
      setWords(data.triggerWords);
      setWordDraft("");
    } catch (err) {
      setResolveError(api.errorMessage(err));
    } finally {
      setResolving(false);
    }
  };

  const add = async () => {
    if (!preview || !modelId || !name.trim() || nameTooLong || duplicate) return;
    const vol = lib.status?.volume;
    const size = preview.data.sizeBytes ?? 0;
    const details = [
      `Downloads ${formatBytes(size)} to ${lib.settings?.volumeNames?.[0] ?? "the image volume"}${vol ? ` · about ${formatBytes(Math.max(0, vol.freeBytes - size))} free afterwards` : ""}.`,
    ];
    if (!(await gpu.confirmStart(`download ${name.trim()}`, "image", { details, confirmLabel: `Start GPU & download ${formatBytes(size)}` }))) return;
    setAdding(true);
    try {
      const l = await api.addLora({ url: preview.link, modelId, name: name.trim(), triggerWords: words });
      toast.success(`Adding ${l.name}`, "Downloading to the volume…");
      setPreview(null);
      setUrl("");
      urlRef.current?.focus(); // the form that had focus is gone (UI-006)
      await lib.reloadLoras();
    } catch (err) {
      toast.error("Couldn't add the LoRA", err);
    } finally {
      setAdding(false);
    }
  };

  /** Splits on commas too (a pasted "a, b" becomes two chips — UX-091). */
  const addWord = (text = wordDraft) => {
    const parts = text
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    if (parts.length) setWords((cur) => [...cur, ...parts.filter((w, i) => !cur.includes(w) && parts.indexOf(w) === i)]);
    setWordDraft("");
  };

  const modelName = (id: string) => lib.models.find((m) => m.id === id)?.name ?? id;
  const baseMismatch = preview?.data.baseModel && !preview.data.suggestedModelId;
  // Chosen model differs from the one Civitai lists the LoRA for (UX-052).
  const wrongBase = !!preview?.data.suggestedModelId && !!modelId && modelId !== preview.data.suggestedModelId;
  const chosen = lib.imageModels.find((m) => m.id === modelId);
  const chosenMissing = !!chosen && !chosen.installed;
  const nameTooLong = name.trim().length > NAME_MAX;
  // One rule and wording with Create's "Add LoRA from link" (UI-018): the same link or file for this
  // model is refused (the core refuses the same file); for another model it's only a note.
  const dup = preview ? findLoraDuplicate(lib.loras, preview.link, preview.data.filename, modelId) : null;
  const duplicate = dup?.blocking ? dup.lora : undefined;
  const addLabel = adding ? "Adding…" : wrongBase ? "Add anyway" : gpu.profiles.image.needsStart ? "Add & download (starts GPU)" : "Add to library";
  const addBlocked = !modelId ? "Choose which model this LoRA is for." : !name.trim() ? "Give it a name." : nameTooLong ? `Keep the name to ${NAME_MAX} characters.` : duplicate ? "Already in your library for this model." : null;
  // Always one line under the buttons, so choosing a model doesn't shift the form (UI-075).
  const addNote =
    addBlocked ??
    `Downloads ${formatBytes(preview?.data.sizeBytes ?? null)} to ${lib.settings?.volumeNames?.[0] ?? "the image volume"}${gpu.profiles.image.needsStart ? ` — starts the Images GPU (${gpu.profiles.image.costLabel}) first` : ""}.`;

  /** Discard empties the field too, so nothing stale stays armed (UI-051), and focus stays in the form (UI-006). */
  const discard = () => {
    setPreview(null);
    setUrl("");
    setResolveError(null);
    urlRef.current?.focus();
  };

  return (
    <section id="lora-library" className="card loras" aria-labelledby="lora-title">
      {/* tabIndex -1: "Open LoRA library" from Create focuses this heading (UI-037). */}
      <h2 id="lora-title" className="card__title" tabIndex={-1}>
        <Icon name="layers" /> LoRA library
      </h2>

      <form className="link-form" onSubmit={resolve} noValidate>
        <label className="field__label" htmlFor="lora-url">
          {LORA_LINK_LABEL}
        </label>
        <div className="link-form__row">
          <div className="input-icon">
            <Icon name="link" />
            <input
              ref={urlRef}
              id="lora-url"
              className="input"
              type="url"
              placeholder="https://civitai.com/models/… or https://huggingface.co/…"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setResolveError(null); // an error never sits beside a corrected link (UI-017)
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!resolveError}
              aria-describedby={resolveError ? "lora-url-error lora-url-help" : "lora-url-help"}
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
        </div>
        <p id="lora-url-help" className="hint">
          {LORA_LINK_HELP}
        </p>
      </form>
      {resolveError && (
        <p id="lora-url-error" className="notice notice--error" role="alert">
          <Icon name="alert" /> {resolveError}
        </p>
      )}

      {preview && (
        <div className="lora-preview" aria-label="Resolved LoRA">
          {preview.data.previewUrl && <img className="lora-preview__img" src={preview.data.previewUrl} alt="" />}
          <div className="lora-preview__body">
            <div className="lora-preview__meta">
              <span className="badge">{preview.data.source === "civitai" ? "Civitai" : "Hugging Face"}</span>
              {preview.data.baseModel && <span className="tag">base: {preview.data.baseModel}</span>}
              <span className="tag mono">{formatBytes(preview.data.sizeBytes)}</span>
              <span className="tag mono" title={preview.data.downloadUrl}>
                {preview.data.filename}
              </span>
            </div>
            <div className="field-row">
              <div className="field">
                <div className="field__label-row">
                  <label className="field__label" htmlFor="lora-name">
                    Name
                  </label>
                  <span className={`hint mono ${nameTooLong ? "hint--error" : ""}`} aria-live="polite">
                    {name.trim().length}/{NAME_MAX}
                  </span>
                </div>
                <input
                  id="lora-name"
                  className={`input ${nameTooLong ? "input--invalid" : ""}`}
                  value={name}
                  maxLength={NAME_MAX + 20}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={nameTooLong}
                  aria-describedby="lora-name-help"
                />
                <p id="lora-name-help" className="hint">
                  Only a label — the file is saved as <span className="mono">{preview.data.filename}</span>.
                </p>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="lora-model">
                  Use with model
                </label>
                <select id="lora-model" className="input select" value={modelId} onChange={(e) => setModelId(e.target.value)} required>
                  <option value="" disabled>
                    Choose a model…
                  </option>
                  {lib.imageModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.installed ? "" : " (not installed)"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {baseMismatch && (
              <p className="notice notice--warn">
                <Icon name="alert" /> Base model “{preview.data.baseModel}” doesn't match any of your models. It may not work.
              </p>
            )}
            {wrongBase && (
              <p className="notice notice--warn">
                <Icon name="alert" /> {preview.data.source === "civitai" ? "Civitai" : "The source"} lists this LoRA for {preview.data.baseModel ?? modelName(preview.data.suggestedModelId!)}. It
                probably won't work with {modelName(modelId)}.
              </p>
            )}
            {chosenMissing && chosen && (
              <p className="notice notice--warn">
                <Icon name="info" /> {chosen.name} isn't installed yet; this LoRA won't be usable until you download it ({formatBytes(chosen.totalBytes - chosen.presentBytes)}) above.
              </p>
            )}
            {dup && (
              <p className={`notice ${dup.blocking ? "notice--warn" : ""}`} role={dup.blocking ? "alert" : undefined}>
                <Icon name={dup.blocking ? "alert" : "info"} /> {loraDuplicateText(dup, modelName)}
              </p>
            )}
            <div className="field">
              <span className="field__label" id="lora-words-label">
                Trigger words
              </span>
              <div className="chips" aria-labelledby="lora-words-label">
                {words.map((w) => (
                  <span key={w} className="chip chip--word is-static">
                    {w}
                    <button type="button" className="chip__x" aria-label={`Remove ${w}`} onClick={() => setWords(words.filter((x) => x !== w))}>
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
                <input
                  className="input input--chip"
                  aria-label="Add trigger word"
                  placeholder={words.length ? "Add…" : "None — type to add"}
                  value={wordDraft}
                  onChange={(e) => setWordDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addWord();
                    }
                  }}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    if (text.includes(",")) {
                      e.preventDefault();
                      addWord(wordDraft + text);
                    }
                  }}
                  onBlur={() => addWord()}
                />
              </div>
            </div>
            <div className="btn-row btn-row--end">
              <button type="button" className="btn btn--ghost" onClick={discard}>
                Discard
              </button>
              <button type="button" className="btn btn--primary" onClick={add} disabled={adding || !!addBlocked} aria-describedby="lora-add-why">
                <Icon name="plus" /> {addLabel}
              </button>
            </div>
            <p id="lora-add-why" className="hint btn-row--end-hint">
              {addNote}
            </p>
          </div>
        </div>
      )}

      {lib.loras.length === 0 ? (
        <p className="empty-line">No LoRAs yet.</p>
      ) : (
        <ul className="lora-list" aria-label="Your LoRAs">
          {lib.loras.map((l) => (
            <LoraRow
              key={l.id}
              lora={l}
              modelName={modelName(l.modelId)}
              baseInstalled={lib.models.find((m) => m.id === l.modelId)?.installed ?? false}
              sameFileElsewhere={lib.loras.filter((o) => o.id !== l.id && o.filename === l.filename).map((o) => `“${o.name}” (${modelName(o.modelId)})`)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoraRow({
  lora: l,
  modelName,
  baseInstalled,
  sameFileElsewhere,
}: {
  lora: Lora;
  modelName: string;
  baseInstalled: boolean;
  /** Other entries with the same filename (for other models): each has its own copy in its model's folder. */
  sameFileElsewhere: string[];
}) {
  const lib = useLibrary();
  const gpu = useGpu();
  const pg = gpu.profiles.image;
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const task = isTaskActive(l.task) ? l.task : null;
  const deleting = busy || task?.kind === "delete";
  const deleteRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  // Keep / Esc removes the focused button: focus goes back to the row's Delete (UI-006).
  const refocus = useRef(false);
  useEffect(() => {
    if (!confirming && refocus.current) {
      refocus.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);
  const keep = () => {
    refocus.current = true;
    setConfirming(false);
  };
  const onConfirmKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !busy) {
      e.stopPropagation();
      keep();
    }
  };

  const size = formatBytes(l.sizeBytes);
  const del = async () => {
    // A file that isn't on the volume needs no GPU: the core removes only the record.
    if (
      l.present &&
      !(await gpu.confirmStart(`delete ${l.name}`, "image", {
        details: [`Deletes ${l.filename} (${size}) for ${modelName}; the GPU stops again when that's done.`],
        confirmLabel: `Start GPU & delete ${size}`,
        danger: true,
      }))
    ) {
      keep();
      return;
    }
    setBusy(true);
    // The confirm (and its focused button) goes away: the row holds focus while it deletes (UI-006).
    rowRef.current?.focus({ preventScroll: true });
    try {
      const task = await api.deleteLora(l.id);
      if (task) {
        lib.applyTask(task); // completion toast + reload come from task-update
      } else {
        toast.info(`Deleted ${l.name}`);
        // This row goes away: focus moves to the next row's Delete (or the previous one's, or the link field).
        const li = rowRef.current;
        const next = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>("button[aria-label^='Delete']");
        (next ?? document.getElementById("lora-url"))?.focus();
        await lib.reloadLoras();
      }
    } catch (e) {
      toast.error(`Couldn't delete ${l.name}`, e);
      setBusy(false);
      keep();
    }
  };

  const cancel = async () => {
    if (!task) return;
    try {
      await api.cancelTask(task.taskId);
    } catch (e) {
      toast.error("Couldn't cancel", e);
    }
  };

  // Stage text like the model cards: GPU start-up vs the transfer, no % while indeterminate (UI-076).
  const stage = !task
    ? ""
    : task.status === "queued"
      ? pg.state?.status === "starting"
        ? `Queued — starting the GPU${pg.state.phase ? ` · ${pg.state.phase}` : ""}`
        : "Queued — waiting for the GPU"
      : task.kind === "delete"
        ? "Deleting…"
        : `Downloading · ${formatBytes(task.bytes)} / ${formatBytes(task.totalBytes)} · ${Math.round(pct(task.bytes, task.totalBytes))}%`;

  return (
    <li ref={rowRef} className={`lora-row ${confirming ? "is-confirming" : ""}`} tabIndex={-1}>
      <div className="lora-row__main">
        <div className="lora-row__title">
          <span className="lora-row__name">{l.name}</span>
          <span className="tag">{modelName}</span>
          <span className="hint">{l.source === "civitai" ? "Civitai" : "Hugging Face"}</span>
        </div>
        <div className="lora-row__sub">
          <span className="mono hint" title={l.sourceUrl}>
            {l.filename}
          </span>
          <span className="mono hint">{size}</span>
          {l.triggerWords.length > 0 && <span className="hint">· {l.triggerWords.join(", ")}</span>}
        </div>
        {task && task.kind === "download" && (
          <div className="task-progress task-progress--compact">
            <ProgressBar label={`${l.name} download`} value={pct(task.bytes, task.totalBytes)} indeterminate={task.status === "queued"} />
            <span className="hint lora-row__stage" aria-live="polite">
              {stage}
            </span>
          </div>
        )}
      </div>
      <div className="lora-row__side">
        {task && task.kind === "download" ? (
          <button type="button" className="btn btn--outline btn--sm" onClick={cancel}>
            <Icon name="stop" /> Cancel download
          </button>
        ) : deleting ? (
          <span className="badge badge--warn" aria-live="polite">
            {task ? stage : "Deleting…"}
          </span>
        ) : (
          <span
            className={`badge ${l.present && baseInstalled ? "badge--ok" : "badge--warn"}`}
            title={l.present && !baseInstalled ? `${modelName} isn't installed — download it on this screen to use this LoRA.` : undefined}
          >
            {!l.present ? "Missing" : baseInstalled ? "Ready" : `Needs ${modelName}`}
          </span>
        )}
        {!confirming && !deleting && !task && (
          <button
            ref={deleteRef}
            type="button"
            className="btn btn--ghost btn--sm btn--danger-text"
            aria-label={`Delete ${l.name} (${modelName})`}
            onClick={() => setConfirming(true)}
          >
            <Icon name="trash" /> Delete
          </button>
        )}
      </div>
      {confirming && !deleting && (
        // Names the file and what happens to it (UI-011); full-size buttons 12px apart (UI-068); Esc = Keep (UI-051).
        <div className="confirm lora-row__confirm" role="group" aria-label={`Delete ${l.name}?`} onKeyDown={onConfirmKey}>
          <p className="lora-row__confirm-text">
            {l.present ? (
              <>
                Delete <span className="mono">{l.filename}</span> ({size}) for {modelName} from the volume?
                {pg.needsStart ? " This starts the Images GPU." : ""}
              </>
            ) : (
              <>
                Remove “{l.name}” from the library? Its file isn&apos;t on the volume, so nothing else changes.
              </>
            )}
            {sameFileElsewhere.length > 0 && <> {sameFileElsewhere.join(", ")} {sameFileElsewhere.length === 1 ? "keeps its" : "keep their"} own copy.</>}
          </p>
          <div className="lora-row__confirm-actions">
            <button type="button" className="btn" onClick={keep} autoFocus>
              Keep
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void del()}>
              <Icon name="trash" /> {l.present ? `Delete ${size}${pg.needsStart ? "…" : ""}` : "Remove"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
