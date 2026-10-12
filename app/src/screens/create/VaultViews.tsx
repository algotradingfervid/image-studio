// Vault views for the Gallery's Vault tab and the Create panel (spec v6):
// lock screen, first-use "Create vault" form, migration progress/result, and the Save-to switch.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorCode, errorMessage, VAULT_ERASE_WORD, VAULT_PASSWORD_MIN, type Destination, type MigrationProgress } from "../../api";
import { Dialog, ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { pct } from "../../lib/format";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import { countGallery, type GalleryTotals } from "./Gallery";

/** Passwords too common to protect anything (UX-075); checked case-insensitively. */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "passw0rd", "12345678", "123456789", "1234567890", "87654321",
  "11111111", "00000000", "qwertyui", "qwerty12", "qwerty123", "iloveyou", "abcdefgh", "abc12345", "letmein1",
  "sunshine", "princess", "football", "baseball", "superman", "trustno1", "welcome1", "admin123", "changeme",
  "imagestudio", "image studio", "image-studio", "vaultvault", "secret123",
]);

type Strength = { level: 0 | 1 | 2 | 3; label: string };
/** A rough strength estimate: length and character variety, common passwords blocked. */
function strengthOf(pw: string): Strength {
  if (!pw) return { level: 0, label: "" };
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return { level: 0, label: "This password is too common." };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const unique = new Set(pw).size;
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (classes >= 3) score++;
  if (unique < 5) score = 0;
  if (score === 0) return { level: 1, label: "Weak — easy to guess. Use 3–4 random words." };
  if (score === 1) return { level: 2, label: "OK — longer is stronger." };
  return { level: 3, label: "Strong." };
}

/** Puts focus on the Vault tab of the gallery (after the lock screen or the migration card goes away, UI-006). */
export function focusVaultTab() {
  requestAnimationFrame(() => document.getElementById("gallery-tab-vault")?.focus());
}

/** The password form shared by the Vault tab's lock screen and the unlock dialog. */
function UnlockForm({
  autoFocus = true,
  onUnlocked,
  inputRef: givenRef,
}: {
  autoFocus?: boolean;
  onUnlocked?: () => void;
  /** The password input (the unlock dialog focuses it on open, UI-061). */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const vault = useVault();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = givenRef ?? ownRef;
  const id = useId();
  const reason = vault.lockReason;
  const mins = vault.status?.autoLockMinutes ?? 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
      setPassword("");
      onUnlocked?.();
    } catch (err) {
      const code = errorCode(err);
      setError(
        code === "WRONG_PASSWORD"
          ? "Wrong password. Try again."
          : code === "NO_VAULT"
            ? "There is no vault yet."
            : `Couldn't unlock: ${errorMessage(err)}`,
      );
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {reason === "idle" && (
        <p className="vault-gate__reason" role="status">
          <Icon name="info" size={14} /> Locked after {mins} minute{mins === 1 ? "" : "s"} without activity. Change this in Settings → Vault.
        </p>
      )}
      <form className="vault-gate__form" onSubmit={submit} aria-label="Unlock the vault">
        <PasswordField
          id={`${id}-pw`}
          label="Password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (error) setError(null);
          }}
          disabled={busy}
          invalid={!!error}
          describedBy={`${id}-status`}
          autoFocus={autoFocus}
          inputRef={inputRef}
        />
        <button type="submit" className="btn btn--primary vault-gate__submit" disabled={!password || busy}>
          {busy ? <Icon name="refresh" className="spin" /> : <Icon name="unlock" />}
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>
      <p id={`${id}-status`} className={`vault-gate__status ${error ? "is-error" : ""}`} role={error ? "alert" : "status"} aria-live="polite">
        {error ? (
          <>
            <Icon name="alert" size={14} /> {error}
          </>
        ) : busy ? (
          "Deriving the key — this takes about a second."
        ) : (
          `Auto-locks after ${mins} minute${mins === 1 ? "" : "s"} without activity (Settings → Vault).`
        )}
      </p>
      <p className="vault-gate__forgot">
        Forgot the password? It can't be recovered.{" "}
        <button type="button" className="link-btn link-btn--danger" onClick={() => vault.requestErase()}>
          Erase the vault and start over…
        </button>
      </p>
    </>
  );
}

/** Unlock from anywhere (the "saved to the vault · Unlock" notice when the Vault tab isn't on screen). */
export function VaultUnlockDialog({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked?: () => void }) {
  const pwRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={onClose} title="Unlock the vault" className="vault-unlock-dialog" initialFocusRef={pwRef}>
      {open && (
        <div className="vault-unlock-dialog__body">
          <UnlockForm
            autoFocus={false}
            inputRef={pwRef}
            onUnlocked={() => {
              onClose();
              onUnlocked?.();
            }}
          />
        </div>
      )}
    </Dialog>
  );
}

/** Password input with a show/hide toggle (same look as the Settings key fields). */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  autoFocus,
  autoComplete = "current-password",
  inputRef,
  onBlur,
  onFocus,
  readOnly,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onBlur?: () => void;
  onFocus?: () => void;
  /** While a request runs: not editable but keeps focus (a disabled field drops it to <body>, UI-006). */
  readOnly?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="input-icon input-icon--end">
        <Icon name="key" />
        <input
          id={id}
          ref={inputRef}
          className="input vault-input"
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          spellCheck={false}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onFocus={onFocus}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm input-icon__end"
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          onClick={() => setShow((s) => !s)}
          disabled={!value || disabled}
        >
          <Icon name="eye" />
        </button>
      </div>
    </div>
  );
}

/** The Vault tab while locked: password → Unlock. */
export function VaultLockScreen() {
  return (
    <div className="vault-gate">
      <div className="vault-gate__art" aria-hidden>
        <Icon name="lock" size={28} />
      </div>
      <h3>Vault is locked</h3>
      <p className="vault-gate__lede">Vault items stay hidden everywhere in the app until you unlock it with your password.</p>
      {/* The lock screen goes away on unlock: focus moves to the Vault tab, not <body> (UI-006). */}
      <UnlockForm onUnlocked={focusVaultTab} />
    </div>
  );
}

/** The Vault tab on first use: password + confirm, the no-recovery warning, then migration. */
export function VaultCreate({ generalCount, generalMore }: { generalCount: number; generalMore: boolean }) {
  const vault = useVault();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Fields left at least once: errors show on blur, not on every keystroke (UX-061). */
  const [touched, setTouched] = useState({ pw: false, confirm: false });
  /** Confirm has focus: while it's being retyped, a mismatch waits for its full length (UI-067). */
  const [confirmFocused, setConfirmFocused] = useState(false);
  const id = useId();

  // Real totals instead of the loaded page's "24+" (UX-019).
  const [totals, setTotals] = useState<GalleryTotals | null>(null);
  useEffect(() => {
    let alive = true;
    countGallery()
      .then((t) => alive && setTotals(t))
      .catch(() => {
        /* falls back to the loaded count */
      });
    return () => {
      alive = false;
    };
  }, []);

  const strength = strengthOf(password);
  const common = password.length > 0 && strength.level === 0;
  const short = password.length > 0 && password.length < VAULT_PASSWORD_MIN;
  const showShort = short && touched.pw;
  const mismatch = confirm.length > 0 && confirm !== password && (confirm.length >= password.length || (touched.confirm && !confirmFocused));
  const valid = password.length >= VAULT_PASSWORD_MIN && !common && confirm === password && ack;
  // Why Create is disabled, next to it (UI-067).
  const blockedWhy = busy
    ? null
    : password.length < VAULT_PASSWORD_MIN
      ? `Choose a password of at least ${VAULT_PASSWORD_MIN} characters.`
      : common
        ? "Choose a less common password."
        : confirm !== password
          ? "Type the same password in Confirm password."
          : !ack
            ? "Tick the box above to continue."
            : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.create(password);
      setPassword("");
      setConfirm("");
    } catch (err) {
      const code = errorCode(err);
      setError(
        code === "WEAK_PASSWORD"
          ? `Use at least ${VAULT_PASSWORD_MIN} characters.`
          : code === "VAULT_EXISTS"
            ? "A vault already exists."
            : `Couldn't create the vault: ${errorMessage(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const n = totals?.items ?? generalCount;
  const kinds = totals && totals.items ? ` (${totals.images} image${totals.images === 1 ? "" : "s"}, ${totals.videos} video${totals.videos === 1 ? "" : "s"})` : "";
  const what =
    n > 0 ? `All ${n}${!totals && generalMore ? "+" : ""} item${n === 1 ? "" : "s"}${kinds} in your gallery` : totals ? "Anything you create before then" : "Everything already in your gallery";

  return (
    <form className="vault-create card" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="card__title">
        <Icon name="shield" /> Create your vault
      </h3>
      <p className="vault-create__lede">
        Vault items are encrypted on this Mac and appear nowhere in the app until you unlock it. {what} — with their posters and start images — move
        into the vault when you create it. New creations go wherever <strong>Save to</strong> says.
      </p>
      <div className="field-row">
        <div>
          <PasswordField
            id={`${id}-pw`}
            label="Password"
            value={password}
            onChange={setPassword}
            disabled={busy}
            invalid={showShort || common}
            describedBy={`${id}-pw-help ${id}-pw-strength`}
            autoComplete="new-password"
            autoFocus
            onBlur={() => setTouched((t) => ({ ...t, pw: true }))}
          />
          <p id={`${id}-pw-help`} className={`hint ${showShort ? "hint--error" : ""}`}>
            At least {VAULT_PASSWORD_MIN} characters{short ? ` — ${VAULT_PASSWORD_MIN - password.length} more` : ""}.
          </p>
          {password && !short && (
            <p id={`${id}-pw-strength`} className={`hint vault-strength vault-strength--${strength.level} ${common ? "hint--error" : ""}`} aria-live="polite">
              <span className="vault-strength__bar" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              {strength.label}
            </p>
          )}
        </div>
        <div>
          <PasswordField
            id={`${id}-confirm`}
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            disabled={busy}
            invalid={mismatch}
            describedBy={`${id}-confirm-help`}
            autoComplete="new-password"
            onFocus={() => setConfirmFocused(true)}
            onBlur={() => {
              setConfirmFocused(false);
              setTouched((t) => ({ ...t, confirm: true }));
            }}
          />
          <p id={`${id}-confirm-help`} className={`hint ${mismatch ? "hint--error" : ""}`}>
            {mismatch ? "The passwords don't match." : confirm && confirm === password ? "Matches." : "Type it again."}
          </p>
        </div>
      </div>

      <div className="vault-warning" role="note">
        <Icon name="alert" size={18} />
        <div>
          <strong>No recovery — if you forget this password, the content is gone.</strong>
          <p>
            There is no reset, hint or backup key. Nobody, including this app, can decrypt the vault without it. If you forget it, the only way out is to erase the
            vault and start over, which deletes everything in it.
          </p>
          <label className="vault-warning__ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy} />
            <span>I understand that a forgotten password can't be recovered.</span>
          </label>
        </div>
      </div>

      {error && (
        <p className="vault-gate__status is-error" role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}
      <div className="btn-row btn-row--end">
        <button type="submit" className="btn btn--primary" disabled={!valid || busy} aria-describedby={blockedWhy ? `${id}-why` : undefined}>
          {busy ? <Icon name="refresh" className="spin" /> : <Icon name="lock" />}
          {busy ? "Creating the vault…" : n > 0 && totals ? `Create vault & move ${n} item${n === 1 ? "" : "s"}` : "Create vault & move my gallery"}
        </button>
      </div>
      {blockedWhy && (
        <p id={`${id}-why`} className="hint vault-create__why">
          {blockedWhy}
        </p>
      )}
    </form>
  );
}

const PHASE_LABEL: Record<string, string> = {
  encrypting: "Encrypting",
  verifying: "Verifying the encrypted copies",
  cleaning: "Removing the originals",
  done: "Done",
  error: "Stopped",
};

/** Migration progress (create / resume) and its result. */
export function MigrationView({ progress, onDone }: { progress: MigrationProgress; onDone: () => void }) {
  const done = progress.phase === "done";
  const failed = progress.phase === "error";
  const finished = done || failed;
  const c = progress.counts;
  const rows: [string, number][] = [
    ["Images", c.images],
    ["Videos", c.videos],
    ["Posters", c.posters],
    ["Start images", c.startImages],
    ["References", c.references],
  ];
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (finished) doneRef.current?.focus();
  }, [finished]);
  // The card goes away: focus moves to the Vault tab, not <body> (UI-006).
  const close = () => {
    onDone();
    focusVaultTab();
  };
  // Save to stays on General after the move (UI-062): offer to switch it. Read from the Create
  // panel's Save-to control (null when it isn't on screen: no offer).
  const [saveToVault, setSaveToVault] = useState<boolean | null>(null);
  useEffect(() => {
    if (!done) return;
    const radio = document.querySelector<HTMLElement>('.save-to [role="radio"][data-dest="vault"]');
    setSaveToVault(radio ? radio.getAttribute("aria-checked") === "true" : null);
  }, [done]);
  const switchSaveTo = () => {
    document.querySelector<HTMLElement>('.save-to [role="radio"][data-dest="vault"]')?.click();
    setSaveToVault(true);
  };

  return (
    <section className={`vault-migration card ${failed ? "is-error" : ""}`} aria-labelledby="vault-migration-title" aria-busy={!finished}>
      <h3 id="vault-migration-title" className="card__title">
        <Icon name={done ? "check" : failed ? "alert" : "shield"} />
        {done
          ? `Moved ${progress.done} item${progress.done === 1 ? "" : "s"} into the vault`
          : failed
            ? "The move into the vault stopped"
            : "Moving your gallery into the vault…"}
        {finished && (
          <button type="button" className="icon-btn icon-btn--sm vault-migration__close" aria-label="Dismiss" onClick={close}>
            <Icon name="x" />
          </button>
        )}
      </h3>
      {done && (
        <p className="vault-migration__summary">
          {progress.done} item{progress.done === 1 ? "" : "s"} ({c.images} image{c.images === 1 ? "" : "s"}, {c.videos} video{c.videos === 1 ? "" : "s"})
          {c.posters + c.startImages + c.references > 0 &&
            ` · plus ${[
              c.posters && `${c.posters} poster${c.posters === 1 ? "" : "s"}`,
              c.startImages && `${c.startImages} start image${c.startImages === 1 ? "" : "s"}`,
              c.references && `${c.references} reference${c.references === 1 ? "" : "s"}`,
            ]
              .filter(Boolean)
              .join(", ")}`}
        </p>
      )}
      {!finished && (
        <div className="vault-migration__progress">
          <ProgressBar label="Migration progress" value={progress.total ? pct(progress.done, progress.total) : 0} indeterminate={!progress.total} />
          <div className="job-card__caption mono">
            <span>
              {PHASE_LABEL[progress.phase] ?? progress.phase} · {progress.done} of {progress.total}
            </span>
            <span>{progress.total ? `${Math.round(pct(progress.done, progress.total))}%` : ""}</span>
          </div>
        </div>
      )}
      <dl className="vault-migration__counts" aria-label="Moved so far">
        {rows.map(([label, n]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{n}</dd>
          </div>
        ))}
        <div className={progress.errors ? "is-error" : ""}>
          <dt>Errors</dt>
          <dd className="mono">{progress.errors}</dd>
        </div>
      </dl>
      {progress.error && <p className="vault-gate__status is-error">{progress.error}</p>}
      <p className="hint">
        {finished
          ? failed || progress.errors
            ? "Items that failed stay where they were; the move resumes the next time you unlock."
            : "Each original was deleted only after its encrypted copy was verified."
          : "Each original is deleted only after its encrypted copy is verified. If the app quits, the move resumes on the next unlock."}
      </p>
      {done && saveToVault === false && (
        <p className="notice notice--warn notice--inline vault-migration__saveto">
          <Icon name="info" size={14} />
          <span>New creations still save to General, unencrypted.</span>
          <button type="button" className="link-btn" onClick={switchSaveTo}>
            Save new creations to the vault
          </button>
        </p>
      )}
      {done && saveToVault && <p className="hint">New creations save to the vault (Save to, in the Create panel).</p>}
      {finished && (
        <div className="btn-row btn-row--end">
          {/* Secondary: the Create panel's Generate stays the one filled primary on screen (UI-074). */}
          <button type="button" className="btn" onClick={close} ref={doneRef}>
            Done
          </button>
        </div>
      )}
    </section>
  );
}

/** Create panel: where new outputs are saved (both modes share the value). */
export function SaveToSwitch({
  value,
  onChange,
  forcedReason,
  onCreateVault,
}: {
  value: Destination;
  onChange: (d: Destination) => void;
  /** Set when a vault start image / reference is in use: the output must stay in the vault. */
  forcedReason?: string | null;
  /** No vault yet: "Set up a vault…" opens Gallery → Vault. */
  onCreateVault: () => void;
}) {
  const vault = useVault();
  const id = useId();
  // After an erase the remembered choice goes back to General, so a vault created later doesn't
  // silently receive new creations (the Create screen persists what onChange gets).
  const erased = useRef(vault.eraseEpoch);
  useEffect(() => {
    if (vault.eraseEpoch === erased.current) return;
    erased.current = vault.eraseEpoch;
    onChange("general");
  }, [vault.eraseEpoch, onChange]);
  if (!vault.exists) {
    return (
      <div className="save-to">
        <div className="save-to__row">
          <span className="section__title">Save to</span>
          <span className="save-to__only">
            General
            <button type="button" className="link-btn save-to__setup" onClick={onCreateVault}>
              <Icon name="lock" size={12} /> Set up a vault…
            </button>
          </span>
        </div>
      </div>
    );
  }
  const options: Destination[] = forcedReason ? ["vault"] : ["general", "vault"];
  const note = forcedReason
    ? forcedReason
    : value === "vault"
      ? vault.unlocked
        ? "Encrypted the moment they arrive."
        : "Locked — sealed on arrival;"
      : null;
  const unlockLink = !forcedReason && value === "vault" && !vault.unlocked;
  return (
    <div className="save-to">
      <div className="save-to__row">
        <span className="section__title" id={`${id}-label`}>
          Save to
        </span>
        <div
          className="segmented save-to__seg"
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={note ? `${id}-note` : undefined}
          onKeyDown={radioKeys(options, value, onChange)}
        >
          {(["general", "vault"] as Destination[]).map((d) => {
            const on = d === value;
            const disabled = d === "general" && !!forcedReason;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={on}
                data-dest={d}
                tabIndex={on ? 0 : -1}
                disabled={disabled}
                title={disabled ? (forcedReason ?? undefined) : undefined}
                className={on ? "is-selected" : ""}
                onClick={() => onChange(d)}
              >
                {d === "vault" && <Icon name={vault.unlocked ? "lockOpen" : "lock"} size={13} />}
                {d === "general" ? "General" : "Vault"}
                {d === "vault" && vault.unlocked && <span className="save-to__state"> · unlocked</span>}
              </button>
            );
          })}
        </div>
      </div>
      {note && (
        <p id={`${id}-note`} className="hint save-to__note">
          {note}
          {unlockLink && (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={vault.requestUnlock}>
                unlock
              </button>{" "}
              to view.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Focus the first on-screen "start a vault" control after an erase (the opener is gone, UI-006).
 * Retried for a few frames: the control renders, and the modal closes (making the page focusable
 * again), after this is called.
 */
function focusVaultStart(frames = 20) {
  requestAnimationFrame(() => {
    const el = [...document.querySelectorAll<HTMLElement>("[data-vault-start], .vault-create input[type=password]")].find((x) => x.getClientRects().length > 0);
    el?.focus();
    if ((!el || document.activeElement !== el) && frames > 0) focusVaultStart(frames - 1);
  });
}

/**
 * "Erase vault and start over" (UI-059): the only way out of a forgotten password. Typed
 * confirmation only: the danger button stays disabled until the user types "erase"; focus starts
 * on Cancel. Works locked or unlocked and never shows anything from the vault (the item count
 * only while it's unlocked, when the user can see the items anyway).
 */
export function VaultEraseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const vault = useVault();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
    }
  }, [open]);

  // A running migration or move would be cut in half: the core refuses (VAULT_BUSY), so say so up front.
  const moving = !!vault.migration && vault.migration.phase !== "done" && vault.migration.phase !== "error";
  const busyMsg = "Wait for the move into the vault to finish.";
  const ok = typed.trim().toLowerCase() === VAULT_ERASE_WORD && !moving;
  const count = vault.unlocked ? (vault.status?.itemCount ?? vault.items.length) : null;
  const what = count == null ? "everything in the vault" : `all ${count} item${count === 1 ? "" : "s"} in the vault`;

  const erase = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.erase(VAULT_ERASE_WORD);
      onClose();
      toast.success("Vault erased", "Everything in it is deleted. You can create a new vault from Gallery → Vault.");
      focusVaultStart();
    } catch (err) {
      setError(errorCode(err) === "VAULT_BUSY" ? busyMsg : `Couldn't erase the vault: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Erase the vault and start over?"
      className="vault-erase-dialog"
      initialFocusRef={cancelRef}
      footer={
        <>
          <button type="button" className="btn" ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn--danger" disabled={!ok || busy} aria-describedby={`${id}-why`}>
            {busy ? <Icon name="refresh" className="spin" /> : <Icon name="trash" />}
            {busy ? "Erasing…" : "Erase vault"}
          </button>
        </>
      }
    >
      {open && (
        <form id={`${id}-form`} className="vault-erase" onSubmit={erase}>
          <div className="vault-warning" role="note">
            <Icon name="alert" size={18} />
            <div>
              <strong>This permanently deletes {what} and the vault's key.</strong>
              <p>
                Images, videos, their prompts and settings are deleted without being shown or decrypted. Nothing can be recovered. Your General gallery isn't
                touched. Afterwards you can create a new vault with a new password.
              </p>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-word`}>
              Type <strong className="mono">{VAULT_ERASE_WORD}</strong> to confirm
            </label>
            <input
              id={`${id}-word`}
              className="input mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={typed}
              readOnly={busy}
              onChange={(e) => setTyped(e.target.value)}
              aria-describedby={`${id}-why`}
            />
          </div>
          <p id={`${id}-why`} className={`hint ${error || moving ? "hint--error" : ""}`} role={error || moving ? "alert" : undefined}>
            {error || moving ? (
              <>
                <Icon name="alert" size={12} /> {error ?? busyMsg}
              </>
            ) : ok ? (
              "Erase vault deletes it now."
            ) : (
              `Erase vault is enabled once you type “${VAULT_ERASE_WORD}”.`
            )}
          </p>
        </form>
      )}
    </Dialog>
  );
}
