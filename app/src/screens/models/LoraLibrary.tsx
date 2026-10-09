import { useState, type FormEvent } from "react";
import * as api from "../../api";
import { isTaskActive, type Lora, type ResolvedLora } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
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

  const resolve = async (e: FormEvent) => {
    e.preventDefault();
    const link = url.trim();
    if (!link) return;
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
  // The same file for the same model is refused by the core (it would share one file on the volume).
  const duplicate = preview ? lib.loras.find((l) => l.modelId === modelId && l.filename === preview.data.filename) : undefined;
  const sameSource = preview ? lib.loras.find((l) => l.sourceUrl.trim() === preview.link && l.modelId !== modelId) : undefined;
  const addLabel = adding ? "Adding…" : wrongBase ? "Add anyway" : gpu.profiles.image.needsStart ? "Add & download (starts GPU)" : "Add to library";
  const addBlocked = !modelId ? "Choose which model this LoRA is for." : !name.trim() ? "Give it a name." : nameTooLong ? `Keep the name to ${NAME_MAX} characters.` : duplicate ? "Already in your library for this model." : null;

  return (
    <section className="card loras" aria-labelledby="lora-title">
      <h2 id="lora-title" className="card__title">
        <Icon name="layers" /> LoRA library
      </h2>
      <p className="hint">Paste a Hugging Face file link (…/blob/main/x.safetensors) or a Civitai model page.</p>

      <form className="link-form" onSubmit={resolve}>
        <label className="visually-hidden" htmlFor="lora-url">
          LoRA link
        </label>
        <div className="input-icon">
          <Icon name="link" />
          <input
            id="lora-url"
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
              <Icon name="refresh" className="spin" /> Resolving…
            </>
          ) : (
            "Resolve"
          )}
        </button>
      </form>
      {resolveError && (
        <p className="notice notice--error" role="alert">
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
            {duplicate && (
              <p className="notice notice--warn" role="alert">
                <Icon name="alert" /> Already in your library as “{duplicate.name}” ({modelName(duplicate.modelId)}) — the same file.
              </p>
            )}
            {!duplicate && sameSource && (
              <p className="hint">
                <Icon name="info" size={12} /> This link is already in your library as “{sameSource.name}” for {modelName(sameSource.modelId)}.
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
              <button type="button" className="btn btn--ghost" onClick={() => setPreview(null)}>
                Discard
              </button>
              <button type="button" className="btn btn--primary" onClick={add} disabled={adding || !!addBlocked} aria-describedby="lora-add-why">
                <Icon name="plus" /> {addLabel}
              </button>
            </div>
            {addBlocked && (
              <p id="lora-add-why" className="hint btn-row--end-hint">
                {addBlocked}
              </p>
            )}
          </div>
        </div>
      )}

      {lib.loras.length === 0 ? (
        <p className="empty-line">No LoRAs yet.</p>
      ) : (
        <ul className="lora-list" aria-label="Your LoRAs">
          {lib.loras.map((l) => (
            <LoraRow key={l.id} lora={l} modelName={modelName(l.modelId)} baseInstalled={lib.models.find((m) => m.id === l.modelId)?.installed ?? false} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoraRow({ lora: l, modelName, baseInstalled }: { lora: Lora; modelName: string; baseInstalled: boolean }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const task = isTaskActive(l.task) ? l.task : null;

  const del = async () => {
    if (!(await gpu.confirmStart(`delete ${l.name}`, "image", { confirmLabel: "Start GPU & delete" }))) {
      setConfirming(false);
      return;
    }
    setBusy(true);
    try {
      const task = await api.deleteLora(l.id);
      if (task) {
        lib.applyTask(task); // completion toast + reload come from task-update
      } else {
        toast.info(`Deleted ${l.name}`);
        await lib.reloadLoras();
      }
    } catch (e) {
      toast.error(`Couldn't delete ${l.name}`, e);
      setBusy(false);
      setConfirming(false);
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

  return (
    <li className="lora-row">
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
          <span className="mono hint">{formatBytes(l.sizeBytes)}</span>
          {l.triggerWords.length > 0 && <span className="hint">· {l.triggerWords.join(", ")}</span>}
        </div>
        {task && (
          <div className="task-progress task-progress--compact">
            <ProgressBar label={`${l.name} download`} value={pct(task.bytes, task.totalBytes)} indeterminate={task.status === "queued"} />
            <span className="mono hint">{task.status === "queued" ? "Queued" : `${Math.round(pct(task.bytes, task.totalBytes))}%`}</span>
          </div>
        )}
      </div>
      <div className="lora-row__side">
        {task ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={cancel}>
            <Icon name="stop" /> Cancel
          </button>
        ) : (
          <span
            className={`badge ${l.present && baseInstalled ? "badge--ok" : "badge--warn"}`}
            title={l.present && !baseInstalled ? `${modelName} isn't installed — download it on this screen to use this LoRA.` : undefined}
          >
            {!l.present ? "Missing" : baseInstalled ? "Ready" : `Needs ${modelName}`}
          </span>
        )}
        {confirming ? (
          <span className="confirm confirm--inline" role="group" aria-label={`Confirm delete ${l.name}`}>
            <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
              Keep
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={del} disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn--ghost btn--sm btn--danger-text" aria-label={`Delete ${l.name}`} onClick={() => setConfirming(true)}>
            <Icon name="trash" /> Delete
          </button>
        )}
      </div>
    </li>
  );
}
