import { useEffect, useRef, useState } from "react";
import * as api from "../../api";
import { fileSrc, type ImageRecord } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatDateTime, formatDuration } from "../../lib/format";
import { useToast } from "../../state/toast";
import { showVaultTab, useVault } from "../../state/vault";
import { countGallery, formatClipLength, galleryPager, markSeen, PREVIEW_UNAVAILABLE, totalFor, unplayable, type GalleryTotals } from "./Gallery";

/** Clicks on a just-shown confirm button are ignored for this long (UX-006: no double-click confirms). */
const ARM_MS = 400;

/** The stored file's extension (png/jpg/webp/mp4), for the download name. */
function extOf(path: string, video: boolean): string {
  if (video) return "mp4";
  const m = path.match(/\.(png|jpe?g|webp|mp4)(?:$|[?#])/i);
  if (!m) return "png";
  const e = m[1].toLowerCase();
  return e === "jpeg" ? "jpg" : e;
}

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onDeleted,
  onMovedToVault,
  onMovedToGeneral,
  vaultExists = false,
  vaultUnlocked = false,
  onUseSettings,
  onMakeVideo,
  onRedraw,
  onUseAsReference,
  modelNames,
}: {
  items: ImageRecord[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
  /** A General item was moved into the vault (spec v6). */
  onMovedToVault?: (id: string) => void;
  /** A vault item was moved to General; gets the new General record. */
  onMovedToGeneral?: (rec: ImageRecord) => void;
  /** Offer "Move to vault" on General items. */
  vaultExists?: boolean;
  /** Moving in needs the unlocked vault (the encrypted copy is verified by decrypting it). */
  vaultUnlocked?: boolean;
  onUseSettings: (im: ImageRecord) => void;
  /** Image records: open Create in Video mode with this image as the start frame. */
  onMakeVideo?: (im: ImageRecord) => void;
  /** Image records: open Create in Image mode with this image as the start image (img2img, UX-037). */
  onRedraw?: (im: ImageRecord) => void;
  /** Image records: add this image as a reference on the Create panel (UX-036). */
  onUseAsReference?: (im: ImageRecord) => void;
  modelNames: Record<string, string>;
}) {
  const toast = useToast();
  const vault = useVault();
  const im = index != null ? items[index] : undefined;
  type Panel = "delete" | "general" | "export";
  /** Which inline confirmation is open: delete, move to General, or export (vault). */
  const [confirming, setConfirmingState] = useState<Panel | null>(null);
  /** The confirm buttons ignore clicks until this time (UX-006). */
  const [armedAt, setArmedAt] = useState(0);
  const [armed, setArmed] = useState(true);
  const triggers = useRef<Partial<Record<Panel, HTMLButtonElement | null>>>({});
  const setConfirming = (v: boolean | Panel) => {
    const next: Panel | null = v === true ? "delete" : v === false ? null : v;
    setConfirmingState((cur) => {
      // Closing a panel puts focus back on its trigger, so arrow keys and Esc keep working (UX-059).
      if (cur && !next) requestAnimationFrame(() => triggers.current[cur]?.focus());
      return next;
    });
    if (next) {
      setArmedAt(Date.now() + ARM_MS);
      setArmed(false);
    }
  };
  useEffect(() => {
    if (armed) return;
    const h = window.setTimeout(() => setArmed(true), Math.max(0, armedAt - Date.now()));
    return () => window.clearTimeout(h);
  }, [armed, armedAt]);
  /** Wraps a confirm button's action: ignored while the panel is still arming. */
  const guard = (fn: () => void) => () => {
    if (Date.now() < armedAt) return;
    fn();
  };
  const [busy, setBusy] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  /** Inline "done" state on Download / Copy prompt (UX-008). */
  const [flash, setFlash] = useState<"download" | "copy" | "copyFailed" | null>(null);
  const flashTimer = useRef(0);
  const showFlash = (f: typeof flash, ms = 2000) => {
    setFlash(f);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), ms);
  };
  /** The video's start image shown large in the stage (UX-083) when it isn't in this list. */
  const [startPreview, setStartPreview] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const video = im?.kind === "video";
  const inVault = !!im?.vault;
  const noun = video ? "video" : "image";
  const Noun = video ? "Video" : "Image";

  useEffect(() => {
    setConfirmingState(null);
    setVideoFailed(false);
    setStartPreview(false);
    setFlash(null);
    if (im) markSeen(im.id);
  }, [index, im?.id]);

  // Real total for the counter (UX-019): the General list is paged, so read it through once per opening.
  const open = !!im;
  const [totals, setTotals] = useState<GalleryTotals | null>(null);
  useEffect(() => {
    if (!open || inVault) return;
    let alive = true;
    setTotals(null);
    countGallery()
      .then((t) => alive && setTotals(t))
      .catch(() => {
        /* the counter falls back to "n / 24+" */
      });
    return () => {
      alive = false;
    };
  }, [open, inVault]);

  // Reaching the last loaded items loads the next page, so Next keeps going (UX-049).
  const pendingNext = useRef(false);
  const atEnd = index != null && index >= items.length - 1;
  useEffect(() => {
    if (index == null || inVault) return;
    if (index >= items.length - 3 && galleryPager.hasMore && !galleryPager.loading) galleryPager.loadMore();
  }, [index, items.length, inVault]);
  useEffect(() => {
    if (pendingNext.current && index != null && index < items.length - 1) {
      pendingNext.current = false;
      onIndex(index + 1);
    }
  }, [items.length, index, onIndex]);
  const canNext = !atEnd || (!inVault && galleryPager.hasMore);

  const go = (d: number) => {
    if (index == null) return;
    const n = index + d;
    if (n >= 0 && n < items.length) onIndex(n);
    else if (d > 0 && n >= items.length && !inVault && galleryPager.hasMore) {
      pendingNext.current = true;
      if (!galleryPager.loading) galleryPager.loadMore();
    }
  };

  const total = !inVault && totals ? Math.max(items.length, totalFor(totals, galleryPager.filter)) : null;
  const counter = `${(index ?? 0) + 1} / ${total ?? `${items.length}${!inVault && galleryPager.hasMore ? "+" : ""}`}`;

  /** The start image of this item, when it's in the list (opens it in place). */
  const startIndex = im?.initImage ? items.findIndex((x) => x.id !== im.id && (x.path === im.initImage || x.thumbPath === im.initImage)) : -1;
  const startRec = startIndex >= 0 ? items[startIndex] : undefined;

  const download = async () => {
    if (!im) return;
    try {
      const name = `image-studio-${im.model}-${im.seed}.${extOf(im.path, video)}`;
      const dest = await api.pickSavePath(name);
      if (!dest) return;
      if (inVault) {
        await api.exportVaultItem({ id: im.id, dest });
        setConfirming(false);
        showFlash("download");
        toast.success(`${Noun} exported — not encrypted`, dest);
      } else {
        await api.exportImage({ id: im.id, destPath: dest });
        showFlash("download");
        toast.success(`${Noun} saved`, dest);
      }
    } catch (e) {
      toast.error(`Couldn't save the ${noun}`, e);
    }
  };

  /** Undo of a move: move it back, then reload both lists (UX-020). */
  const moveBack = async (id: string, to: "vault" | "general", n: string) => {
    try {
      if (to === "vault") await api.moveToVault(id);
      else await api.moveToGeneral(id);
      vault.bumpGeneral();
      void vault.reloadItems();
      toast.success(to === "vault" ? `${n} moved back to the vault` : `${n} moved back to General`);
    } catch (e) {
      toast.error(`Couldn't move the ${n.toLowerCase()} back`, e);
    }
  };

  const moveToVault = async () => {
    if (!im) return;
    const id = im.id;
    setBusy(true);
    try {
      await api.moveToVault(id);
      // Close instead of silently showing the next item under the same button (UX-020).
      onClose();
      onMovedToVault?.(id);
      toast.notify({
        kind: "success",
        title: `${Noun} moved to the vault`,
        message: "Encrypted and verified; the unencrypted file was deleted.",
        actions: [
          { label: "Undo", onClick: () => void moveBack(id, "general", Noun) },
          { label: "View in vault", onClick: () => void showVaultTab() },
        ],
      });
    } catch (e) {
      toast.error(`Couldn't move the ${noun} to the vault`, e);
    } finally {
      setBusy(false);
    }
  };

  const moveToGeneral = async () => {
    if (!im) return;
    setBusy(true);
    try {
      const rec = await api.moveToGeneral(im.id);
      onClose();
      onMovedToGeneral?.(rec);
      toast.notify({
        kind: "success",
        title: `${Noun} moved to General`,
        message: "It's no longer encrypted.",
        actions: [{ label: "Undo", onClick: () => void moveBack(rec.id, "vault", Noun) }],
      });
    } catch (e) {
      toast.error(`Couldn't move the ${noun} to General`, e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const copyPrompt = async () => {
    if (!im) return;
    try {
      await api.copyText(im.prompt);
      showFlash("copy");
      toast.success("Prompt copied");
    } catch (e) {
      // Friendly text instead of the raw clipboard exception; the prompt is selected for ⌘C.
      console.warn("Copy prompt failed", e);
      const el = promptRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      showFlash("copyFailed", 4000);
      toast.notify({ kind: "error", title: "Couldn't copy the prompt", message: "The prompt text is selected — press ⌘C to copy it." });
    }
  };

  const del = async () => {
    if (!im) return;
    setBusy(true);
    try {
      const id = im.id;
      if (inVault) await api.deleteVaultItem(id);
      else await api.deleteImage(id);
      // Close instead of silently showing the next item (UX-020); deleting can't be undone.
      onClose();
      onDeleted(id);
      toast.notify({ kind: "info", title: inVault ? `${Noun} deleted from the vault` : `${Noun} deleted`, message: "It can't be recovered." });
    } catch (e) {
      toast.error(`Couldn't delete the ${noun}`, e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog
      open={!!im}
      onClose={() => {
        // Esc closes an open inline panel first; a second Esc closes the lightbox (UX-059).
        if (confirming) setConfirming(false);
        else if (startPreview) setStartPreview(false);
        else onClose();
      }}
      className="lightbox"
    >
      {im && (
        <div
          className="lightbox__layout"
          onKeyDown={(e) => {
            // Esc closes an open inline panel first (handled here too: the browser may skip the
            // dialog's cancel event after repeated Esc presses and close the whole lightbox).
            if (e.key === "Escape" && (confirming || startPreview)) {
              e.preventDefault();
              e.stopPropagation();
              if (confirming) setConfirming(false);
              else setStartPreview(false);
              return;
            }
            const t = e.target as HTMLElement;
            if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "VIDEO") return;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              go(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              go(1);
            }
          }}
        >
          <div className="lightbox__stage">
            {video ? (
              videoFailed || unplayable(im.path) ? (
                <figure className="lightbox__poster">
                  {im.posterPath && <img src={fileSrc(im.posterPath)} alt={im.prompt} style={{ aspectRatio: `${im.width} / ${im.height}` }} />}
                  <figcaption className="lightbox__unavailable">
                    <Icon name="video" /> {PREVIEW_UNAVAILABLE}
                  </figcaption>
                </figure>
              ) : (
                <video
                  key={im.id}
                  className="lightbox__video"
                  src={fileSrc(im.path)}
                  poster={im.posterPath ? fileSrc(im.posterPath) : undefined}
                  controls
                  autoPlay
                  playsInline
                  style={{ aspectRatio: `${im.width} / ${im.height}` }}
                  aria-label={`Video: ${im.prompt}`}
                  onError={() => setVideoFailed(true)}
                />
              )
            ) : (
              <img src={fileSrc(im.path)} alt={im.prompt} style={{ aspectRatio: `${im.width} / ${im.height}` }} />
            )}
            {startPreview && im.initImage && (
              <figure className="lightbox__start-preview">
                <img src={fileSrc(im.initImage)} alt="Start image" />
                <figcaption>
                  Start image{" "}
                  <button type="button" className="btn btn--sm" onClick={() => setStartPreview(false)} autoFocus>
                    Back to the {noun}
                  </button>
                </figcaption>
              </figure>
            )}
            <button type="button" className="lightbox__nav lightbox__nav--prev" aria-label={`Previous ${noun} (←)`} disabled={index === 0} onClick={() => go(-1)}>
              <Icon name="chevronLeft" size={20} />
            </button>
            <button
              type="button"
              className="lightbox__nav lightbox__nav--next"
              aria-label={`Next ${noun} (→)`}
              disabled={!canNext}
              onClick={() => go(1)}
            >
              <Icon name="chevronRight" size={20} />
            </button>
            <span className="lightbox__counter mono">{counter}</span>
          </div>

          <aside className="lightbox__side" aria-label={`${Noun} settings`}>
            <header className="lightbox__head">
              <span className="eyebrow">
                {inVault && (
                  <span className="badge badge--vault">
                    <Icon name="lock" size={11} /> Vault
                  </span>
                )}
                {modelNames[im.model] ?? im.model}
              </span>
              <button type="button" className="icon-btn" aria-label="Close (Esc)" onClick={onClose} autoFocus>
                <Icon name="x" />
              </button>
            </header>
            <p className="lightbox__prompt lightbox__prompt--select" ref={promptRef}>
              {im.prompt}
            </p>

            <dl className="specs">
              {video ? (
                <>
                  <div>
                    <dt>Duration</dt>
                    <dd className="mono">{formatClipLength(im.durationS) || "—"}</dd>
                  </div>
                  <div>
                    <dt>Frame rate</dt>
                    <dd className="mono">{im.fps ? `${im.fps} fps` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Resolution</dt>
                    <dd className="mono">{im.width && im.height ? `${im.width}×${im.height}` : im.aspectRatio}</dd>
                  </div>
                  <div>
                    <dt>Audio</dt>
                    <dd>{im.hasAudio ? "Yes" : "No"}</dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt>Size</dt>
                  <dd className="mono">
                    {im.initImage ? "start image" : im.aspectRatio} · {im.width}×{im.height}
                  </dd>
                </div>
              )}
              <div>
                <dt>Seed</dt>
                <dd className="mono">{im.seed}</dd>
              </div>
              <div>
                <dt>Steps</dt>
                <dd className="mono">{im.steps}</dd>
              </div>
              <div>
                <dt>CFG</dt>
                <dd className="mono">{im.cfg}</dd>
              </div>
              {im.negativePrompt && (
                <div className="specs__wide">
                  <dt>Negative</dt>
                  <dd>{im.negativePrompt}</dd>
                </div>
              )}
              {im.loras.length > 0 && (
                <div className="specs__wide">
                  <dt>LoRAs</dt>
                  <dd>
                    <ul className="plain">
                      {im.loras.map((l) => (
                        <li key={l.name}>
                          {l.name} <span className="mono hint">× {l.strength.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {im.initImage && video && (
                <div className="specs__wide">
                  <dt>Start image</dt>
                  <dd className="start-spec">
                    <button
                      type="button"
                      className="start-spec__open"
                      aria-label="Open start image"
                      title="Open start image"
                      onClick={() => (startRec ? onIndex(startIndex) : setStartPreview(true))}
                    >
                      <img src={fileSrc(im.initImage)} alt="" />
                    </button>
                    <span>
                      <span className="start-spec__label">Image → video</span>
                      <span className="start-spec__from">{startRec ? `From: ${startRec.prompt}` : "Uploaded file"}</span>
                    </span>
                  </dd>
                </div>
              )}
              {im.initImage && !video && (
                <div className="specs__wide">
                  <dt>Start image</dt>
                  <dd className="start-spec">
                    <img src={fileSrc(im.initImage)} alt="Start image" />
                    <span>
                      <span className="start-spec__label">How much to change</span>
                      <span className="mono start-spec__value">{im.denoise != null ? im.denoise.toFixed(2) : "—"}</span>
                    </span>
                  </dd>
                </div>
              )}
              {im.references.length > 0 && (
                <div className="specs__wide">
                  <dt>References</dt>
                  <dd className="ref-strip">
                    {im.references.map((r, i) => (
                      <img key={i} src={fileSrc(r)} alt={`Reference ${i + 1}`} />
                    ))}
                  </dd>
                </div>
              )}
            </dl>

            <dl className="specs specs--timing">
              <div>
                <dt>Total</dt>
                <dd className="mono">{formatDuration(im.durationMs)}</dd>
              </div>
              <div>
                <dt title="Time in RunPod's queue, including GPU cold start">Queue / cold start</dt>
                <dd className="mono">{formatDuration(im.runpod.delayMs)}</dd>
              </div>
              <div>
                <dt>GPU execution</dt>
                <dd className="mono">{formatDuration(im.runpod.executionMs)}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(im.createdAt)}</dd>
              </div>
            </dl>

            <div className="lightbox__actions">
              <button type="button" className="btn btn--primary" onClick={() => onUseSettings(im)}>
                <Icon name="restore" /> Use these settings
              </button>
              {confirming === "export" && (
                <div className="confirm confirm--note confirm--above" role="group" aria-label="Export from the vault">
                  <span>
                    <Icon name="alert" size={13} /> The exported copy is <strong>not encrypted</strong> — anyone with access to where you save it can open it.
                  </span>
                  <div className="btn-row">
                    <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
                      Cancel
                    </button>
                    <button type="button" className="btn btn--warn-outline btn--sm" onClick={guard(download)} aria-disabled={!armed || undefined}>
                      <Icon name="download" size={13} /> Choose where to save…
                    </button>
                  </div>
                </div>
              )}
              <div className="btn-row">
                {inVault ? (
                  <button
                    type="button"
                    className="btn"
                    ref={(el) => void (triggers.current.export = el)}
                    onClick={() => setConfirming(confirming === "export" ? false : "export")}
                    aria-expanded={confirming === "export"}
                  >
                    <Icon name={flash === "download" ? "check" : "download"} /> {flash === "download" ? "Exported" : "Export…"}
                  </button>
                ) : (
                  <button type="button" className={`btn ${flash === "download" ? "btn--done" : ""}`} onClick={download}>
                    <Icon name={flash === "download" ? "check" : "download"} /> {flash === "download" ? "Saved" : video ? "Download .mp4" : "Download"}
                  </button>
                )}
                <button type="button" className={`btn ${flash === "copy" ? "btn--done" : ""}`} onClick={copyPrompt}>
                  <Icon name={flash === "copy" ? "check" : "copy"} /> {flash === "copy" ? "Copied" : flash === "copyFailed" ? "Press ⌘C" : "Copy prompt"}
                </button>
              </div>
              {!video && onRedraw && (
                <button type="button" className="btn" onClick={() => onRedraw(im)}>
                  <Icon name="wand" /> Redraw this image
                </button>
              )}
              {!video && onUseAsReference && (
                <button type="button" className="btn" onClick={() => onUseAsReference(im)}>
                  <Icon name="layers" /> Use as reference
                </button>
              )}
              {!video && onMakeVideo && (
                <button type="button" className="btn" onClick={() => onMakeVideo(im)}>
                  <Icon name="video" /> Make video
                </button>
              )}
              {!inVault && vaultExists && (
                <button
                  type="button"
                  className="btn"
                  onClick={moveToVault}
                  disabled={busy || !vaultUnlocked}
                  aria-describedby={vaultUnlocked ? undefined : "lightbox-move-note"}
                >
                  <Icon name={busy ? "refresh" : "lock"} className={busy ? "spin" : ""} /> {busy ? "Moving…" : "Move to vault"}
                </button>
              )}
              {!inVault && vaultExists && !vaultUnlocked && (
                <p id="lightbox-move-note" className="hint lightbox__note">
                  <Icon name="info" size={12} /> Unlock the vault to move items.
                </p>
              )}
              {inVault && confirming === "general" && (
                <div className="confirm confirm--note confirm--above" role="group" aria-label="Confirm move to General">
                  <span>Move this {noun} out of the vault? It's decrypted and saved unencrypted in General, visible without a password.</span>
                  <div className="btn-row">
                    <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
                      Keep in vault
                    </button>
                    <button type="button" className="btn btn--warn-outline btn--sm" onClick={guard(moveToGeneral)} disabled={busy} aria-disabled={!armed || undefined}>
                      {busy ? "Moving…" : "Move to General"}
                    </button>
                  </div>
                </div>
              )}
              {inVault && (
                <button
                  type="button"
                  className="btn"
                  ref={(el) => void (triggers.current.general = el)}
                  onClick={() => setConfirming(confirming === "general" ? false : "general")}
                  aria-expanded={confirming === "general"}
                >
                  <Icon name="lockOpen" /> Move to General
                </button>
              )}
              {confirming === "delete" && (
                <div className="confirm confirm--above" role="group" aria-label="Confirm delete">
                  <span>{inVault ? `Delete this ${noun} from the vault? It can't be recovered.` : `Delete this ${noun} permanently? It can't be recovered.`}</span>
                  <div className="btn-row">
                    <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
                      {inVault ? "Keep in vault" : "Keep"}
                    </button>
                    <button type="button" className="btn btn--danger btn--sm" onClick={guard(del)} disabled={busy} aria-disabled={!armed || undefined}>
                      {busy ? "Deleting…" : `Delete ${noun}`}
                    </button>
                  </div>
                </div>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--danger-text"
                ref={(el) => void (triggers.current.delete = el)}
                onClick={() => setConfirming(confirming === "delete" ? false : "delete")}
                aria-expanded={confirming === "delete"}
              >
                <Icon name="trash" /> Delete
              </button>
            </div>
          </aside>
        </div>
      )}
    </Dialog>
  );
}
