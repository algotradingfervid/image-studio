// The encrypted vault (spec v6, docs/vault-contract.md): live status from `vault-update`, the
// decrypted item list while unlocked, migration progress from `vault-migration`, and the
// activity ping (`vault_touch`) that holds off auto-lock while the user is active.
//
// Locking clears every vault record held here; screens watch `unlocked` / `lockEpoch` to drop
// their own copies (lightbox, start images, job cards).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../api";
import { errorCode, type ImageRecord, type Job, type MigrationProgress, type VaultStatus } from "../api";
import { VaultUnlockDialog } from "../screens/create/VaultViews";
import { useToast } from "./toast";

/** `vault_touch` at most this often while unlocked (docs/vault-contract.md). */
const TOUCH_EVERY_MS = 30_000;
/** Warn this long before an idle auto-lock (UX-039). */
const WARN_BEFORE_MS = 30_000;

/** Why the vault last locked: "idle" = the auto-lock timer ran out. */
export type VaultLockReason = "idle" | "manual" | null;

/** The auto-lock period in ms. */
export const autoLockMsOf = (s: VaultStatus | null) => s?.autoLockMs ?? (s?.autoLockMinutes ?? 10) * 60_000;

/** Switch the Create screen's gallery to its Vault tab, if it's on screen (true when it was). */
export function showVaultTab(): boolean {
  const tab = document.getElementById("gallery-tab-vault");
  if (!tab || tab.offsetParent === null) return false;
  tab.click();
  return true;
}

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
  /** Why the vault last locked (null while unlocked / before the first lock). */
  lockReason: VaultLockReason;
  /** Ask for the password (Vault tab when it's on screen, else a small dialog). */
  requestUnlock(): void;
  /** The General gallery changed because of vault work (an Undo moved an item back): reload it. */
  bumpGeneral(): void;
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
  const [lockReason, setLockReason] = useState<VaultLockReason>(null);
  const [unlockAsk, setUnlockAsk] = useState(false);
  const unlockedRef = useRef(false);
  const statusRef = useRef<VaultStatus | null>(null);
  /** When the backend's inactivity timer was last reset (unlock / vault_touch). */
  const lastTouch = useRef(0);
  /** Set by lock() so a manual lock isn't reported as an idle one. */
  const manualLock = useRef(false);
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
      statusRef.current = s;
      setStatus(s);
      if (!s.unlocked) {
        listSeq.current++;
        setItems([]);
        setLoading(false);
        if (was) {
          setLockEpoch((n) => n + 1);
          // Not our lock() and the inactivity period ran out: the idle auto-lock (UX-039).
          const idle = !manualLock.current && Date.now() >= lastTouch.current + autoLockMsOf(s) - 3000;
          setLockReason(idle ? "idle" : "manual");
          toast.dismissKey("vault-autolock");
          if (idle) {
            const mins = s.autoLockMinutes;
            toast.notify({
              kind: "info",
              key: "vault-locked-idle",
              title: "Vault locked",
              message: `Locked after ${mins} minute${mins === 1 ? "" : "s"} without activity. Change this in Settings → Vault.`,
              durationMs: 9000,
            });
          }
        }
        manualLock.current = false;
      } else {
        if (!was) {
          lastTouch.current = Date.now(); // unlocking itself counts as activity
          setLockReason(null);
          setUnlockAsk(false);
          toast.dismissKey("vault-sealed");
          toast.dismissKey("vault-locked-idle");
          sealedCount.current = { image: 0, video: 0 };
        }
        // Unlock, or the vault's items changed: re-read the list.
        void reloadItems();
      }
    },
    [reloadItems, toast],
  );

  // A vault job that finishes while the vault is locked leaves a lasting, non-revealing notice
  // with an Unlock action (UX-007): no prompt, thumbnail or vault count, only how many arrived.
  const sealedCount = useRef({ image: 0, video: 0 });
  const sealedSeen = useRef(new Set<string>());
  const requestUnlockRef = useRef<() => void>(() => {});
  useEffect(() => {
    const un = api.onEvent("job-update", (job: Job) => {
      if (job.destination !== "vault" || unlockedRef.current) return;
      if (job.status !== "completed" && job.status !== "cancelled" && job.status !== "failed") return;
      if (sealedSeen.current.has(job.jobId) || job.completed <= 0) return;
      sealedSeen.current.add(job.jobId);
      const c = sealedCount.current;
      if (job.kind === "video") c.video += job.completed;
      else c.image += job.completed;
      const parts = [c.image && `${c.image} image${c.image === 1 ? "" : "s"}`, c.video && `${c.video} video${c.video === 1 ? "" : "s"}`].filter(Boolean);
      toast.notify({
        kind: "success",
        key: "vault-sealed",
        sticky: true,
        title: `${parts.join(" and ")} saved to the vault`,
        message: "Sealed while the vault is locked. Unlock to view.",
        actions: [{ label: "Unlock", onClick: () => requestUnlockRef.current() }],
      });
    });
    return () => void un.then((f) => f());
  }, [toast]);

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
  // 30 s before an idle lock, while the app is in front, a non-revealing toast warns (UX-039).
  const unlocked = !!status?.unlocked;
  useEffect(() => {
    if (!unlocked) return;
    let lastInput = 0;
    let warned = false;
    const touch = () => {
      lastTouch.current = Date.now();
      if (warned) {
        warned = false;
        toast.dismissKey("vault-autolock");
      }
      api.vaultTouch().catch(() => {
        /* a missed ping only shortens the timer */
      });
    };
    const onInput = () => {
      const now = Date.now();
      lastInput = now;
      if (warned || now - lastTouch.current >= TOUCH_EVERY_MS) touch();
    };
    const tick = () => {
      const now = Date.now();
      const left = lastTouch.current + autoLockMsOf(statusRef.current) - now;
      if (left > WARN_BEFORE_MS + 1000) return;
      // Input since the last (throttled) ping: the user is active, so reset the timer instead of warning.
      if (lastInput > lastTouch.current) return touch();
      // The backend reset its timer by other means (it didn't lock on time): resync.
      if (left < -5000) return touch();
      const inFront = document.visibilityState === "visible" && document.hasFocus();
      if ((warned || inFront) && left > 1000) {
        warned = true;
        toast.notify({
          kind: "info",
          key: "vault-autolock",
          sticky: true,
          title: `Vault locks in ${Math.round(left / 1000)} s`,
          message: "No activity for a while. Vault items close when it locks.",
          actions: [{ label: "Stay unlocked", onClick: touch }],
        });
      }
    };
    const opts = { capture: true, passive: true } as const;
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, onInput, opts));
    const h = window.setInterval(tick, 1000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, onInput, opts));
      window.clearInterval(h);
      toast.dismissKey("vault-autolock");
    };
  }, [unlocked, toast]);

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
    manualLock.current = true;
    try {
      apply(await api.vaultLock());
    } catch (e) {
      manualLock.current = false;
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
  const requestUnlock = useCallback(() => {
    if (unlockedRef.current) {
      showVaultTab();
      return;
    }
    // On the Create screen the Vault tab's lock screen focuses Password; elsewhere use the dialog.
    if (!showVaultTab()) setUnlockAsk(true);
  }, []);
  requestUnlockRef.current = requestUnlock;
  const bumpGeneral = useCallback(() => setGeneralEpoch((n) => n + 1), []);

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
      lockReason,
      requestUnlock,
      bumpGeneral,
    }),
    [status, unlocked, items, loading, migration, dismissMigration, lockEpoch, generalEpoch, create, unlock, lock, changePassword, setAutoLock, reloadItems, removeLocal, addLocal, lockReason, requestUnlock, bumpGeneral],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <VaultUnlockDialog open={unlockAsk && !unlocked} onClose={() => setUnlockAsk(false)} onUnlocked={() => showVaultTab()} />
    </Ctx.Provider>
  );
}
