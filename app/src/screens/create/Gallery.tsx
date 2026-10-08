import { useEffect, useRef, useState } from "react";
import { fileSrc, inTauri, type ImageRecord } from "../../api";
import { Icon } from "../../components/Icon";
import { formatRelative } from "../../lib/format";

/** "5 s", "1:05". */
export function formatClipLength(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "";
  const v = Math.round(s);
  return v < 60 ? `${v} s` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

/** Shown on a video's poster when the .mp4 can't be played. */
export const PREVIEW_UNAVAILABLE = inTauri ? "Preview unavailable" : "Preview unavailable in mock";

/** The dev mock can't make real MP4s: its records point at `mock-video://…`, which browsers never finish loading. */
export const unplayable = (path: string | null | undefined) => !path || path.startsWith("mock-video:");

export function Gallery({
  items,
  filter = "all",
  loadedCount,
  modelNames,
  loading,
  hasMore,
  onLoadMore,
  onOpen,
  scrollRoot,
}: {
  items: ImageRecord[];
  /** Which kinds `items` was filtered to (for the empty state). */
  filter?: "all" | "image" | "video";
  /** Unfiltered items loaded so far: re-arms infinite scroll when a page adds nothing visible. */
  loadedCount?: number;
  modelNames: Record<string, string>;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (index: number) => void;
  scrollRoot: React.RefObject<HTMLElement | null>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadRef.current();
      },
      { root: scrollRoot.current, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, scrollRoot, items.length, loadedCount]);

  if (!loading && items.length === 0 && filter !== "all") {
    return (
      <div className="empty">
        <div className="empty__art" aria-hidden>
          <Icon name={filter === "video" ? "video" : "image"} size={28} />
        </div>
        <h3>{filter === "video" ? "No videos yet" : "No images yet"}</h3>
        <p>
          {filter === "video"
            ? "Switch the Create panel to Video, write a prompt and press Generate video (⌘↵)."
            : "Switch the Create panel to Image, write a prompt and press Generate (⌘↵)."}
        </p>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="empty">
        <div className="empty__art" aria-hidden>
          <Icon name="image" size={28} />
        </div>
        <h3>Your gallery is empty</h3>
        <p>Pick a model, write a prompt and press Generate (⌘↵). Every image is saved here with its full settings.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="gallery" aria-label="Generated images, newest first">
        {items.map((im, i) =>
          im.kind === "video" ? (
            <li key={im.id} className="gallery__item">
              <VideoTile im={im} modelName={modelNames[im.model] ?? im.model} onOpen={() => onOpen(i)} />
            </li>
          ) : (
          <li key={im.id} className="gallery__item">
            <button type="button" className="tile" onClick={() => onOpen(i)} aria-label={`Open image${im.initImage ? " (img2img)" : ""}: ${im.prompt}`}>
              <img src={fileSrc(im.path)} alt="" loading="lazy" decoding="async" />
              {im.initImage && (
                <span className="tile__badge" title={`From a start image${im.denoise != null ? ` · strength ${im.denoise.toFixed(2)}` : ""}`}>
                  img2img
                </span>
              )}
              <span className="tile__overlay" aria-hidden>
                <span className="tile__prompt">{im.prompt}</span>
                <span className="tile__meta">
                  {modelNames[im.model] ?? im.model} · {im.initImage ? `img2img ${im.denoise?.toFixed(2) ?? ""}`.trim() : im.aspectRatio} ·{" "}
                  {formatRelative(im.createdAt)}
                </span>
              </span>
            </button>
          </li>
          ),
        )}
      </ul>
      <div ref={sentinel} className="gallery__sentinel" aria-hidden />
      {loading && (
        <div className="gallery__loading" role="status">
          <Icon name="refresh" className="spin" /> Loading…
        </div>
      )}
      {!hasMore && items.length > 12 && <p className="gallery__end">That's everything.</p>}
    </>
  );
}

/** Video tile: poster + play/duration badge; plays muted on hover (poster + note if it can't). */
function VideoTile({ im, modelName, onOpen }: { im: ImageRecord; modelName: string; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(() => unplayable(im.path));
  const poster = im.posterPath ? fileSrc(im.posterPath) : "";
  const length = formatClipLength(im.durationS);
  const label = `Open video${im.initImage ? " (from a start image)" : ""}${length ? `, ${length}` : ""}${im.hasAudio ? ", with sound" : ""}: ${im.prompt}`;
  return (
    <button
      type="button"
      className="tile tile--video"
      onClick={onOpen}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      {poster ? <img src={poster} alt="" loading="lazy" decoding="async" /> : <span className="tile__noposter" aria-hidden />}
      {hover && !failed && im.path && (
        <video className="tile__video" src={fileSrc(im.path)} poster={poster || undefined} muted loop playsInline autoPlay preload="none" onError={() => setFailed(true)} />
      )}
      {hover && failed && <span className="tile__unavailable">{PREVIEW_UNAVAILABLE}</span>}
      {im.initImage && <span className="tile__badge">i2v</span>}
      <span className="tile__video-badge" aria-hidden>
        <Icon name="play" size={11} />
        {length && <span className="mono">{length}</span>}
        {im.hasAudio && <Icon name="volume" size={12} />}
      </span>
      <span className="tile__overlay" aria-hidden>
        <span className="tile__prompt">{im.prompt}</span>
        <span className="tile__meta">
          {modelName} · {im.aspectRatio.replace(/^(\d+)x(\d+)$/, "$1×$2")}
          {im.fps ? ` · ${im.fps} fps` : ""} · {formatRelative(im.createdAt)}
        </span>
      </span>
    </button>
  );
}
