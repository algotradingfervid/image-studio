import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../../api";
import type { ConnectionTest, KeyCheck, KeyTestReport } from "../../api";
import { Icon } from "../../components/Icon";
import { shortGpuName } from "../../lib/format";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import { PasswordField } from "../create/VaultViews";
import "../../styles/gpu-settings.css";

/** True while `ref`'s element is on screen (false once its tab panel is hidden). */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(() => setOn(el.offsetParent !== null || el.getClientRects().length > 0));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

function SecretField({
  id,
  label,
  saved,
  value,
  onChange,
  help,
  visible,
  unverified,
  inputRef,
}: {
  id: string;
  label: string;
  saved: boolean;
  /** Saved with "Save anyway" and not successfully tested since (UI-049). */
  unverified?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  help: ReactNode;
  /** The screen is showing: a revealed key is masked again when it isn't (UX-021). */
  visible: boolean;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!visible || !value) setShow(false);
  }, [visible, value]);
  return (
    <div className="field">
      <div className="field__label-row">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {value ? (
          <span className="badge badge--warn">Not saved yet</span>
        ) : (
          saved &&
          (unverified ? (
            <span className="badge badge--warn" title="Saved without a successful check. Test connection checks it.">
              <Icon name="alert" size={11} /> Saved · not verified
            </span>
          ) : (
            <span className="badge badge--ok">
              <Icon name="lock" size={11} /> Saved in Keychain
            </span>
          ))
        )}
      </div>
      <div className="input-icon input-icon--end">
        <Icon name="key" />
        <input
          id={id}
          ref={inputRef}
          className="input mono"
          type={show ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={saved ? "•••••••••••• (enter a new key to replace it)" : "Paste your key"}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          aria-describedby={`${id}-help`}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm input-icon__end"
          aria-label={show ? "Hide what you typed" : "Show what you typed"}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
          disabled={!value}
        >
          <Icon name="eye" />
        </button>
      </div>
      <p id={`${id}-help`} className="hint">
        {help}
      </p>
    </div>
  );
}

const IDLE_MIN = 5;
const IDLE_MAX = 240;

function parseIdle(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= IDLE_MIN && n <= IDLE_MAX ? n : null;
}

/** One line per key: "RunPod: key OK · GPU stopped" / "Civitai: rejected — …". */
function KeyResults({ report, pod, boxRef }: { report: KeyTestReport; pod: ConnectionTest | null; boxRef?: React.Ref<HTMLDivElement> }) {
  const row = (name: string, c: KeyCheck | null, extra?: string) => {
    if (!c) return null;
    return (
      <li className={`key-results__row ${c.ok ? "is-ok" : "is-error"}`}>
        <Icon name={c.ok ? "check" : "alert"} size={14} />
        <span>
          <strong>{name}:</strong> {c.message}
          {extra ? ` · ${extra}` : ""}
          <span className="hint"> ({c.source === "typed" ? "the key you typed, not saved yet" : "saved key"})</span>
        </span>
      </li>
    );
  };
  const podLine =
    pod && report.runpod?.ok && report.runpod.source === "saved"
      ? pod.target === "pod"
        ? pod.ok
          ? `Images GPU ${pod.ready === false ? "reachable, still booting" : "running and ready"}`
          : `Images GPU not reachable: ${pod.error ?? "unknown error"}`
        : "Images GPU stopped (not started by this test)"
      : undefined;
  return (
    // The live region wraps the list, so the <ul> keeps its list semantics (UI-043).
    <div className="key-results-box" role="status" aria-live="polite" aria-label="Key test results" tabIndex={-1} ref={boxRef}>
      <ul className="plain key-results">
        {row("RunPod", report.runpod, podLine)}
        {row("Civitai", report.civitai)}
        {!report.runpod && !report.civitai && <li className="hint">No keys to test — paste a key first.</li>}
      </ul>
    </div>
  );
}

function parseAutoLock(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= api.VAULT_AUTOLOCK_MIN && n <= api.VAULT_AUTOLOCK_MAX ? n : null;
}

/** Opens Create → Gallery → Vault (where the vault is created / unlocked). */
function goToVaultTab() {
  if (window.location.hash.slice(1) !== "create") window.location.hash = "create";
  window.setTimeout(() => {
    const tab = document.getElementById("gallery-tab-vault");
    tab?.click();
    window.setTimeout(() => (document.querySelector<HTMLInputElement>(".vault-gate input[type=password]") ?? tab)?.focus(), 80);
  }, 60);
}

/** Vault (spec v6): auto-lock minutes (only while unlocked), change password, lock now, erase. */
function VaultSettings() {
  const vault = useVault();
  const toast = useToast();
  const st = vault.status;
  const [minutes, setMinutes] = useState("10");
  const [savingMin, setSavingMin] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  /** Errors next to the field they belong to (UI-060); `pwError` for the rest. */
  const [oldPwError, setOldPwError] = useState<string | null>(null);
  const [newPwError, setNewPwError] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const oldPwRef = useRef<HTMLInputElement>(null);
  const newPwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (st) setMinutes(String(st.autoLockMinutes));
  }, [st?.autoLockMinutes, st?.unlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typed passwords don't outlive the unlock: cleared when the vault locks (or is erased).
  const unlockedNow = !!st?.unlocked;
  useEffect(() => {
    if (unlockedNow) return;
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setOldPwError(null);
    setNewPwError(null);
    setPwError(null);
  }, [unlockedNow]);

  const locked = !!st && !st.unlocked;
  const minN = parseAutoLock(minutes);
  const minDirty = !!st && minN !== st.autoLockMinutes;
  const minInvalid = minN == null && !locked;

  const saveMinutes = async (e: FormEvent) => {
    e.preventDefault();
    if (minN == null || !minDirty || locked) return;
    setSavingMin(true);
    try {
      await vault.setAutoLock(minN);
      toast.success("Auto-lock saved", `The vault locks after ${minN} minute${minN === 1 ? "" : "s"} without activity.`);
    } catch (err) {
      toast.error("Couldn't save the auto-lock time", api.errorCode(err) === "VAULT_LOCKED" ? "Unlock the vault to change its auto-lock time." : err);
    } finally {
      setSavingMin(false);
    }
  };

  const short = newPw.length > 0 && newPw.length < api.VAULT_PASSWORD_MIN;
  const same = newPw.length > 0 && newPw === oldPw;
  const mismatch = confirmPw.length > 0 && confirmPw !== newPw;
  const pwValid = !!oldPw && newPw.length >= api.VAULT_PASSWORD_MIN && confirmPw === newPw && !same;

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (!pwValid || pwBusy) return;
    setPwBusy(true);
    setOldPwError(null);
    setNewPwError(null);
    setPwError(null);
    try {
      await vault.changePassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      toast.success("Vault password changed", "Use the new password from now on — the old one no longer works.");
    } catch (err) {
      const code: string | null = api.errorCode(err);
      const select = (r: React.RefObject<HTMLInputElement | null>) =>
        requestAnimationFrame(() => {
          r.current?.focus();
          r.current?.select();
        });
      if (code === "WRONG_PASSWORD") {
        setOldPwError("The current password is wrong.");
        select(oldPwRef);
      } else if (code === "WEAK_PASSWORD" || code === "SAME_PASSWORD") {
        setNewPwError(code === "WEAK_PASSWORD" ? `Use at least ${api.VAULT_PASSWORD_MIN} characters.` : "Choose a password different from the current one.");
        select(newPwRef);
      } else {
        setPwError(code === "VAULT_LOCKED" ? "The vault locked. Unlock it and try again." : api.errorMessage(err));
      }
    } finally {
      setPwBusy(false);
    }
  };

  const lockNow = async () => {
    await vault.lock();
    toast.info("Vault locked", "Vault items are hidden until you unlock.");
  };

  return (
    <section id="set-vault" className="card settings vault-settings" aria-labelledby="vault-settings-title">
      <h2 id="vault-settings-title" className="card__title">
        <Icon name="shield" /> Vault
        {st?.exists && (
          <span className={`badge ${st.unlocked ? "badge--accent" : "badge--muted"} vault-settings__state`}>
            <Icon name={st.unlocked ? "unlock" : "lock"} size={11} /> {st.unlocked ? "Unlocked" : "Locked"}
          </span>
        )}
      </h2>
      {!st ? (
        <p className="hint">Loading…</p>
      ) : !st.exists ? (
        <div className="vault-settings__row">
          <p className="hint vault-settings__grow">No vault yet. It lives in the gallery on the Create screen.</p>
          <button type="button" className="btn" onClick={goToVaultTab} data-vault-start>
            <Icon name="shield" /> Create vault…
          </button>
        </div>
      ) : (
        <>
          <form className="field" onSubmit={saveMinutes}>
            <label className="field__label" htmlFor="vault-autolock">
              Auto-lock after N minutes without activity
            </label>
            <div className="vault-settings__row">
              <div className="input-suffix">
                <input
                  id="vault-autolock"
                  className={`input mono ${minInvalid ? "input--invalid" : ""}`}
                  type="number"
                  inputMode="numeric"
                  min={api.VAULT_AUTOLOCK_MIN}
                  max={api.VAULT_AUTOLOCK_MAX}
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  disabled={locked}
                  aria-invalid={minInvalid}
                  aria-describedby="vault-autolock-help"
                />
                <span className="input-suffix__unit">min</span>
              </div>
              <button type="submit" className="btn" disabled={locked || minN == null || !minDirty || savingMin}>
                {savingMin ? "Saving…" : "Save"}
              </button>
            </div>
            {/* Same error pattern as the other vault fields: icon + text, announced (UI-079). */}
            <p id="vault-autolock-help" className={`hint ${minInvalid ? "hint--error" : ""}`} role={minInvalid ? "alert" : undefined}>
              {locked ? (
                "Unlock the vault to change auto-lock."
              ) : minInvalid ? (
                <>
                  <Icon name="alert" size={12} /> Enter a whole number from {api.VAULT_AUTOLOCK_MIN} to {api.VAULT_AUTOLOCK_MAX}.
                </>
              ) : (
                "The vault also locks when the app quits and when the Mac sleeps or locks its screen. Default 10."
              )}
            </p>
          </form>

          {st.unlocked ? (
            <>
              <h3 className="card__title card__title--sub">
                <Icon name="key" /> Change password
              </h3>
              <form onSubmit={changePw} aria-label="Change the vault password">
                {/* readOnly, not disabled, while it runs: a disabled field or button drops focus to <body> (UI-006). */}
                <PasswordField
                  id="vault-old-pw"
                  label="Current password"
                  value={oldPw}
                  onChange={(v) => {
                    setOldPw(v);
                    if (oldPwError) setOldPwError(null);
                  }}
                  readOnly={pwBusy}
                  invalid={!!oldPwError}
                  describedBy={oldPwError ? "vault-old-pw-error" : undefined}
                  inputRef={oldPwRef}
                />
                {oldPwError && (
                  <p id="vault-old-pw-error" className="hint hint--error vault-settings__field-error" role="alert">
                    <Icon name="alert" size={12} /> {oldPwError}
                  </p>
                )}
                <div className="field-row vault-settings__pw">
                  <div>
                    <PasswordField
                      id="vault-new-pw"
                      label="New password"
                      value={newPw}
                      onChange={(v) => {
                        setNewPw(v);
                        if (newPwError) setNewPwError(null);
                      }}
                      readOnly={pwBusy}
                      invalid={short || same || !!newPwError}
                      describedBy="vault-new-pw-help"
                      autoComplete="new-password"
                      inputRef={newPwRef}
                    />
                    <p id="vault-new-pw-help" className={`hint ${short || same || newPwError ? "hint--error" : ""}`} role={newPwError ? "alert" : undefined}>
                      {newPwError ?? (same ? "Choose a password different from the current one." : `At least ${api.VAULT_PASSWORD_MIN} characters.`)}
                    </p>
                  </div>
                  <div>
                    <PasswordField
                      id="vault-confirm-pw"
                      label="Confirm new password"
                      value={confirmPw}
                      onChange={setConfirmPw}
                      readOnly={pwBusy}
                      invalid={mismatch}
                      describedBy="vault-confirm-pw-help"
                      autoComplete="new-password"
                    />
                    <p id="vault-confirm-pw-help" className={`hint ${mismatch ? "hint--error" : ""}`}>
                      {mismatch ? "The passwords don't match." : "Type it again."}
                    </p>
                  </div>
                </div>
                {pwError && (
                  <p className="vault-gate__status is-error" role="alert">
                    <Icon name="alert" size={14} /> {pwError}
                  </p>
                )}
                <p className="hint">There is still no recovery: if you forget the new password, the only way out is to erase the vault, which deletes everything in it.</p>
                <div className="settings__actions">
                  {/* aria-disabled keeps focus on the button while it runs and after the fields clear (UI-006). */}
                  <button type="submit" className="btn btn--primary" aria-disabled={!pwValid || pwBusy}>
                    {pwBusy ? <Icon name="refresh" className="spin" /> : null}
                    {pwBusy ? "Changing…" : "Change password"}
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {/* Same place either way, so the layout doesn't jump under the pointer (UX-071). One
              button element whose label changes, so focus stays on it (UI-006). */}
          <h3 className="card__title card__title--sub">
            <Icon name={st.unlocked ? "lock" : "unlock"} /> {st.unlocked ? "Lock" : "Unlock"}
          </h3>
          <div className="vault-settings__row">
            <p className="hint vault-settings__grow">
              {st.unlocked ? (
                "Locking wipes the key and every decrypted item from memory. Vault items disappear until you unlock again."
              ) : (
                <>
                  <Icon name="lock" size={12} /> The vault is locked. Unlock it to change its password or auto-lock time.
                </>
              )}
            </p>
            <button type="button" className="btn" onClick={() => (st.unlocked ? void lockNow() : vault.requestUnlock())}>
              <Icon name={st.unlocked ? "lock" : "unlock"} /> {st.unlocked ? "Lock now" : "Unlock vault…"}
            </button>
          </div>

          <h3 className="card__title card__title--sub vault-settings__danger-title">
            <Icon name="trash" /> Erase vault
          </h3>
          <div className="vault-settings__row">
            <p className="hint vault-settings__grow">
              Deletes everything in the vault and its key, for good, without opening it. The only way out if you forget the password.
            </p>
            <button type="button" className="btn btn--danger-text vault-settings__erase" onClick={() => vault.requestErase()}>
              <Icon name="trash" /> Erase vault and start over…
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const SECTIONS = [
  { id: "set-runpod", label: "RunPod" },
  { id: "set-civitai", label: "Civitai" },
  { id: "set-vault", label: "Vault" },
  { id: "set-costs", label: "Costs" },
] as const;

/** In-page links (buttons: a #hash would switch the app's tab). */
function SectionNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const navRef = useRef<HTMLElement>(null);
  /** A clicked link stays active until its scroll ends (UI-039): the spy waits for the scroll to settle. */
  const clicked = useRef<number | null>(null);
  useEffect(() => {
    const scroller = navRef.current?.closest<HTMLElement>(".page");
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    // Short last sections can't reach the spy's band: at the bottom, the last one is current.
    const last = SECTIONS[SECTIONS.length - 1].id;
    const atBottom = () => scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const io = new IntersectionObserver(
      (entries) => {
        if (clicked.current != null) return;
        if (atBottom()) return setActive(last);
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { root: scroller, rootMargin: "-10% 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    const onScroll = () => {
      if (clicked.current != null) {
        // Still scrolling to the clicked section: wait for 150 ms without scroll events.
        window.clearTimeout(clicked.current);
        clicked.current = window.setTimeout(() => (clicked.current = null), 150);
        return;
      }
      if (atBottom()) setActive(last);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      if (clicked.current != null) window.clearTimeout(clicked.current);
    };
  }, []);
  return (
    <nav className="section-nav" aria-label="Settings sections" ref={navRef}>
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`section-nav__link ${active === s.id ? "is-active" : ""}`}
          aria-current={active === s.id ? "true" : undefined}
          onClick={() => {
            setActive(s.id);
            if (clicked.current != null) window.clearTimeout(clicked.current);
            // Released 150 ms after the last scroll event (or now + 150 ms when nothing scrolls).
            clicked.current = window.setTimeout(() => (clicked.current = null), 150);
            document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

/** A list from the settings file, shown in full (UX-029). */
function ConfigList({ items, ordered }: { items: string[]; ordered?: boolean }) {
  if (!items.length) return <span className="hint">—</span>;
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={`config-list ${ordered ? "config-list--ordered" : ""}`}>
      {items.map((x) => (
        <li key={x} title={x}>
          {x}
        </li>
      ))}
    </Tag>
  );
}

/** Keys saved with "Save anyway" that no test has confirmed yet (UI-049); kept across restarts. */
type Unverified = { runpod?: boolean; civitai?: boolean };
const UNVERIFIED_KEY = "imagestudio.unverifiedKeys";
function readUnverified(): Unverified {
  try {
    const v = JSON.parse(localStorage.getItem(UNVERIFIED_KEY) ?? "{}");
    return { runpod: v?.runpod === true, civitai: v?.civitai === true };
  } catch {
    return {};
  }
}

/** Marks the Settings tab while edits are unsaved (UI-047); styled in gpu-settings.css. */
function useDirtyMarker(dirty: boolean) {
  useEffect(() => {
    document.documentElement.toggleAttribute("data-settings-dirty", dirty);
    return () => document.documentElement.removeAttribute("data-settings-dirty");
  }, [dirty]);
}

export function SettingsScreen() {
  const lib = useLibrary();
  const toast = useToast();
  const s = lib.settings;
  const formRef = useRef<HTMLFormElement>(null);
  const visible = useOnScreen(formRef);
  const [apiKey, setApiKey] = useState("");
  const [civitaiKey, setCivitaiKey] = useState("");
  const [idle, setIdle] = useState("30");
  /** The idle field was left since the last edit: only then is a bad value flagged (UI-045). */
  const [idleSettled, setIdleSettled] = useState(true);
  const [passKey, setPassKey] = useState(true);
  /** "checking": a typed key is being checked before the save; "saving": writing. */
  const [saving, setSaving] = useState<false | "checking" | "saving">(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<{ keys: KeyTestReport; pod: ConnectionTest | null } | null>(null);
  /** A typed key couldn't be checked (network): offer to save it anyway. */
  const [saveAnyway, setSaveAnyway] = useState<{ message: string; keys: (keyof Unverified)[] } | null>(null);
  /** A typed key was rejected by the check that runs before saving: nothing was saved. */
  const [rejected, setRejected] = useState(false);
  const [unverified, setUnverifiedState] = useState<Unverified>(readUnverified);
  const [revealError, setRevealError] = useState<string | null>(null);
  const saveAnywayRef = useRef<HTMLButtonElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  /** Set when a save was blocked: the reason is brought into view and focused once it renders (UI-007). */
  const revealBlock = useRef<"anyway" | "results" | null>(null);
  const fieldRefs = {
    runpod: useRef<HTMLInputElement>(null),
    civitai: useRef<HTMLInputElement>(null),
    idle: useRef<HTMLInputElement>(null),
    passKey: useRef<HTMLInputElement>(null),
  };

  const setUnverified = (next: Unverified) => {
    setUnverifiedState(next);
    try {
      localStorage.setItem(UNVERIFIED_KEY, JSON.stringify(next));
    } catch {
      /* the pill then lasts this session only */
    }
  };

  useEffect(() => {
    if (!s) return;
    setIdle(String(s.idleMinutes));
    setPassKey(s.passApiKeyToPod);
  }, [s]);

  const idleN = parseIdle(idle);
  const idleInvalid = idleN == null;
  const showIdleError = idleInvalid && idleSettled;
  const changed = {
    idle: !!s && (idleN == null ? idle.trim() !== String(s.idleMinutes) : idleN !== s.idleMinutes),
    passKey: !!s && passKey !== s.passApiKeyToPod,
  };
  const dirty = !!apiKey || !!civitaiKey || changed.idle || changed.passKey;
  useDirtyMarker(dirty);

  // Any edit makes an earlier test result stale.
  useEffect(() => {
    setReport(null);
    setSaveAnyway(null);
    setRejected(false);
  }, [apiKey, civitaiKey]);

  // A blocked save shows its reason in the form: scroll it above the sticky bar and focus it (UI-007).
  useEffect(() => {
    const what = revealBlock.current;
    if (!what) return;
    const el = what === "anyway" ? saveAnywayRef.current : resultsRef.current;
    if (!el) return;
    revealBlock.current = null;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.focus({ preventScroll: true });
  }, [saveAnyway, report]);

  /** The first edited field: focus goes back to it, not <body>, when the bar goes away (UI-006). */
  const firstEdited = () => (apiKey ? "runpod" : civitaiKey ? "civitai" : changed.idle ? "idle" : changed.passKey ? "passKey" : null);
  const refocus = (field: keyof typeof fieldRefs | null) =>
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (field && (!at || at === document.body)) fieldRefs[field].current?.focus();
    });

  const reset = () => {
    if (!s) return;
    const first = firstEdited();
    setApiKey("");
    setCivitaiKey("");
    setIdle(String(s.idleMinutes));
    setIdleSettled(true);
    setPassKey(s.passApiKeyToPod);
    if (first) fieldRefs[first].current?.focus();
    toast.info("Changes discarded"); // UI-047
  };

  const doSave = async (anyway?: (keyof Unverified)[]) => {
    const first = firstEdited();
    setSaving("saving");
    setSaveAnyway(null);
    setRejected(false);
    try {
      const input: api.SaveSettingsInput = {};
      if (apiKey) input.apiKey = apiKey;
      if (civitaiKey) input.civitaiKey = civitaiKey;
      if (changed.idle && idleN != null) input.idleMinutes = idleN;
      if (changed.passKey) input.passApiKeyToPod = passKey;
      await api.saveSettings(input); // returns the new view; reload keeps one source of truth
      // A key saved after a passed check is verified; one saved anyway is not (UI-049).
      const next = { ...unverified };
      if (apiKey) next.runpod = !!anyway?.includes("runpod");
      if (civitaiKey) next.civitai = !!anyway?.includes("civitai");
      if (apiKey || civitaiKey) setUnverified(next);
      setApiKey("");
      setCivitaiKey("");
      setReport(null);
      await lib.reloadSettings();
      refocus(first);
      if (changed.passKey && !passKey) {
        toast.notify({
          kind: "info",
          title: "Settings saved · self-stop is off",
          message: "From the next start, a pod keeps billing after this app closes, until the app (or you, in RunPod) stops it.",
          durationMs: 10000,
        });
      } else if (anyway?.length) {
        toast.success("Settings saved · key not verified", "Test connection checks the saved key once the service can be reached.");
      } else {
        toast.success("Settings saved");
      }
    } catch (err) {
      toast.error("Couldn't save settings", err);
    } finally {
      setSaving(false);
    }
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!dirty || idleInvalid || saving) return;
    // A typed key is checked first: a rejected key is never saved over a working one (UX-017).
    if (apiKey || civitaiKey) {
      const typedKinds: (keyof Unverified)[] = [...(apiKey ? (["runpod"] as const) : []), ...(civitaiKey ? (["civitai"] as const) : [])];
      setSaving("checking");
      setRejected(false);
      let keys: KeyTestReport;
      try {
        keys = await api.testApiKeys({ apiKey: apiKey || undefined, civitaiKey: civitaiKey || undefined });
      } catch (err) {
        setSaving(false);
        revealBlock.current = "anyway";
        setSaveAnyway({ message: api.errorMessage(err), keys: typedKinds });
        return;
      }
      setSaving(false);
      const typed = (["runpod", "civitai"] as const).filter((k) => keys[k]?.source === "typed").map((k) => [k, keys[k] as KeyCheck] as const);
      const bad = typed.find(([, c]) => !c.ok && !c.network);
      const unreachable = typed.filter(([, c]) => !c.ok && c.network);
      if (bad) {
        revealBlock.current = "results";
        setRejected(true);
        setReport({ keys, pod: null });
        return;
      }
      if (unreachable.length) {
        revealBlock.current = "anyway";
        setReport({ keys, pod: null });
        setSaveAnyway({ message: unreachable[0][1].message, keys: unreachable.map(([k]) => k) });
        return;
      }
    }
    await doSave();
  };

  const test = async () => {
    setTesting(true);
    setReport(null);
    try {
      const [keys, pod] = await Promise.all([
        api.testApiKeys({ apiKey: apiKey || undefined, civitaiKey: civitaiKey || undefined }),
        apiKey ? Promise.resolve(null) : api.testConnection().catch(() => null),
      ]);
      setReport({ keys, pod });
      // A saved key that passes a test is verified now (UI-049).
      const next = { ...unverified };
      let changedFlags = false;
      for (const k of ["runpod", "civitai"] as const) {
        if (next[k] && keys[k]?.ok && keys[k]?.source === "saved") {
          next[k] = false;
          changedFlags = true;
        }
      }
      if (changedFlags) setUnverified(next);
    } catch (err) {
      toast.error("Couldn't test the keys", err);
    } finally {
      setTesting(false);
    }
  };

  const reveal = async () => {
    setRevealError(null);
    try {
      await api.revealSettingsFile();
    } catch (err) {
      setRevealError(api.errorMessage(err));
    }
  };

  const cost = s?.fallbackCostPerHr ?? 2.49;
  const idleShown = idleN ?? s?.idleMinutes ?? 30;
  const savedIdle = s?.idleMinutes ?? 30;
  const selfStopSaved = s?.passApiKeyToPod !== false;
  const keysTyped = !!apiKey || !!civitaiKey;
  const saveReason = !dirty ? "No changes to save." : idleInvalid ? "Fix the auto-stop minutes to save." : null;
  const imageGpus = s?.gpuTypes?.length ? s.gpuTypes : s?.gpuType ? [s.gpuType] : [];
  // The sticky bar says what is going on, including why a save didn't happen (UI-007, UI-044).
  const barState: { text: string; tone: "warn" | "error" | null } = saving
    ? { text: saving === "checking" ? "Checking the key before saving…" : "Saving…", tone: null }
    : saveAnyway
      ? { text: "Not saved: the key couldn't be checked.", tone: "warn" }
      : rejected
        ? { text: "Not saved: a key was rejected (see the test result).", tone: "error" }
        : idleInvalid && dirty
          ? { text: saveReason ?? "", tone: "error" }
          : { text: "Unsaved changes", tone: null };

  return (
    <div className="page settings-page">
      <div className="page__inner page__inner--narrow">
        <header className="page__head">
          <div>
            <h1 className="page__title">Settings</h1>
            <p className="page__lede">Keys are stored in the macOS Keychain and never shown again.</p>
          </div>
        </header>
        <SectionNav />

        <form ref={formRef} className="card settings" onSubmit={save} aria-labelledby="runpod-title">
          <h2 id="runpod-title" className="card__title">
            <Icon name="cloud" /> <span id="set-runpod">RunPod</span>
          </h2>
          <SecretField
            id="runpod-key"
            label="API key"
            saved={!!s?.hasApiKey}
            unverified={unverified.runpod}
            value={apiKey}
            onChange={setApiKey}
            visible={visible}
            inputRef={fieldRefs.runpod}
            help="RunPod → Settings → API Keys. The app uses it to start and stop your GPU pods. Check it before saving with “Test connection” below."
          />
          <p className="hint">You start and stop the Images and Video pods from the header; generating, Refresh, downloads and deletes start them too (after asking).</p>

          <div className="field">
            <label className="field__label" htmlFor="idle-minutes">
              Auto-stop after N idle minutes
            </label>
            <div className="input-suffix">
              <input
                id="idle-minutes"
                ref={fieldRefs.idle}
                className={`input mono ${showIdleError ? "input--invalid" : ""}`}
                type="number"
                inputMode="numeric"
                min={IDLE_MIN}
                max={IDLE_MAX}
                step={1}
                value={idle}
                onChange={(e) => {
                  setIdle(e.target.value);
                  setIdleSettled(false);
                }}
                onBlur={() => setIdleSettled(true)}
                aria-invalid={showIdleError}
                aria-describedby="idle-error idle-help idle-cost"
              />
              <span className="input-suffix__unit">min</span>
            </div>
            {/* A reserved line: the error doesn't push the help and cost lines around (UI-045). */}
            <p id="idle-error" className="hint hint--error field-error-slot" aria-live="polite">
              {showIdleError && (
                <>
                  <Icon name="alert" size={12} /> Enter a whole number from {IDLE_MIN} to {IDLE_MAX}.
                </>
              )}
            </p>
            <p id="idle-help" className="hint">
              With no jobs or downloads for this long, the app stops that GPU. Default 30.
            </p>
            <p id="idle-cost" className="hint">
              Up to <strong className="mono">~${((idleShown / 60) * cost).toFixed(2)}</strong> of idle time per pod each time you forget to stop it
              {idleInvalid ? ` (at the saved ${idleShown} minutes)` : ""}.
            </p>
          </div>

          <div className="field">
            <label className="switch">
              <input
                ref={fieldRefs.passKey}
                type="checkbox"
                role="switch"
                aria-checked={passKey}
                checked={passKey}
                onChange={(e) => setPassKey(e.target.checked)}
                aria-describedby="pass-key-help"
              />
              <span className="switch__track" aria-hidden />
              <span>Let the pod stop itself when idle</span>
            </label>
            {passKey ? (
              <p id="pass-key-help" className="hint">
                Passes your RunPod API key to each pod so its own watchdog terminates it after {idleShown} idle minutes, even when this app is closed.
                {changed.passKey ? " Not saved yet." : ""}
              </p>
            ) : (
              // A billing risk: the amber notice, not a muted hint (UI-048).
              <p id="pass-key-help" className="notice notice--warn settings__notice">
                <Icon name="alert" size={14} />
                <span>
                  Off: if this app quits or crashes while a pod runs, the pod keeps billing until the app stops it (or you stop it in the RunPod console). Applies to
                  pods started after saving.{changed.passKey ? " Not saved yet." : ""}
                </span>
              </p>
            )}
          </div>

          <h2 className="card__title card__title--sub">
            <Icon name="layers" /> <span id="set-civitai">Civitai</span>
          </h2>
          <SecretField
            id="civitai-key"
            label="Civitai API key (optional)"
            saved={!!s?.hasCivitaiKey}
            unverified={unverified.civitai}
            value={civitaiKey}
            onChange={setCivitaiKey}
            visible={visible}
            inputRef={fieldRefs.civitai}
            help="Used to look up LoRA details from Civitai links. Some models need it to download. civitai.com → Account settings → API keys."
          />

          <div className="settings__actions">
            <button type="button" className="btn" onClick={test} disabled={testing || !!saving}>
              <Icon name="bolt" className={testing ? "pulse-icon" : ""} /> {testing ? "Testing…" : "Test connection"}
            </button>
            {/* Secondary: while there are changes the sticky bar's Save is the one primary (UI-044). */}
            <button type="submit" className={`btn ${saveReason ? "btn--blocked" : ""}`} disabled={!!saveReason || !!saving} aria-describedby="settings-save-why">
              {saving === "checking" ? "Checking the key…" : saving ? "Saving…" : "Save changes"}
            </button>
          </div>
          <p id="settings-save-why" className={`hint settings__dirty ${idleInvalid && dirty ? "hint--error" : ""}`}>
            {saveReason && dirty
              ? saveReason
              : keysTyped
                ? "Test connection checks the key you typed without saving it; Save checks it again first."
                : "Checks your saved keys, and the Images GPU when it's running (it never starts a GPU)."}
          </p>
          {saveAnyway && (
            <div className="notice notice--warn settings__blocked" role="alert">
              <Icon name="alert" />
              <span id="settings-anyway-why">Couldn't check the key: {saveAnyway.message}. It may still be fine. Nothing is saved yet.</span>
              <button
                type="button"
                className="btn btn--sm"
                ref={saveAnywayRef}
                onClick={() => void doSave(saveAnyway.keys)}
                disabled={!!saving}
                aria-describedby="settings-anyway-why"
              >
                Save anyway
              </button>
            </div>
          )}
          {report && <KeyResults report={report.keys} pod={report.pod} boxRef={resultsRef} />}
        </form>

        <section className="card settings config-file" aria-labelledby="config-title">
          <h2 id="config-title" className="card__title">
            <Icon name="gear" /> Set in the settings file
          </h2>
          <p className="hint">These change rarely, so they live in the settings file rather than here. Edit the file while the app is closed.</p>
          <dl className="config-rows">
            <dt>Images GPU priority</dt>
            <dd>
              <ConfigList items={imageGpus.map(shortGpuName)} ordered />
              <span className="hint">The pod gets the first one available · up to ${cost.toFixed(2)}/h while running · key gpuTypes</span>
            </dd>
            <dt>Video GPU priority</dt>
            <dd>
              <ConfigList items={(s?.videoGpuTypes ?? []).map(shortGpuName)} ordered />
              <span className="hint">The video pod (Canada) gets the first one available · key videoGpuTypes</span>
            </dd>
            <dt>Image volume</dt>
            <dd>
              <ConfigList items={s?.volumeNames ?? []} />
              <span className="hint">key volumeNames</span>
            </dd>
            <dt>Video volume</dt>
            <dd>
              <ConfigList items={s?.videoVolumeNames ?? []} />
              <span className="hint">key videoVolumeNames</span>
            </dd>
            <dt>Worker code</dt>
            <dd>
              <span className="mono">{s?.workerRef ?? "main"}</span>
              <span className="hint">
                Git ref the pod loads its code from at each start · key workerRef (image: <span className="mono">{s?.podImage ?? "—"}</span>, key podImage)
              </span>
            </dd>
          </dl>
          <div className="vault-settings__row">
            {s?.settingsPath && (
              <span className="mono hint vault-settings__grow config-file__path" title={s.settingsPath}>
                {s.settingsPath}
              </span>
            )}
            <button type="button" className="btn" onClick={() => void reveal()}>
              <Icon name="search" /> Show settings file
            </button>
            <button
              type="button"
              className="btn"
              title="Diagnostics log: GPU, job stages and timings, errors. Never prompts or vault content."
              onClick={() => void api.revealLogs().catch((err) => setRevealError(api.errorMessage(err)))}
            >
              <Icon name="search" /> Show logs
            </button>
          </div>
          {revealError && <p className="hint hint--error">{revealError}</p>}
        </section>

        <VaultSettings />

        <section id="set-costs" className="card note" aria-labelledby="cost-title">
          <h2 id="cost-title" className="card__title">
            <Icon name="info" /> Costs
          </h2>
          <ul className="plain note__list">
            <li>
              Each GPU pod (Images, Video) is billed ~${cost.toFixed(2)}/h or less (depends on which GPU it gets) while it runs — from Start until you press Stop or it auto-stops.
              The header shows each pod's running time and cost so far.
            </li>
            <li>
              The app stops a pod after {savedIdle} idle minutes (no jobs, downloads or deletes) while it's open. A GPU started only for a Refresh, download or delete stops as
              soon as that finishes, and cancelling the only job while its GPU starts stops it too.
            </li>
            {selfStopSaved ? (
              <li>The pod also stops itself after {savedIdle} idle minutes, even if the app is closed.</li>
            ) : (
              <li className="note__warn">
                <Icon name="alert" size={13} /> <strong>Self-stop is off:</strong> a pod does NOT stop itself when this app is closed — it keeps billing until the app stops it.
                Press Stop before quitting.
              </li>
            )}
            <li>Generating, Refresh, downloads and deletes start the GPU when it's stopped, after asking. Starting takes a few minutes.</li>
            <li>Storage on the network volumes is billed monthly, whether a GPU runs or not.</li>
          </ul>
        </section>

        {dirty && (
          <div className={`settings-bar ${barState.tone ? `settings-bar--${barState.tone}` : ""}`} role="region" aria-label="Unsaved settings" data-sticky-bar>
            <span className="settings-bar__status" id="settings-bar-status">
              <span className="settings-bar__dot" aria-hidden /> {barState.text}
            </span>
            <span className="settings-bar__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={reset} disabled={!!saving}>
                Discard
              </button>
              {saveAnyway ? (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => void doSave(saveAnyway.keys)}
                  disabled={!!saving}
                  aria-describedby="settings-bar-status"
                >
                  Save anyway
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => void save()}
                  disabled={!!saveReason || !!saving}
                  aria-describedby="settings-bar-status"
                >
                  {saving === "checking" ? "Checking…" : saving ? "Saving…" : "Save changes"}
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
