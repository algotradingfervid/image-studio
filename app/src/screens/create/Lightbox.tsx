import { useEffect, useState } from "react";
import * as api from "../../api";
import { fileSrc, type ImageRecord } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatDateTime, formatDuration } from "../../lib/format";
import { useToast } from "../../state/toast";

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onDeleted,
  onUseSettings,
  modelNames,
}: {
  items: ImageRecord[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDeleted: (id: string) => void;
  onUseSettings: (im: ImageRecord) => void;
  modelNames: Record<string, string>;
}) {
  const toast = useToast();
  const im = index != null ? items[index] : undefined;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setConfirming(false), [index]);

  const go = (d: number) => {
    if (index == null) return;
    const n = index + d;
    if (n >= 0 && n < items.length) onIndex(n);
  };

  const download = async () => {
    if (!im) return;
    try {
      const name = `image-studio-${im.model}-${im.seed}.png`;
      const dest = await api.pickSavePath(name);
      if (!dest) return;
      await api.exportImage({ id: im.id, destPath: dest });
      toast.success("Image saved", dest);
    } catch (e) {
      toast.error("Couldn't save the image", e);
    }
  };

  const copyPrompt = async () => {
    if (!im) return;
    try {
      await api.copyText(im.prompt);
      toast.success("Prompt copied");
    } catch (e) {
      toast.error("Couldn't copy to the clipboard", e);
    }
  };

  const del = async () => {
    if (!im) return;
    setBusy(true);
    try {
      await api.deleteImage(im.id);
      onDeleted(im.id);
      toast.info("Image deleted");
    } catch (e) {
      toast.error("Couldn't delete the image", e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={!!im} onClose={onClose} className="lightbox">
      {im && (
        <div
          className="lightbox__layout"
          onKeyDown={(e) => {
            const t = e.target as HTMLElement;
            if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
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
            <img src={fileSrc(im.path)} alt={im.prompt} style={{ aspectRatio: `${im.width} / ${im.height}` }} />
            <button type="button" className="lightbox__nav lightbox__nav--prev" aria-label="Previous image (←)" disabled={index === 0} onClick={() => go(-1)}>
              <Icon name="chevronLeft" size={20} />
            </button>
            <button
              type="button"
              className="lightbox__nav lightbox__nav--next"
              aria-label="Next image (→)"
              disabled={index === items.length - 1}
              onClick={() => go(1)}
            >
              <Icon name="chevronRight" size={20} />
            </button>
            <span className="lightbox__counter mono">
              {(index ?? 0) + 1} / {items.length}
            </span>
          </div>

          <aside className="lightbox__side" aria-label="Image settings">
            <header className="lightbox__head">
              <span className="eyebrow">{modelNames[im.model] ?? im.model}</span>
              <button type="button" className="icon-btn" aria-label="Close (Esc)" onClick={onClose} autoFocus>
                <Icon name="x" />
              </button>
            </header>
            <p className="lightbox__prompt">{im.prompt}</p>

            <dl className="specs">
              <div>
                <dt>Size</dt>
                <dd className="mono">
                  {im.initImage ? "start image" : im.aspectRatio} · {im.width}×{im.height}
                </dd>
              </div>
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
              {im.initImage && (
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
              <div className="btn-row">
                <button type="button" className="btn" onClick={download}>
                  <Icon name="download" /> Download
                </button>
                <button type="button" className="btn" onClick={copyPrompt}>
                  <Icon name="copy" /> Copy prompt
                </button>
              </div>
              {confirming ? (
                <div className="confirm" role="group" aria-label="Confirm delete">
                  <span>Delete this image permanently?</span>
                  <div className="btn-row">
                    <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
                      Keep
                    </button>
                    <button type="button" className="btn btn--danger btn--sm" onClick={del} disabled={busy}>
                      {busy ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn--ghost btn--danger-text" onClick={() => setConfirming(true)}>
                  <Icon name="trash" /> Delete
                </button>
              )}
            </div>
          </aside>
        </div>
      )}
    </Dialog>
  );
}
