import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
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

/** Gap between tiles; matches `.gallery--justified { gap }`. */
const GAP = 10;
/** Narrowest tile at the target row height; a very tall item is cropped (object-fit: cover) to this. */
const MIN_TILE_W = 96;
/** Rows are not shrunk below this share of the target height (keeps narrow tiles >= ~77 px). */
const MIN_ROW_SHARE = 0.8;

/**
 * Justified rows (UI-073): fill each row with tiles until it would get shorter than the target row
 * height, then scale that row to the exact width, so every full row ends at the container edge.
 * The last row keeps the target height. Returns each tile's width in px (floored; the CSS flex-grow
 * shares out the sub-pixel rest), or null before the container is measured.
 */
function justify(ars: number[], width: number, rowH: number): number[] | null {
  if (!(width > 0) || !(rowH > 0)) return null;
  const out: number[] = new Array(ars.length);
  const close = (from: number, to: number, h: number) => {
    for (let k = from; k <= to; k++) out[k] = Math.max(1, Math.floor(ars[k] * h));
  };
  let start = 0;
  let sum = 0;
  for (let i = 0; i < ars.length; i++) {
    const n = i - start + 1;
    const h = (width - GAP * (n - 1)) / (sum + ars[i]);
    if (h > rowH) {
      sum += ars[i];
      continue;
    }
    // Adding tile i makes the row shorter than the target: keep it, or end the row before it,
    // whichever lands closer to the target height; never shrink a row far below the target.
    const before = n > 1 ? (width - GAP * (n - 2)) / sum : Infinity;
    if (n > 1 && (before - rowH < rowH - h || (h < rowH * MIN_ROW_SHARE && before <= rowH * 1.5))) {
      close(start, i - 1, before);
      start = i;
      sum = ars[i];
    } else {
      close(start, i, h);
      start = i + 1;
      sum = 0;
    }
  }
  for (let k = start; k < ars.length; k++) out[k] = Math.floor(ars[k] * rowH);
  return out;
}

/** Width of the gallery list and its CSS target row height (`--row-h`), tracked across resizes. */
function useRowBox(el: HTMLElement | null) {
  const [box, setBox] = useState<{ width: number; rowH: number }>({ width: 0, rowH: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const width = el.clientWidth;
      const rowH = parseFloat(getComputedStyle(el).getPropertyValue("--row-h")) || 0;
      setBox((b) => (b.width === width && b.rowH === rowH ? b : { width, rowH }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return box;
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
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  const box = useRowBox(listEl);
  // Tile aspect ratios, with very tall items widened (cropped) to a minimum width (UI-023).
  const ars = items.map((im) => (box.rowH > 0 ? Math.max(aspectOf(im), MIN_TILE_W / box.rowH) : aspectOf(im)));
  const widths = justify(ars, box.width, box.rowH);
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
      <ul ref={setListEl} className={`gallery gallery--justified ${widths ? "is-measured" : ""}`} aria-label="Generated images, newest first">
        {items.map((im, i) => {
          const style = { "--ar": ars[i], ...(widths ? { "--w": `${widths[i]}px` } : null) } as CSSProperties;
          return im.kind === "video" ? (
            <li key={im.id} className="gallery__item" style={style}>
              <VideoTile im={im} modelName={modelNames[im.model] ?? im.model} isNew={isNew(im)} onOpen={() => onOpen(i)} />
            </li>
          ) : (
            <li key={im.id} className="gallery__item" style={style}>
              <button
                type="button"
                className="tile"
                data-item-id={im.id}
                onClick={() => onOpen(i)}
                aria-label={`Open ${isNew(im) ? "new " : ""}image${im.initImage ? " (img2img)" : ""}: ${im.prompt}`}
              >
                <img src={fileSrc(im.thumbPath || im.path)} alt="" loading="lazy" decoding="async" />
                <TileBadges isNew={isNew(im)} type={im.initImage ? "img2img" : null} typeTitle={`From a start image${im.denoise != null ? ` · strength ${im.denoise.toFixed(2)}` : ""}`} />
                <span className="tile__overlay" aria-hidden>
                  <span className="tile__prompt">{im.prompt}</span>
                  <span className="tile__meta">
                    {modelNames[im.model] ?? im.model} · {im.initImage ? `img2img ${im.denoise?.toFixed(2) ?? ""}`.trim() : im.aspectRatio} ·{" "}
                    {formatRelative(im.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
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

/**
 * The tile's badges in one flex row (UI-023): New and the type (img2img / i2v) on the left, the
 * video's length on the right; on a narrow tile they wrap instead of covering each other.
 */
function TileBadges({ isNew, type, typeTitle, children }: { isNew: boolean; type: string | null; typeTitle?: string; children?: React.ReactNode }) {
  if (!isNew && !type && !children) return null;
  return (
    <span className="tile__badges" aria-hidden>
      {isNew && (
        <span className="tile__new" title="New since you opened the app">
          New
        </span>
      )}
      {type && (
        <span className="tile__badge" title={typeTitle}>
          {type}
        </span>
      )}
      {children}
    </span>
  );
}

/** Video tile: poster + play/duration badge; plays muted on hover (poster + note if it can't). */
function VideoTile({ im, modelName, isNew, onOpen }: { im: ImageRecord; modelName: string; isNew: boolean; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(() => unplayable(im.path));
  const poster = im.posterPath ? fileSrc(im.posterPath) : "";
  const length = formatClipLength(im.durationS);
  const label = `Open ${isNew ? "new " : ""}video${im.initImage ? " (from a start image)" : ""}${length ? `, ${length}` : ""}${im.hasAudio ? ", with sound" : ""}: ${im.prompt}`;
  return (
    <button
      type="button"
      className="tile tile--video"
      data-item-id={im.id}
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
      <TileBadges isNew={isNew} type={im.initImage ? "i2v" : null} typeTitle="From a start image">
        <span className="tile__video-badge">
          <Icon name="play" size={11} />
          {length && <span className="mono">{length}</span>}
          {im.hasAudio && <Icon name="volume" size={12} className="tile__audio" />}
        </span>
      </TileBadges>
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
