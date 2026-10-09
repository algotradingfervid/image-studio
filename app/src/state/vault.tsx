// The encrypted vault (spec v6, docs/vault-contract.md): live status from `vault-update`, the
// decrypted item list while unlocked, migration progress from `vault-migration`, and the
// activity ping (`vault_touch`) that holds off auto-lock while the user is active.
//
// Locking clears every vault record held here; screens watch `unlocked` / `lockEpoch` to drop
// their own copies (lightbox, start images, job cards).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { errorCode, type ImageRecord, type MigrationProgress, type VaultStatus } from "../api";
import { useToast } from "./toast";

/** `vault_touch` at most this often while unlocked (docs/vault-contract.md). */
const TOUCH_EVERY_MS = 30_000;

interface Vault {
  /** null until `vault_status` answers. */
  status: VaultStatus | null;
  exists: boolean;
  unlocked: boolean;
  /** Decrypted records, newest first; empty while locked. */
  items: ImageRecord[];
  /** The first list after an unlock is loading. */
  loading: boolean;
  /** Latest `vault-migration` payload of this session (kept after "done" until dismissed). */
  migration: MigrationProgress | null;
  dismissMigration(): void;
  /** Bumped on every lock (screens close vault views on it). */
  lockEpoch: number;
  /** Bumped when vault work changed the General gallery (migration finished). */
  generalEpoch: number;
  create(password: string): Promise<void>;
  /** Rejects with the backend error (`WRONG_PASSWORD: …`) for the caller to show. */
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  setAutoLock(minutes: number): Promise<void>;
  reloadItems(): Promise<void>;
  /** Drop an item locally (deleted / moved to General) before the event's refetch lands. */
  removeLocal(id: string): void;
  /** Add records locally (a vault job's outputs), newest first, deduplicated. */
  addLocal(recs: ImageRecord[]): void;
}

const Ctx = createContext<Vault | null>(null);

export function useVault(): Vault {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside provider");
  return v;
}

const byNewest = (a: ImageRecord, b: ImageRecord) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

export function VaultProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [migration, setMigration] = useState<MigrationProgress | null>(null);
  const [lockEpoch, setLockEpoch] = useState(0);
  const [generalEpoch, setGeneralEpoch] = useState(0);
  const unlockedRef = useRef(false);
  // Responses that arrive after a lock must not put vault records back into memory.
  const listSeq = useRef(0);

  const reloadItems = useCallback(async () => {
    if (!unlockedRef.current) return;
    const seq = ++listSeq.current;
    setLoading(true);
    try {
      const list = await api.listVaultItems();
      if (seq === listSeq.current && unlockedRef.current) setItems(list);
    } catch (e) {
      if (errorCode(e) !== "VAULT_LOCKED") toast.error("Couldn't load the vault", e);
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  }, [toast]);

  const apply = useCallback(
    (s: VaultStatus) => {
      const was = unlockedRef.current;
      unlockedRef.current = s.unlocked;
      setStatus(s);
      if (!s.unlocked) {
        listSeq.current++;
        setItems([]);
        setLoading(false);
        if (was) setLockEpoch((n) => n + 1);
      } else {
        // Unlock, or the vault's items changed: re-read the list.
        void reloadItems();
      }
    },
    [reloadItems],
  );

  useEffect(() => {
    let alive = true;
    api
      .vaultStatus()
      .then((s) => alive && apply(s))
      .catch((e) => toast.error("Couldn't read the vault status", e));
    const unStatus = api.onEvent("vault-update", (s) => apply(s));
    const unMig = api.onEvent("vault-migration", (p) => {
      setMigration(p);
      if (p.phase === "done" || p.phase === "error") {
        // The migrated records left the General gallery.
        setGeneralEpoch((n) => n + 1);
        void reloadItems();
      }
    });
    return () => {
      alive = false;
      void unStatus.then((f) => f());
      void unMig.then((f) => f());
    };
  }, [apply, reloadItems, toast]);

  // Activity: user input resets the auto-lock timer, throttled, only while unlocked.
  const lastTouch = useRef(0);
  const unlocked = !!status?.unlocked;
  useEffect(() => {
    if (!unlocked) return;
    lastTouch.current = Date.now(); // unlocking itself counts as activity
    const onInput = () => {
      const now = Date.now();
      if (now - lastTouch.current < TOUCH_EVERY_MS) return;
      lastTouch.current = now;
      api.vaultTouch().catch(() => {
        /* a missed ping only shortens the timer */
      });
    };
    const opts = { capture: true, passive: true } as const;
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, onInput, opts));
    return () => events.forEach((ev) => window.removeEventListener(ev, onInput, opts));
  }, [unlocked]);

  const create = useCallback(
    async (password: string) => {
      setMigration(null);
      apply(await api.vaultCreate(password));
    },
    [apply],
  );

  const unlock = useCallback(
    async (password: string) => {
      apply(await api.vaultUnlock(password));
    },
    [apply],
  );

  const lock = useCallback(async () => {
    try {
      apply(await api.vaultLock());
    } catch (e) {
      toast.error("Couldn't lock the vault", e);
    }
  }, [apply, toast]);

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string) => {
      apply(await api.vaultChangePassword(oldPassword, newPassword));
    },
    [apply],
  );

  const setAutoLock = useCallback(
    async (minutes: number) => {
      apply(await api.vaultSetAutoLock(minutes));
    },
    [apply],
  );

  const removeLocal = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const addLocal = useCallback((recs: ImageRecord[]) => {
    if (!unlockedRef.current) return;
    setItems((xs) => {
      const fresh = recs.filter((r) => r.vault && !xs.some((x) => x.id === r.id));
      return fresh.length ? [...fresh, ...xs].sort(byNewest) : xs;
    });
  }, []);
  const dismissMigration = useCallback(() => setMigration(null), []);

  const value = useMemo<Vault>(
    () => ({
      status,
      exists: !!status?.exists,
      unlocked,
      items,
      loading,
      migration,
      dismissMigration,
      lockEpoch,
      generalEpoch,
      create,
      unlock,
      lock,
      changePassword,
      setAutoLock,
      reloadItems,
      removeLocal,
      addLocal,
    }),
    [status, unlocked, items, loading, migration, dismissMigration, lockEpoch, generalEpoch, create, unlock, lock, changePassword, setAutoLock, reloadItems, removeLocal, addLocal],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
