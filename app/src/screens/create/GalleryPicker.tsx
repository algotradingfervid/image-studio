// "From gallery" picker: the user's generated images (no videos), searchable by prompt, model or seed,
// paginated with list_images and infinite scroll like the gallery. A General | Vault switch offers vault
// images while unlocked; while locked the Vault side offers an inline unlock and shows nothing from the vault.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import * as api from "../../api";
import { fileSrc, type ImageRecord } from "../../api";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { formatRelative } from "../../lib/format";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import { countGallery } from "./Gallery";

const PAGE = 36;

export function GalleryPicker({
  open,
  title = "Choose a start image",
  purpose = "start",
  modelNames,
  onClose,
  onPick,
  preferVault = false,
  currentId,
  returnFocusRef,
}: {
  open: boolean;
  /** Start on the Vault source when it's available (Save to = Vault). */
  preferVault?: boolean;
  title?: string;
  /** What the picked image becomes (labels only). */
  purpose?: "start" | "reference";
  modelNames: Record<string, string>;
  onClose: () => void;
  onPick: (rec: ImageRecord) => void;
  /** The record already in use: ringed, badged "Current" and listed first. */
  currentId?: string;
  /** Focused after a pick or close when the control that opened the picker is gone (UI-006), e.g. the prompt. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const toast = useToast();
  const vault = useVault();
  const [source, setSource] = useState<"general" | "vault">("general");
  const fromVault = source === "vault" && vault.unlocked;
  const vaultLockedView = source === "vault" && !vault.unlocked;
  const [items, setItems] = useState<ImageRecord[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  /** All General images (the list is paged), for an exact count (UI-032). */
  const [generalImages, setGeneralImages] = useState<number | null>(null);

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
  const unlockedRef = useRef(vault.unlocked);
  unlockedRef.current = vault.unlocked;
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
    setLoaded(0);
    setNextBefore(null);
    setHasMore(true);
    setPassword("");
    setUnlockError(null);
    setSource(preferVault && unlockedRef.current ? "vault" : "general");
    void loadRef.current(true);
    setGeneralImages(null);
    let alive = true;
    countGallery()
      .then((t) => alive && setGeneralImages(t.images))
      .catch(() => {
        /* the count falls back to "n+" */
      });
    // showModal() focuses the header's Close button; start in the search field instead.
    const h = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      alive = false;
      cancelAnimationFrame(h);
    };
  }, [open]);

  useEffect(() => {
    if (vaultLockedView) requestAnimationFrame(() => passwordRef.current?.focus());
  }, [vaultLockedView]);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || unlocking) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await vault.unlock(password);
      setPassword("");
    } catch (err) {
      const msg = api.errorMessage(err);
      setUnlockError(msg.startsWith("WRONG_PASSWORD") ? "That password isn't right." : msg.replace(/^[A-Z_]+:\s*/, ""));
    } finally {
      setUnlocking(false);
    }
  };

  const q = query.trim().toLowerCase();
  const vaultImages = useMemo(() => (vault.unlocked ? vault.items.filter((r) => r.kind !== "video") : []), [vault.unlocked, vault.items]);
  const pool = fromVault ? vaultImages : vaultLockedView ? [] : items;
  const listHasMore = fromVault || vaultLockedView ? false : hasMore;
  const shown = useMemo(() => {
    const hits = q
      ? pool.filter((r) => r.prompt.toLowerCase().includes(q) || (modelNames[r.model] ?? r.model).toLowerCase().includes(q) || String(r.seed).includes(q))
      : pool;
    const cur = currentId ? hits.find((r) => r.id === currentId) : undefined;
    return cur ? [cur, ...hits.filter((r) => r !== cur)] : hits;
  }, [pool, q, modelNames, currentId]);

  // Infinite scroll; re-armed whenever a page arrives (a page may add nothing that matches).
  useEffect(() => {
    const el = sentinel.current;
    if (!open || !el || !hasMore || source === "vault") return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void loadRef.current(), {
      root: scrollRef.current,
      rootMargin: "400px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, loaded, shown.length, source]);

  const verb = purpose === "reference" ? "Add as reference" : "Use as start image";
  // Exact while browsing all General images; "n+" only while a search still has pages to read.
  const exact = !q && !fromVault && generalImages != null ? Math.max(generalImages, shown.length) : null;
  const countText = `${exact ?? shown.length}${exact == null && listHasMore ? "+" : ""} ${fromVault ? "vault " : ""}image${(exact ?? shown.length) === 1 ? "" : "s"}${q ? " found" : ""}`;
  const clearSearch = () => {
    setQuery("");
    searchRef.current?.focus();
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} className="picker" returnFocusRef={returnFocusRef}>
      <div className="picker__bar">
        {vault.exists && (
          <div className="segmented picker__source" role="radiogroup" aria-label="Pick from">
            {(["general", "vault"] as const).map((src) => (
              <button
                key={src}
                type="button"
                role="radio"
                aria-checked={source === src}
                tabIndex={source === src ? 0 : -1}
                className={source === src ? "is-selected" : ""}
                onClick={() => setSource(src)}
              >
                {src === "vault" && <Icon name={vault.unlocked ? "unlock" : "lock"} size={13} />}
                {src === "general" ? "General" : vault.unlocked ? "Vault" : "Vault (locked)"}
              </button>
            ))}
          </div>
        )}
        {!vaultLockedView && (
          <div className="picker__search">
            <Icon name="search" size={14} />
            <input
              className="input"
              type="search"
              placeholder="Search by prompt, model or seed"
              aria-label="Search your images by prompt, model or seed"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              ref={searchRef}
            />
          </div>
        )}
        {/* Always rendered (a live region must exist before it changes); announces result counts (UI-032). */}
        <span className="hint mono" role="status">
          {vaultLockedView ? "" : countText}
        </span>
      </div>
      {fromVault && (
        <p className="hint picker__vault-note">
          <Icon name="lock" size={12} /> Images made from a vault image are saved to the vault.
        </p>
      )}
      <div className="picker__scroll" ref={scrollRef}>
        {vaultLockedView ? (
          <form className="picker__unlock" onSubmit={unlock}>
            <Icon name="lock" size={22} />
            <p>The vault is locked. Unlock it to pick from your vault images.</p>
            <label className="visually-hidden" htmlFor="picker-vault-password">
              Vault password
            </label>
            <div className="picker__unlock-row">
              <input
                id="picker-vault-password"
                ref={passwordRef}
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Vault password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!unlockError || undefined}
                aria-describedby={unlockError ? "picker-vault-err" : undefined}
              />
              <button type="submit" className="btn btn--primary" disabled={!password || unlocking}>
                {unlocking ? <Icon name="refresh" className="spin" /> : <Icon name="unlock" />} Unlock
              </button>
            </div>
            {unlockError && (
              <p className="field-error" id="picker-vault-err" role="alert">
                {unlockError}
              </p>
            )}
          </form>
        ) : (
          shown.length > 0 && (
            <ul className="picker__grid" aria-label={fromVault ? "Your vault images" : "Your images"}>
              {shown.map((r) => {
                const current = r.id === currentId;
                return (
                  <li key={r.id} className="picker__cell">
                    <button
                      type="button"
                      className={`tile picker__tile ${current ? "is-current" : ""}`}
                      onClick={() => onPick(r)}
                      aria-label={`${verb}${r.vault ? " (from the vault)" : ""}${current ? " (current)" : ""}: ${r.prompt}, seed ${r.seed}, ${r.width}×${r.height}`}
                      title={r.prompt}
                    >
                      <img src={fileSrc(r.thumbPath || r.path)} alt="" loading="lazy" decoding="async" />
                      {r.vault && (
                        <span className="tile__badge tile__badge--vault">
                          <Icon name="lock" size={10} /> Vault
                        </span>
                      )}
                      {current && <span className="tile__badge picker__current">Current</span>}
                    </button>
                    <span className="picker__caption" aria-hidden>
                      <span className="picker__caption-prompt">{r.prompt}</span>
                      <span className="mono">
                        seed {r.seed} · {r.width}×{r.height} · {formatRelative(r.createdAt)}
                      </span>
                      <span>{modelNames[r.model] ?? r.model}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )
        )}
        {!vaultLockedView && (fromVault || !loading) && shown.length === 0 && !listHasMore && (
          <div className="picker__empty hint">
            <p>{q ? `No images match “${query.trim()}”.` : fromVault ? "No images in the vault yet." : "No images yet — generate one in Image mode first."}</p>
            {q && (
              <>
                <p>Search matches words in the prompt, the model name or the seed.</p>
                <div className="btn-row picker__empty-actions">
                  <button type="button" className="btn btn--sm" onClick={clearSearch}>
                    <Icon name="x" size={13} /> Clear search
                  </button>
                </div>
              </>
            )}
            {vault.exists && !vault.unlocked && source === "general" && (
              <p>
                Vault images aren't searched while the vault is locked.{" "}
                <button type="button" className="link-btn" onClick={() => setSource("vault")}>
                  Unlock vault
                </button>
              </p>
            )}
          </div>
        )}
        <div ref={sentinel} className="gallery__sentinel" aria-hidden />
        {loading && source === "general" && (
          <div className="gallery__loading" role="status">
            <Icon name="refresh" className="spin" /> Loading…
          </div>
        )}
      </div>
    </Dialog>
  );
}
