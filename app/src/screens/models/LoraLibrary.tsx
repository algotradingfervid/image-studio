import { useState, type FormEvent } from "react";
import * as api from "../../api";
import { isTaskActive, type Lora, type ResolvedLora } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatBytes, pct } from "../../lib/format";
import { useGpu } from "../../state/gpu";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";

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
    if (!preview || !modelId || !name.trim()) return;
    if (!(await gpu.confirmStart(`download ${name.trim()}`))) return;
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

  const addWord = () => {
    const w = wordDraft.trim().replace(/,$/, "");
    if (w && !words.includes(w)) setWords([...words, w]);
    setWordDraft("");
  };

  const modelName = (id: string) => lib.models.find((m) => m.id === id)?.name ?? id;
  const baseMismatch = preview?.data.baseModel && !preview.data.suggestedModelId;

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
                <label className="field__label" htmlFor="lora-name">
                  Name
                </label>
                <input id="lora-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="lora-model">
                  Use with model
                </label>
                <select id="lora-model" className="input select" value={modelId} onChange={(e) => setModelId(e.target.value)} required>
                  <option value="" disabled>
                    Choose a model…
                  </option>
                  {lib.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
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
                  onBlur={addWord}
                />
              </div>
            </div>
            <div className="btn-row btn-row--end">
              <button type="button" className="btn btn--ghost" onClick={() => setPreview(null)}>
                Discard
              </button>
              <button type="button" className="btn btn--primary" onClick={add} disabled={adding || !modelId || !name.trim()}>
                <Icon name="plus" /> {adding ? "Adding…" : "Add to library"}
              </button>
            </div>
          </div>
        </div>
      )}

      {lib.loras.length === 0 ? (
        <p className="empty-line">No LoRAs yet.</p>
      ) : (
        <ul className="lora-list" aria-label="Your LoRAs">
          {lib.loras.map((l) => (
            <LoraRow key={l.id} lora={l} modelName={modelName(l.modelId)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoraRow({ lora: l, modelName }: { lora: Lora; modelName: string }) {
  const lib = useLibrary();
  const gpu = useGpu();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const task = isTaskActive(l.task) ? l.task : null;

  const del = async () => {
    if (!(await gpu.confirmStart(`delete ${l.name}`))) {
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
          <span className={`badge ${l.present ? "badge--ok" : "badge--warn"}`}>{l.present ? "Ready" : "Missing"}</span>
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
          <button type="button" className="icon-btn" aria-label={`Delete ${l.name}`} onClick={() => setConfirming(true)}>
            <Icon name="trash" />
          </button>
        )}
      </div>
    </li>
  );
}
