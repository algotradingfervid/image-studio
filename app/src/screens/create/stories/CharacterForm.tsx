import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import * as api from "../../../api";
import type { Character, ImageRecord } from "../../../api";
import { Dialog } from "../../../components/Dialog";
import { Icon } from "../../../components/Icon";
import { radioKeys } from "../../../components/radio";
import { useLibrary } from "../../../state/library";
import { useToast } from "../../../state/toast";
import { References, realImageFiles, type RefItem } from "../Controls";
import { GalleryPicker } from "../GalleryPicker";

const MAX_REFS = 3;
const NAME_MAX = 40;
const DESC_MAX = 200;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;

type Source = Character["source"];
const SOURCES: { id: Source; label: string }[] = [
  { id: "generated", label: "AI-generated" },
  { id: "real_person", label: "Real person" },
];

/**
 * New character for the Stories cast (spec §3 step 1): name, one-line locked description, 1–3
 * reference images (general gallery only in v1), source, consent for a real person, adult tick.
 */
export function CharacterForm({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (c: Character) => void }) {
  const id = useId();
  const toast = useToast();
  const lib = useLibrary();
  const modelNames = useMemo(() => Object.fromEntries(lib.models.map((m) => [m.id, m.name])), [lib.models]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [source, setSource] = useState<Source>("generated");
  const [consent, setConsent] = useState(false);
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setRefs([]);
    setSource("generated");
    setConsent(false);
    setAdult(false);
    setError(null);
  }, [open]);

  const refsRef = useRef(refs);
  refsRef.current = refs;
  const slots = () => MAX_REFS - refsRef.current.length;

  const addWith = async (items: (() => Promise<RefItem>)[]) => {
    const n = slots();
    if (n <= 0) return toast.info(`A character takes at most ${MAX_REFS} reference images`);
    if (items.length > n) toast.info(`Only ${n} more image${n === 1 ? "" : "s"} allowed`, `A character takes at most ${MAX_REFS}.`);
    setBusy(true);
    try {
      for (const load of items.slice(0, n)) {
        const r = await load();
        setRefs((rs) => (rs.length < MAX_REFS ? [...rs, r] : rs));
      }
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setBusy(false);
    }
  };

  const addFiles = async (picked: File[]) => {
    const files = await realImageFiles(picked);
    if (!files.length) return toast.info("That file isn't an image", "Use a PNG, JPG or WebP.");
    await addWith(files.map((f) => async () => api.importReferenceBytes(await api.blobToBase64(f), f.type || "image/png", "general")));
  };

  const addPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (!imgs.length) return toast.info("That file isn't an image", "Use a PNG, JPG or WebP.");
    await addWith(imgs.map((p) => () => api.importReference(p, "general")));
  };

  const pick = async () => {
    try {
      const paths = await api.pickImagePaths();
      if (paths === null) fileInput.current?.click();
      else if (paths.length) await addPaths(paths);
    } catch (e) {
      toast.error("Couldn't open the file picker", e);
    }
  };

  const fromGallery = (rec: ImageRecord) => {
    setPickerOpen(false);
    // v1 stories live in the general gallery only (spec §3): vault images can't be character references.
    if (rec.vault) return toast.info("Vault images can't be character references yet", "Choose an image from the General gallery.");
    void addWith([() => api.importReference(rec.path, "general")]);
  };

  // Paste and native file drops go to this form while it is open (the Create panel's own listeners are off on this tab).
  const handlers = useRef({ addFiles, addPaths });
  handlers.current = { addFiles, addPaths };
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void handlers.current.addFiles(files);
    };
    document.addEventListener("paste", onPaste);
    let un: (() => void) | undefined;
    let dead = false;
    void api
      .onFileDrop((e) => {
        if (e.type === "enter") setDragActive(true);
        else if (e.type === "leave") setDragActive(false);
        else {
          setDragActive(false);
          void handlers.current.addPaths(e.paths);
        }
      })
      .then((f) => (dead ? f() : (un = f)));
    return () => {
      dead = true;
      document.removeEventListener("paste", onPaste);
      un?.();
    };
  }, [open]);

  const missing = [
    !name.trim() ? "a name" : "",
    !description.trim() ? "a description" : "",
    refs.length === 0 ? "at least one reference image" : "",
    source === "real_person" && !consent ? "the consent tick" : "",
    !adult ? "the adult (18+) tick" : "",
  ].filter(Boolean);
  const blocked = missing.length > 0 || busy || saving;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (blocked) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveCharacter({
        id: "",
        name: name.trim(),
        description: description.trim(),
        source,
        consent: source === "real_person" && consent,
        adult,
        refIds: refs.map((r) => r.refId),
        createdAt: "",
        updatedAt: "",
      });
      onSaved(saved);
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const descLeft = DESC_MAX - description.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New character"
      className="character-dialog"
      initialFocusRef={nameRef}
      footer={
        <>
          {missing.length > 0 && (
            <p id={`${id}-why`} className="hint character-dialog__why">
              Needs {missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0]}.
            </p>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={`${id}-form`}
            className="btn btn--primary"
            disabled={blocked}
            aria-describedby={missing.length ? `${id}-why` : undefined}
          >
            <Icon name={saving ? "refresh" : "check"} className={saving ? "spin" : undefined} /> {saving ? "Saving…" : "Save character"}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="character-form" onSubmit={(e) => void save(e)} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input
            ref={nameRef}
            id={`${id}-name`}
            className="input"
            value={name}
            maxLength={NAME_MAX}
            placeholder="e.g. Mara"
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <div className="field__label-row">
            <label className="field__label" htmlFor={`${id}-desc`}>
              Description <span className="section__aside">— one line, used in every shot</span>
            </label>
            <span className={`hint mono ${descLeft < 20 ? "field-warn" : ""}`} aria-live="polite">
              {description.length}/{DESC_MAX}
            </span>
          </div>
          <input
            id={`${id}-desc`}
            className="input"
            value={description}
            maxLength={DESC_MAX}
            placeholder="woman in her 30s, short black hair, green bomber jacket"
            autoComplete="off"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="field">
          <div className="field__label-row">
            <span className="field__label" id={`${id}-refs`}>
              Reference images <span className="section__aside">(1–{MAX_REFS}) — the face and outfit to keep</span>
            </span>
            <span className="hint mono">
              {refs.length}/{MAX_REFS}
            </span>
          </div>
          <div role="group" aria-labelledby={`${id}-refs`}>
            <References
              max={MAX_REFS}
              refs={refs}
              busy={busy}
              dragActive={dragActive}
              onRemove={(rid) => setRefs((rs) => rs.filter((r) => r.refId !== rid))}
              onFiles={(f) => void addFiles(f)}
              onPick={() => void pick()}
              onPickGallery={() => setPickerOpen(true)}
            />
          </div>
        </div>

        <div className="field">
          <span className="field__label" id={`${id}-source`}>
            Source
          </span>
          <div
            className="segmented segmented--wide character-form__source"
            role="radiogroup"
            aria-labelledby={`${id}-source`}
            onKeyDown={radioKeys(
              SOURCES.map((s) => s.id),
              source,
              setSource,
            )}
          >
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={s.id === source}
                tabIndex={s.id === source ? 0 : -1}
                className={s.id === source ? "is-selected" : ""}
                onClick={() => setSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="character-form__ticks">
          {source === "real_person" && (
            <label className="story-check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I have this person's consent to use their likeness</span>
            </label>
          )}
          <label className="story-check">
            <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} required />
            <span>This character is an adult (18+)</span>
          </label>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>

      <GalleryPicker
        open={pickerOpen}
        title="Choose a reference image"
        purpose="reference"
        modelNames={modelNames}
        returnFocusRef={nameRef}
        onClose={() => setPickerOpen(false)}
        onPick={fromGallery}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addFiles(files);
        }}
      />
    </Dialog>
  );
}
