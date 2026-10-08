// "From gallery" picker: the user's generated images (no videos), searchable by prompt/model,
// paginated with list_images and infinite scroll like the gallery.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../api";
import { fileSrc, type ImageRecord } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatRelative } from "../../lib/format";
import { useToast } from "../../state/toast";

const PAGE = 36;

export function GalleryPicker({
  open,
  title = "Choose a start image",
  modelNames,
  onClose,
  onPick,
}: {
  open: boolean;
  title?: string;
  modelNames: Record<string, string>;
  onClose: () => void;
  onPick: (rec: ImageRecord) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<ImageRecord[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const loadingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadMore = useCallback(
    async (reset = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const page = await api.listImages({ limit: PAGE, before: reset ? null : nextBefore });
        setLoaded((n) => (reset ? 0 : n) + page.items.length);
        const imgs = page.items.filter((r) => r.kind !== "video");
        setItems((prev) => (reset ? imgs : [...prev, ...imgs.filter((r) => !prev.some((p) => p.id === r.id))]));
        setNextBefore(page.nextBefore);
        setHasMore(page.nextBefore != null && page.items.length > 0);
      } catch (e) {
        toast.error("Couldn't load the gallery", e);
        setHasMore(false);
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [nextBefore, toast],
  );

  // Fresh list each time the picker opens (new images may have arrived).
  const loadRef = useRef(loadMore);
  loadRef.current = loadMore;
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
    setLoaded(0);
    setNextBefore(null);
    setHasMore(true);
    void loadRef.current(true);
    // showModal() focuses the header's Close button; start in the search field instead.
    const h = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(h);
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? items.filter((r) => r.prompt.toLowerCase().includes(q) || (modelNames[r.model] ?? r.model).toLowerCase().includes(q)) : items),
    [items, q, modelNames],
  );

  // Infinite scroll; re-armed whenever a page arrives (a page may add nothing that matches).
  useEffect(() => {
    const el = sentinel.current;
    if (!open || !el || !hasMore) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void loadRef.current(), {
      root: scrollRef.current,
      rootMargin: "400px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, loaded, shown.length]);

  return (
    <Dialog open={open} onClose={onClose} title={title} className="picker">
      <div className="picker__bar">
        <div className="picker__search">
          <Icon name="search" size={14} />
          <input
            className="input"
            type="search"
            placeholder="Search by prompt or model"
            aria-label="Search your images by prompt or model"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            ref={searchRef}
          />
        </div>
        <span className="hint mono">
          {shown.length}
          {hasMore ? "+" : ""} image{shown.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="picker__scroll" ref={scrollRef}>
        {shown.length > 0 && (
          <ul className="picker__grid" aria-label="Your images">
            {shown.map((r) => (
              <li key={r.id}>
                <button type="button" className="tile picker__tile" onClick={() => onPick(r)} aria-label={`Use as start image: ${r.prompt}`}>
                  <img src={fileSrc(r.path)} alt="" loading="lazy" decoding="async" />
                  <span className="tile__overlay" aria-hidden>
                    <span className="tile__prompt">{r.prompt}</span>
                    <span className="tile__meta">
                      {modelNames[r.model] ?? r.model} · {formatRelative(r.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {!loading && shown.length === 0 && !hasMore && (
          <p className="picker__empty hint">{q ? `No images match “${query.trim()}”.` : "No images yet — generate one in Image mode first."}</p>
        )}
        <div ref={sentinel} className="gallery__sentinel" aria-hidden />
        {loading && (
          <div className="gallery__loading" role="status">
            <Icon name="refresh" className="spin" /> Loading…
          </div>
        )}
      </div>
    </Dialog>
  );
}
