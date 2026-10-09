// Vault views for the Gallery's Vault tab and the Create panel (spec v6):
// lock screen, first-use "Create vault" form, migration progress/result, and the Save-to switch.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorCode, errorMessage, VAULT_PASSWORD_MIN, type Destination, type MigrationProgress } from "../../api";
import { ProgressBar } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { radioKeys } from "../../components/radio";
import { pct } from "../../lib/format";
import { useVault } from "../../state/vault";

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
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
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
  const vault = useVault();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
      setPassword("");
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
    <div className="vault-gate">
      <div className="vault-gate__art" aria-hidden>
        <Icon name="lock" size={28} />
      </div>
      <h3>Vault is locked</h3>
      <p className="vault-gate__lede">Vault items stay hidden everywhere in the app until you unlock it with your password.</p>
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
          autoFocus
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
          "Auto-locks after a period without activity (Settings → Vault)."
        )}
      </p>
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
  const id = useId();

  const short = password.length > 0 && password.length < VAULT_PASSWORD_MIN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = password.length >= VAULT_PASSWORD_MIN && confirm === password && ack;

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

  const what = generalCount > 0 ? `All ${generalCount}${generalMore ? "+" : ""} items in your gallery` : "Everything already in your gallery";

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
            invalid={short}
            describedBy={`${id}-pw-help`}
            autoComplete="new-password"
            autoFocus
          />
          <p id={`${id}-pw-help`} className={`hint ${short ? "hint--error" : ""}`}>
            At least {VAULT_PASSWORD_MIN} characters{short ? ` — ${VAULT_PASSWORD_MIN - password.length} more` : ""}.
          </p>
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
          <p>There is no reset, hint or backup key. Nobody, including this app, can decrypt the vault without it.</p>
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
        <button type="submit" className="btn btn--primary" disabled={!valid || busy}>
          {busy ? <Icon name="refresh" className="spin" /> : <Icon name="lock" />}
          {busy ? "Creating the vault…" : "Create vault & move my gallery"}
        </button>
      </div>
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

  return (
    <section className={`vault-migration card ${failed ? "is-error" : ""}`} aria-labelledby="vault-migration-title" aria-busy={!finished}>
      <h3 id="vault-migration-title" className="card__title">
        <Icon name={done ? "check" : failed ? "alert" : "shield"} />
        {done
          ? `Moved ${progress.done} item${progress.done === 1 ? "" : "s"} into the vault`
          : failed
            ? "The move into the vault stopped"
            : "Moving your gallery into the vault…"}
      </h3>
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
      {finished && (
        <div className="btn-row btn-row--end">
          <button type="button" className="btn btn--primary" onClick={onDone} ref={doneRef}>
            Show the vault
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
  /** No vault yet: "Create a vault first" opens Gallery → Vault. */
  onCreateVault: () => void;
}) {
  const vault = useVault();
  const id = useId();
  if (!vault.exists) {
    return (
      <div className="save-to">
        <div className="save-to__row">
          <span className="section__title">Save to</span>
          <span className="save-to__only">
            General
            <button type="button" className="link-btn" onClick={onCreateVault}>
              <Icon name="lock" size={12} /> Create a vault first
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
        : "Vault is locked — outputs are sealed on arrival and appear after you unlock."
      : null;
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
                tabIndex={on ? 0 : -1}
                disabled={disabled}
                title={disabled ? (forcedReason ?? undefined) : undefined}
                className={on ? "is-selected" : ""}
                onClick={() => onChange(d)}
              >
                {d === "vault" && <Icon name={vault.unlocked ? "unlock" : "lock"} size={13} />}
                {d === "general" ? "General" : "Vault"}
              </button>
            );
          })}
        </div>
      </div>
      {note && (
        <p id={`${id}-note`} className="hint save-to__note">
          {note}
        </p>
      )}
    </div>
  );
}
