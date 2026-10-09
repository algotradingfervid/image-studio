import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import * as api from "../../api";
import { fileSrc, inTauri, type ImageRecord } from "../../api";
import { Icon, type IconName } from "../../components/Icon";
import { formatRelative, pct } from "../../lib/format";
import { useVault } from "../../state/vault";
import "../../styles/gallery.css";

// ---------- shared with the lightbox ----------

/**
 * The paging state of the gallery on screen (only one Gallery is mounted at a time), so the
 * lightbox can load the next page when it reaches the last loaded item (UX-049).
 */
export const galleryPager: { hasMore: boolean; loading: boolean; loadMore: () => void; filter: "all" | "image" | "video" } = {
  hasMore: false,
  loading: false,
  loadMore: () => {},
  filter: "all",
};

/** Real totals of the General gallery (the list is paged), read through every page. */
export interface GalleryTotals {
  items: number;
  images: number;
  videos: number;
}

export async function countGallery(): Promise<GalleryTotals> {
  const t: GalleryTotals = { items: 0, images: 0, videos: 0 };
  let before: number | null = null;
  for (let page = 0; page < 200; page++) {
    const res: api.ImagePage = await api.listImages({ limit: 500, before });
    for (const r of res.items) {
      t.items++;
      if (r.kind === "video") t.videos++;
      else t.images++;
    }
    if (res.nextBefore == null || res.items.length === 0) break;
    before = res.nextBefore;
  }
  return t;
}

export const totalFor = (t: GalleryTotals, filter: "all" | "image" | "video") => (filter === "video" ? t.videos : filter === "image" ? t.images : t.items);

// "New" markers (UX-041): items created during this session stay marked until opened.
const sessionStart = Date.now();
const seen = new Set<string>();
const seenSubs = new Set<() => void>();
let seenVersion = 0;
export function markSeen(id: string) {
  if (seen.has(id)) return;
  seen.add(id);
  seenVersion++;
  seenSubs.forEach((f) => f());
}
const isNew = (im: ImageRecord) => !seen.has(im.id) && Date.parse(im.createdAt) >= sessionStart;
function useSeenVersion() {
  return useSyncExternalStore(
    (f) => {
      seenSubs.add(f);
      return () => seenSubs.delete(f);
    },
    () => seenVersion,
  );
}

/** Switch the Create screen's gallery tab (General / Vault) by its tab button. */
export function switchGalleryTab(tab: "general" | "vault") {
  document.getElementById(`gallery-tab-${tab}`)?.click();
}

/** Width / height for the tile (UX-038: tiles keep the item's real aspect ratio). */
function aspectOf(im: ImageRecord): number {
  if (im.width > 0 && im.height > 0) return im.width / im.height;
  const m = String(im.aspectRatio ?? "").match(/^(\d+)\s*[:x×]\s*(\d+)$/);
  if (m && +m[1] > 0 && +m[2] > 0) return +m[1] / +m[2];
  return 4 / 5;
}

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
  empty,
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
  /** Empty-state override (the Vault tab). */
  empty?: { icon: IconName; title: string; text: string };
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;
  galleryPager.hasMore = hasMore;
  galleryPager.loading = loading;
  galleryPager.loadMore = onLoadMore;
  galleryPager.filter = filter;
  useSeenVersion();
  const vault = useVault();
  const mig = vault.migration;
  const migrating = !!mig && mig.phase !== "done" && mig.phase !== "error";

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

  if (!loading && items.length === 0 && empty) {
    return (
      <div className="empty">
        <div className="empty__art" aria-hidden>
          <Icon name={empty.icon} size={28} />
        </div>
        <h3>{empty.title}</h3>
        <p>{empty.text}</p>
        <div className="btn-row empty__actions">
          <button type="button" className="btn btn--sm" onClick={() => switchGalleryTab("general")}>
            <Icon name={filter === "video" ? "video" : "image"} size={14} />
            {filter === "video" ? "Show General videos" : filter === "image" ? "Show General images" : "Open General"}
          </button>
        </div>
      </div>
    );
  }

  // General while the move into the vault runs (UX-040).
  const migrationNote = migrating && !empty && (
    <div className="gallery-note" role="status">
      <Icon name="refresh" className="spin" size={14} />
      <span>
        Moving {mig!.done} of {mig!.total} into the vault…
      </span>
      {mig!.total > 0 && <span className="mono hint">{Math.round(pct(mig!.done, mig!.total))}%</span>}
    </div>
  );

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

  if (!loading && items.length === 0 && vault.exists) {
    return (
      <>
        {migrationNote}
        <div className="empty">
          <div className="empty__art" aria-hidden>
            <Icon name="image" size={28} />
          </div>
          <h3>Your General gallery is empty</h3>
          <p>
            {vault.unlocked && vault.items.length
              ? `${vault.items.length} item${vault.items.length === 1 ? " is" : "s are"} in the vault. `
              : "Items you moved into the vault are there, not here. "}
            New creations land wherever <strong>Save to</strong> says.
          </p>
          <div className="btn-row empty__actions">
            <button type="button" className="btn btn--sm" onClick={() => switchGalleryTab("vault")}>
              <Icon name={vault.unlocked ? "lockOpen" : "lock"} size={14} /> Open Vault
            </button>
          </div>
        </div>
      </>
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
      {migrationNote}
      <ul className="gallery gallery--justified" aria-label="Generated images, newest first">
        {items.map((im, i) =>
          im.kind === "video" ? (
            <li key={im.id} className="gallery__item" style={{ "--ar": aspectOf(im) } as CSSProperties}>
              <VideoTile im={im} modelName={modelNames[im.model] ?? im.model} onOpen={() => onOpen(i)} />
              {isNew(im) && <NewDot />}
            </li>
          ) : (
          <li key={im.id} className="gallery__item" style={{ "--ar": aspectOf(im) } as CSSProperties}>
            {isNew(im) && <NewDot />}
            <button type="button" className="tile" onClick={() => onOpen(i)} aria-label={`Open ${isNew(im) ? "new " : ""}image${im.initImage ? " (img2img)" : ""}: ${im.prompt}`}>
              <img src={fileSrc(im.thumbPath || im.path)} alt="" loading="lazy" decoding="async" />
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

function NewDot() {
  return (
    <span className="tile__new" title="New since you opened the app" aria-hidden>
      New
    </span>
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
      onClick={() => {
        // Stop the hover preview: left looping behind the lightbox it kept a second
        // video decoding and re-blurred the dialog backdrop every frame.
        setHover(false);
        onOpen();
      }}
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
