import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import * as api from "../../api";
import { isJobActive, type GenerateInput, type ImageRecord, type Job } from "../../api";
import { Icon } from "../../components/Icon";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import type { Tab } from "../../App";
import {
  Advanced,
  advancedDefaults,
  AspectPicker,
  CountPicker,
  LoraPicker,
  MAX_LORAS,
  ModelPicker,
  References,
  type AdvancedValues,
  type LoraPick,
  type RefItem,
} from "./Controls";
import { Gallery } from "./Gallery";
import { JobCard, type JobView } from "./JobCard";
import { Lightbox } from "./Lightbox";

const PAGE = 24;
const LAST_MODEL_KEY = "imagestudio.lastModel";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic)$/i;

function readLastModel(): string {
  try {
    return localStorage.getItem(LAST_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function CreateScreen({ active, onNavigate }: { active: boolean; onNavigate: (t: Tab) => void }) {
  const lib = useLibrary();
  const toast = useToast();
  const configured = !!lib.settings?.hasApiKey && !!lib.settings?.endpointId;

  // ---------- form state ----------
  const [modelId, setModelId] = useState<string>(readLastModel);
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [refBusy, setRefBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [loraPicks, setLoraPicks] = useState<LoraPick[]>([]);
  const [aspect, setAspect] = useState("1:1");
  const [count, setCount] = useState(1);
  const [adv, setAdv] = useState<AdvancedValues>(() => advancedDefaults(undefined));
  const [advOpen, setAdvOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const model = lib.models.find((m) => m.id === modelId);
  const maxRefs = model?.maxReferences ?? 0;
  const modelNames = useMemo(() => Object.fromEntries(lib.models.map((m) => [m.id, m.name])), [lib.models]);

  // Pick an initial model once the registry arrives.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || lib.models.length === 0) return;
    initialised.current = true;
    const m = lib.models.find((x) => x.id === modelId) ?? lib.models.find((x) => x.installed) ?? lib.models[0];
    setModelId(m.id);
    setAdv(advancedDefaults(m));
  }, [lib.models, modelId]);

  useEffect(() => {
    try {
      if (modelId) localStorage.setItem(LAST_MODEL_KEY, modelId);
    } catch {
      /* ignore */
    }
  }, [modelId]);

  // Drop LoRAs that disappeared from the library (deleted in Models).
  useEffect(() => {
    setLoraPicks((ps) => {
      const keep = ps.filter((p) => lib.loras.some((l) => l.id === p.loraId && l.present));
      return keep.length === ps.length ? ps : keep;
    });
  }, [lib.loras]);

  const selectModel = (id: string) => {
    if (id === modelId) return;
    const next = lib.models.find((m) => m.id === id);
    if (!next) return;
    const droppedRefs = Math.max(0, refs.length - next.maxReferences);
    const keptLoras = loraPicks.filter((p) => lib.loras.find((l) => l.id === p.loraId)?.modelId === id);
    const droppedLoras = loraPicks.length - keptLoras.length;
    setModelId(id);
    setAdv(advancedDefaults(next));
    if (droppedRefs) setRefs((r) => r.slice(0, next.maxReferences));
    if (droppedLoras) setLoraPicks(keptLoras);
    if (droppedRefs || droppedLoras) {
      const parts = [droppedRefs && plural(droppedRefs, "reference"), droppedLoras && plural(droppedLoras, "LoRA")].filter(Boolean);
      toast.info(`Removed ${parts.join(" and ")}`, `${next.name} doesn't support ${droppedRefs && !next.maxReferences ? "reference images" : "them"}.`);
    }
  };

  // ---------- references ----------
  const addFiles = async (files: File[]) => {
    const slots = maxRefs - refs.length;
    if (slots <= 0) return toast.info(`${model?.name} takes at most ${maxRefs} references`);
    if (files.length > slots) toast.info(`Only ${plural(slots, "more reference")} allowed`, `${model?.name} takes at most ${maxRefs}.`);
    setRefBusy(true);
    try {
      for (const f of files.slice(0, slots)) {
        const b64 = await api.blobToBase64(f);
        const r = await api.importReferenceBytes(b64, f.type || "image/png");
        setRefs((rs) => [...rs, r]);
      }
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setRefBusy(false);
    }
  };

  const addPaths = async (paths: string[]) => {
    const imgs = paths.filter((p) => IMAGE_EXT.test(p));
    if (imgs.length < paths.length) toast.info("Some files were skipped", "Only image files can be references.");
    const slots = maxRefs - refs.length;
    if (!imgs.length) return;
    if (slots <= 0) return toast.info(`${model?.name} takes at most ${maxRefs} references`);
    if (imgs.length > slots) toast.info(`Only ${plural(slots, "more reference")} allowed`, `${model?.name} takes at most ${maxRefs}.`);
    setRefBusy(true);
    try {
      for (const p of imgs.slice(0, slots)) {
        const r = await api.importReference(p);
        setRefs((rs) => [...rs, r]);
      }
    } catch (e) {
      toast.error("Couldn't add the reference image", e);
    } finally {
      setRefBusy(false);
    }
  };

  const pickRefs = async () => {
    try {
      const paths = await api.pickImagePaths();
      if (paths === null) fileInput.current?.click();
      else if (paths.length) await addPaths(paths);
    } catch (e) {
      toast.error("Couldn't open the file picker", e);
    }
  };

  // Latest handlers for long-lived listeners.
  const handlers = useRef({ addFiles, addPaths });
  handlers.current = { addFiles, addPaths };
  const refsEnabled = active && maxRefs > 0;

  useEffect(() => {
    if (!refsEnabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
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
  }, [refsEnabled]);

  // ---------- prompt helpers ----------
  const insertWord = (w: string) => {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const pre = before && !/[\s,]$/.test(before) ? ", " : before && !/\s$/.test(before) ? " " : "";
    const post = after && !/^[\s,]/.test(after) ? ", " : "";
    const next = before + pre + w + post + after;
    setPrompt(next);
    const caret = (before + pre + w).length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  // ---------- jobs ----------
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingImages, setLoadingImages] = useState(false);
  const loadingRef = useRef(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  const imagesRef = useRef(images);
  imagesRef.current = images;

  const prependImages = useCallback((recs: ImageRecord[]) => {
    const fresh = recs.filter((r) => !imagesRef.current.some((p) => p.id === r.id));
    if (!fresh.length) return;
    imagesRef.current = [...fresh.reverse(), ...imagesRef.current];
    setImages(imagesRef.current);
    setLightbox((i) => (i == null ? i : i + fresh.length));
  }, []);

  useEffect(() => {
    const un = api.onEvent("job-update", (job: Job) => {
      setJobs((js) => {
        const ex = js.find((j) => j.jobId === job.jobId);
        if (!ex) return [...js, { ...job, modelName: "", prompt: "", startedAt: Date.now() }];
        return js.map((j) => (j.jobId === job.jobId ? { ...j, ...job } : j));
      });
      if (job.images.length) prependImages(job.images);
      if (job.status === "failed") toast.error("Generation failed", job.error ?? undefined);
    });
    return () => void un.then((f) => f());
  }, [prependImages, toast]);

  // Restore cards for jobs that were already running (e.g. after a reload).
  useEffect(() => {
    let alive = true;
    api
      .listJobs()
      .then((active) => {
        if (!alive || !active.length) return;
        setJobs((js) => {
          const known = new Set(js.map((j) => j.jobId));
          const restored = active
            .filter((j) => !known.has(j.jobId))
            .map((j) => ({ ...j, modelName: "Earlier job", prompt: "", startedAt: Date.now() }));
          return [...js, ...restored];
        });
      })
      .catch(() => {
        /* nothing to restore */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Fade out finished job cards (failed ones stay until dismissed).
  const scheduled = useRef(new Set<string>());
  useEffect(() => {
    for (const j of jobs) {
      if ((j.status === "completed" || j.status === "cancelled") && !scheduled.current.has(j.jobId)) {
        scheduled.current.add(j.jobId);
        window.setTimeout(() => setJobs((js) => js.filter((x) => x.jobId !== j.jobId)), j.status === "completed" ? 4000 : 2000);
      }
    }
  }, [jobs]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingImages(true);
    try {
      const page = await api.listImages({ limit: PAGE, before: nextBefore });
      setImages((prev) => [...prev, ...page.items.filter((r) => !prev.some((p) => p.id === r.id))]);
      setNextBefore(page.nextBefore);
      setHasMore(page.nextBefore != null && page.items.length > 0);
    } catch (e) {
      toast.error("Couldn't load the gallery", e);
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoadingImages(false);
    }
  }, [nextBefore, toast]);

  const firstLoad = useRef(false);
  useEffect(() => {
    if (firstLoad.current) return;
    firstLoad.current = true;
    void loadMore();
  }, [loadMore]);

  // ---------- generate ----------
  const blocker = !model
    ? "Choose a model"
    : !configured
      ? "Connect RunPod in Settings first"
      : !model.installed
        ? `${model.name} isn't installed`
        : !prompt.trim()
          ? "Write a prompt"
          : refBusy
            ? "Adding references…"
            : null;

  const doGenerate = async () => {
    if (submitting) return;
    if (blocker) {
      if (!prompt.trim()) promptRef.current?.focus();
      else toast.info(blocker);
      return;
    }
    if (!model) return;
    const input: GenerateInput = {
      model: model.id,
      prompt: prompt.trim(),
      aspectRatio: aspect,
      count,
      referenceIds: refs.slice(0, maxRefs).map((r) => r.refId),
      loras: loraPicks.slice(0, MAX_LORAS),
    };
    if (model.supportsNegativePrompt && adv.negativePrompt.trim()) input.negativePrompt = adv.negativePrompt.trim();
    if (!adv.randomSeed && adv.seed !== "") input.seed = Number(adv.seed);
    if (adv.steps !== "" && Number(adv.steps) > 0) input.steps = Math.round(Number(adv.steps));
    if (adv.cfg !== "" && !isNaN(Number(adv.cfg))) input.cfg = Number(adv.cfg);

    setSubmitting(true);
    try {
      const { jobId } = await api.generate(input);
      const meta = { modelName: model.name, prompt: input.prompt };
      setJobs((js) =>
        js.some((j) => j.jobId === jobId)
          ? js.map((j) => (j.jobId === jobId ? { ...j, ...meta } : j))
          : [...js, { jobId, status: "queued", total: count, completed: 0, progress: null, images: [], error: null, startedAt: Date.now(), ...meta }],
      );
    } catch (e) {
      toast.error("Couldn't start the generation", e);
    } finally {
      setSubmitting(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await api.cancelJob(jobId);
    } catch (e) {
      toast.error("Couldn't cancel", e);
    }
  };

  // ---------- restore ----------
  const applySettings = async (im: ImageRecord) => {
    const m = lib.models.find((x) => x.id === im.model);
    if (!m) return toast.error("That model is no longer available", im.model);
    setLightbox(null);
    setModelId(m.id);
    setPrompt(im.prompt);
    setAspect(im.aspectRatio);
    setAdv({
      seed: String(im.seed),
      randomSeed: false,
      steps: String(im.steps),
      cfg: String(im.cfg),
      negativePrompt: m.supportsNegativePrompt ? im.negativePrompt : "",
    });
    setAdvOpen(true);

    const missing: string[] = [];
    const picks: LoraPick[] = [];
    for (const l of im.loras.slice(0, MAX_LORAS)) {
      const found = lib.loras.find((x) => x.name === l.name && x.modelId === m.id && x.present);
      if (found) picks.push({ loraId: found.id, strength: l.strength });
      else missing.push(l.name);
    }
    setLoraPicks(picks);

    setRefs([]);
    let refFails = 0;
    if (m.maxReferences > 0 && im.references.length) {
      setRefBusy(true);
      const restored: RefItem[] = [];
      for (const p of im.references.slice(0, m.maxReferences)) {
        try {
          restored.push(await api.importReference(p));
        } catch {
          refFails++;
        }
      }
      setRefs(restored);
      setRefBusy(false);
    }
    const problems = [missing.length && `LoRA not in library: ${missing.join(", ")}`, refFails && plural(refFails, "reference") + " couldn't be restored"].filter(Boolean);
    if (problems.length) toast.info("Settings restored, with gaps", problems.join(". "));
    else toast.success("Settings restored", `${m.name} · seed ${im.seed}`);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const onDeleted = (id: string) => {
    const next = imagesRef.current.filter((x) => x.id !== id);
    imagesRef.current = next;
    setImages(next);
    setLightbox((i) => (i == null || next.length === 0 ? null : Math.min(i, next.length - 1)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doGenerate();
    }
  };

  const activeJobs = jobs.filter(isJobActive).length;

  return (
    <div className="create">
      <form
        className="panel"
        aria-label="Generation settings"
        onKeyDown={onKeyDown}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void doGenerate();
        }}
      >
        <div className="panel__scroll">
          <section className="section">
            <h2 className="section__title">Model</h2>
            {lib.models.length === 0 ? (
              <div className="skeleton skeleton--cards" aria-label="Loading models" />
            ) : (
              <ModelPicker models={lib.models} value={modelId} onChange={selectModel} />
            )}
            {model && !model.installed && (
              <div className="notice notice--inline">
                <Icon name="cube" />
                <span>
                  {model.task ? `${model.name} is downloading to your volume.` : `${model.name} isn't on your RunPod volume yet.`}
                </span>
                <button type="button" className="link-btn" onClick={() => onNavigate("models")}>
                  {model.task ? "View progress" : "Install in Models"} →
                </button>
              </div>
            )}
          </section>

          <section className="section">
            <div className="section__head">
              <label className="section__title" htmlFor="prompt">
                Prompt
              </label>
              <span className="hint">
                <kbd>⌘</kbd>
                <kbd>↵</kbd> to generate
              </span>
            </div>
            <textarea
              id="prompt"
              ref={promptRef}
              className="input textarea prompt"
              rows={5}
              placeholder="Describe the image — subject, setting, light, lens, mood…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck
            />
          </section>

          {maxRefs > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">References</h2>
                <span className="hint mono">
                  {refs.length}/{maxRefs}
                </span>
              </div>
              <References
                max={maxRefs}
                refs={refs}
                busy={refBusy}
                dragActive={dragActive}
                onRemove={(id) => setRefs((rs) => rs.filter((r) => r.refId !== id))}
                onFiles={addFiles}
                onPick={pickRefs}
              />
            </section>
          )}

          <section className="section">
            <h2 className="section__title">LoRAs</h2>
            <LoraPicker
              model={model}
              library={lib.loras}
              picks={loraPicks}
              onChange={setLoraPicks}
              onInsertWord={insertWord}
              onOpenLibrary={() => onNavigate("models")}
            />
          </section>

          <section className="section">
            <h2 className="section__title">Aspect ratio</h2>
            <AspectPicker value={aspect} onChange={setAspect} />
          </section>

          <section className="section section--row">
            <h2 className="section__title">Images</h2>
            <CountPicker value={count} onChange={setCount} />
          </section>

          <Advanced model={model} values={adv} onChange={setAdv} open={advOpen} onToggle={() => setAdvOpen((o) => !o)} />
        </div>

        <div className="panel__foot">
          <button type="submit" className="btn btn--generate" disabled={submitting || (!!blocker && blocker !== "Write a prompt")} aria-describedby="gen-hint">
            <Icon name="spark" size={18} />
            <span>{submitting ? "Queuing…" : count > 1 ? `Generate ${count}` : "Generate"}</span>
            <span className="kbd-group" aria-hidden>
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </span>
          </button>
          <p id="gen-hint" className="hint panel__hint">
            {blocker && blocker !== "Write a prompt" ? blocker : activeJobs ? `${plural(activeJobs, "job")} running` : "Each image is one RunPod job."}
          </p>
        </div>
      </form>

      <main className="canvas" ref={scrollRef} aria-label="Results">
        {jobs.length > 0 && (
          <div className="jobs" aria-label="Generations in progress">
            {jobs.map((j) => (
              <JobCard
                key={j.jobId}
                job={j}
                onCancel={() => cancelJob(j.jobId)}
                onDismiss={() => setJobs((js) => js.filter((x) => x.jobId !== j.jobId))}
                onOpenImage={(id) => {
                  const i = images.findIndex((x) => x.id === id);
                  if (i >= 0) setLightbox(i);
                }}
              />
            ))}
          </div>
        )}
        <div className="canvas__head">
          <h2 className="canvas__title">Gallery</h2>
          <span className="hint">{images.length ? `${images.length}${hasMore ? "+" : ""} images` : ""}</span>
        </div>
        <Gallery
          items={images}
          modelNames={modelNames}
          loading={loadingImages}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onOpen={setLightbox}
          scrollRoot={scrollRef}
        />
      </main>

      <Lightbox
        items={images}
        index={lightbox}
        onIndex={setLightbox}
        onClose={() => setLightbox(null)}
        onDeleted={onDeleted}
        onUseSettings={applySettings}
        modelNames={modelNames}
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
    </div>
  );
}
