import { useEffect, useRef } from "react";
import { fileSrc, type ImageRecord } from "../../api";
import { Icon } from "../../components/Icon";
import { formatRelative } from "../../lib/format";

export function Gallery({
  items,
  modelNames,
  loading,
  hasMore,
  onLoadMore,
  onOpen,
  scrollRoot,
}: {
  items: ImageRecord[];
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
  }, [hasMore, scrollRoot, items.length]);

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
        {items.map((im, i) => (
          <li key={im.id} className="gallery__item">
            <button type="button" className="tile" onClick={() => onOpen(i)} aria-label={`Open image: ${im.prompt}`}>
              <img src={fileSrc(im.path)} alt="" loading="lazy" decoding="async" />
              <span className="tile__overlay" aria-hidden>
                <span className="tile__prompt">{im.prompt}</span>
                <span className="tile__meta">
                  {modelNames[im.model] ?? im.model} · {im.aspectRatio} · {formatRelative(im.createdAt)}
                </span>
              </span>
            </button>
          </li>
        ))}
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
