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
}: {
  id: string;
  label: string;
  saved: boolean;
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
          saved && (
            <span className="badge badge--ok">
              <Icon name="lock" size={11} /> Saved in Keychain
            </span>
          )
        )}
      </div>
      <div className="input-icon input-icon--end">
        <Icon name="key" />
        <input
          id={id}
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
function KeyResults({ report, pod }: { report: KeyTestReport; pod: ConnectionTest | null }) {
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
    <ul className="plain key-results" role="status" aria-live="polite">
      {row("RunPod", report.runpod, podLine)}
      {row("Civitai", report.civitai)}
      {!report.runpod && !report.civitai && <li className="hint">No keys to test — paste a key first.</li>}
    </ul>
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

/** Vault (spec v6): auto-lock minutes (only while unlocked), change password, lock now. */
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
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    if (st) setMinutes(String(st.autoLockMinutes));
  }, [st?.autoLockMinutes, st?.unlocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!st && !st.unlocked;
  const minN = parseAutoLock(minutes);
  const minDirty = !!st && minN !== st.autoLockMinutes;

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
    setPwError(null);
    try {
      await vault.changePassword(oldPw, newPw);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      toast.success("Vault password changed", "Use the new password from now on — the old one no longer works.");
    } catch (err) {
      const code: string | null = api.errorCode(err);
      setPwError(
        code === "WRONG_PASSWORD"
          ? "The current password is wrong."
          : code === "WEAK_PASSWORD"
            ? `Use at least ${api.VAULT_PASSWORD_MIN} characters.`
            : code === "VAULT_LOCKED"
              ? "The vault locked. Unlock it and try again."
              : api.errorMessage(err).startsWith("SAME_PASSWORD")
                ? "Choose a password different from the current one."
                : api.errorMessage(err),
      );
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
          <button type="button" className="btn" onClick={goToVaultTab}>
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
                  className={`input mono ${minN == null && !locked ? "input--invalid" : ""}`}
                  type="number"
                  inputMode="numeric"
                  min={api.VAULT_AUTOLOCK_MIN}
                  max={api.VAULT_AUTOLOCK_MAX}
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  disabled={locked}
                  aria-invalid={minN == null}
                  aria-describedby="vault-autolock-help"
                />
                <span className="input-suffix__unit">min</span>
              </div>
              <button type="submit" className="btn" disabled={locked || minN == null || !minDirty || savingMin}>
                {savingMin ? "Saving…" : "Save"}
              </button>
            </div>
            <p id="vault-autolock-help" className={`hint ${minN == null && !locked ? "hint--error" : ""}`}>
              {locked
                ? "Unlock the vault to change auto-lock."
                : minN == null
                  ? `Enter a whole number from ${api.VAULT_AUTOLOCK_MIN} to ${api.VAULT_AUTOLOCK_MAX}.`
                  : "The vault also locks when the app quits and when the Mac sleeps or locks its screen. Default 10."}
            </p>
          </form>

          {st.unlocked ? (
            <>
              <h3 className="card__title card__title--sub">
                <Icon name="key" /> Change password
              </h3>
              <form onSubmit={changePw} aria-label="Change the vault password">
                <PasswordField id="vault-old-pw" label="Current password" value={oldPw} onChange={setOldPw} disabled={pwBusy} />
                <div className="field-row vault-settings__pw">
                  <div>
                    <PasswordField
                      id="vault-new-pw"
                      label="New password"
                      value={newPw}
                      onChange={setNewPw}
                      disabled={pwBusy}
                      invalid={short || same}
                      describedBy="vault-new-pw-help"
                      autoComplete="new-password"
                    />
                    <p id="vault-new-pw-help" className={`hint ${short || same ? "hint--error" : ""}`}>
                      {same ? "Choose a password different from the current one." : `At least ${api.VAULT_PASSWORD_MIN} characters.`}
                    </p>
                  </div>
                  <div>
                    <PasswordField
                      id="vault-confirm-pw"
                      label="Confirm new password"
                      value={confirmPw}
                      onChange={setConfirmPw}
                      disabled={pwBusy}
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
                <p className="hint">There is still no recovery: if you forget the new password, the content is gone.</p>
                <div className="settings__actions">
                  <button type="submit" className="btn btn--primary" disabled={!pwValid || pwBusy}>
                    {pwBusy ? <Icon name="refresh" className="spin" /> : null}
                    {pwBusy ? "Changing…" : "Change password"}
                  </button>
                </div>
              </form>
            </>
          ) : null}

          {/* Same place either way, so the layout doesn't jump under the pointer (UX-071). */}
          <h3 className="card__title card__title--sub">
            <Icon name={st.unlocked ? "lock" : "unlock"} /> {st.unlocked ? "Lock" : "Unlock"}
          </h3>
          {st.unlocked ? (
            <div className="vault-settings__row">
              <p className="hint vault-settings__grow">Locking wipes the key and every decrypted item from memory. Vault items disappear until you unlock again.</p>
              <button type="button" className="btn" onClick={() => void lockNow()}>
                <Icon name="lock" /> Lock now
              </button>
            </div>
          ) : (
            <div className="vault-settings__row">
              <p className="hint vault-settings__grow">
                <Icon name="lock" size={12} /> The vault is locked. Unlock it to change its password or auto-lock time.
              </p>
              <button type="button" className="btn" onClick={() => vault.requestUnlock()}>
                <Icon name="unlock" /> Unlock vault…
              </button>
            </div>
          )}
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
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return (
    <nav className="section-nav" aria-label="Settings sections">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`section-nav__link ${active === s.id ? "is-active" : ""}`}
          aria-current={active === s.id ? "true" : undefined}
          onClick={() => {
            setActive(s.id);
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

export function SettingsScreen() {
  const lib = useLibrary();
  const toast = useToast();
  const s = lib.settings;
  const formRef = useRef<HTMLFormElement>(null);
  const visible = useOnScreen(formRef);
  const [apiKey, setApiKey] = useState("");
  const [civitaiKey, setCivitaiKey] = useState("");
  const [idle, setIdle] = useState("30");
  const [passKey, setPassKey] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState<{ keys: KeyTestReport; pod: ConnectionTest | null } | null>(null);
  /** A typed key couldn't be checked (network): offer to save it anyway. */
  const [saveAnyway, setSaveAnyway] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const reset = () => {
    if (!s) return;
    setApiKey("");
    setCivitaiKey("");
    setIdle(String(s.idleMinutes));
    setPassKey(s.passApiKeyToPod);
  };
  useEffect(() => {
    if (!s) return;
    setIdle(String(s.idleMinutes));
    setPassKey(s.passApiKeyToPod);
  }, [s]);

  const idleN = parseIdle(idle);
  const idleInvalid = idleN == null;
  const changed = {
    idle: !!s && (idleN == null ? idle.trim() !== String(s.idleMinutes) : idleN !== s.idleMinutes),
    passKey: !!s && passKey !== s.passApiKeyToPod,
  };
  const dirty = !!apiKey || !!civitaiKey || changed.idle || changed.passKey;

  // Any edit makes an earlier test result stale.
  useEffect(() => {
    setReport(null);
    setSaveAnyway(null);
  }, [apiKey, civitaiKey]);

  const doSave = async () => {
    setSaving(true);
    setSaveAnyway(null);
    try {
      const input: api.SaveSettingsInput = {};
      if (apiKey) input.apiKey = apiKey;
      if (civitaiKey) input.civitaiKey = civitaiKey;
      if (changed.idle && idleN != null) input.idleMinutes = idleN;
      if (changed.passKey) input.passApiKeyToPod = passKey;
      await api.saveSettings(input); // returns the new view; reload keeps one source of truth
      setApiKey("");
      setCivitaiKey("");
      setReport(null);
      await lib.reloadSettings();
      if (changed.passKey && !passKey) {
        toast.notify({
          kind: "info",
          title: "Settings saved · self-stop is off",
          message: "From the next start, a pod keeps billing after this app closes, until the app (or you, in RunPod) stops it.",
          durationMs: 10000,
        });
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
      setSaving(true);
      let keys: KeyTestReport;
      try {
        keys = await api.testApiKeys({ apiKey: apiKey || undefined, civitaiKey: civitaiKey || undefined });
      } catch (err) {
        setSaving(false);
        setSaveAnyway(api.errorMessage(err));
        return;
      }
      setSaving(false);
      const typed = [keys.runpod, keys.civitai].filter((c): c is KeyCheck => !!c && c.source === "typed");
      const rejected = typed.find((c) => !c.ok && !c.network);
      const unreachable = typed.find((c) => !c.ok && c.network);
      if (rejected) {
        setReport({ keys, pod: null });
        toast.error("Not saved", "A key you typed was rejected — see the test result.");
        return;
      }
      if (unreachable) {
        setReport({ keys, pod: null });
        setSaveAnyway(unreachable.message);
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

  return (
    <div className="page">
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
            value={apiKey}
            onChange={setApiKey}
            visible={visible}
            help="RunPod → Settings → API Keys. The app uses it to start and stop your GPU pods. Test it before saving with “Test keys”."
          />
          <p className="hint">You start and stop the Images and Video pods from the header; generating, Refresh, downloads and deletes start them too (after asking).</p>

          <div className="field">
            <label className="field__label" htmlFor="idle-minutes">
              Auto-stop after N idle minutes
            </label>
            <div className="input-suffix">
              <input
                id="idle-minutes"
                className={`input mono ${idleInvalid ? "input--invalid" : ""}`}
                type="number"
                inputMode="numeric"
                min={IDLE_MIN}
                max={IDLE_MAX}
                step={1}
                value={idle}
                onChange={(e) => setIdle(e.target.value)}
                aria-invalid={idleInvalid}
                aria-describedby="idle-help idle-cost"
              />
              <span className="input-suffix__unit">min</span>
            </div>
            <p id="idle-help" className={`hint ${idleInvalid ? "hint--error" : ""}`}>
              {idleInvalid ? `Enter a whole number from ${IDLE_MIN} to ${IDLE_MAX}.` : "With no jobs or downloads for this long, the app stops that GPU. Default 30."}
            </p>
            {!idleInvalid && (
              <p id="idle-cost" className="hint">
                Up to <strong className="mono">~${((idleShown / 60) * cost).toFixed(2)}</strong> of idle time per pod each time you forget to stop it.
              </p>
            )}
          </div>

          <div className="field">
            <label className="switch">
              <input
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
              <p id="pass-key-help" className="hint hint--warn">
                <Icon name="alert" size={12} /> Off: if this app quits or crashes while a pod runs, the pod keeps billing until the app stops it (or you stop it in the
                RunPod console). Applies to pods started after saving.{changed.passKey ? " Not saved yet." : ""}
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
            value={civitaiKey}
            onChange={setCivitaiKey}
            visible={visible}
            help="Used to look up LoRA details from Civitai links. Some models need it to download. civitai.com → Account settings → API keys."
          />

          <div className="settings__actions">
            <button type="button" className="btn" onClick={test} disabled={testing || saving}>
              <Icon name="bolt" className={testing ? "pulse-icon" : ""} /> {testing ? "Testing…" : keysTyped ? "Test keys" : "Test connection"}
            </button>
            <button type="submit" className={`btn btn--primary ${saveReason ? "btn--blocked" : ""}`} disabled={!!saveReason || saving} aria-describedby="settings-save-why">
              {saving ? "Checking & saving…" : "Save changes"}
            </button>
          </div>
          <p id="settings-save-why" className={`hint settings__dirty ${idleInvalid && dirty ? "hint--error" : ""}`}>
            {saveReason && dirty
              ? saveReason
              : keysTyped
                ? "Test keys checks what you typed without saving it; Save checks it again first."
                : "Checks your saved keys, and the Images GPU when it's running (it never starts a GPU)."}
          </p>
          {saveAnyway && (
            <div className="notice notice--warn" role="alert">
              <Icon name="alert" /> Couldn't check the key ({saveAnyway}). It may still be fine.
              <button type="button" className="btn btn--sm" onClick={() => void doSave()} disabled={saving}>
                Save anyway
              </button>
            </div>
          )}
          {report && <KeyResults report={report.keys} pod={report.pod} />}
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
          <div className="settings-bar" role="region" aria-label="Unsaved settings">
            <span>
              <span className="settings-bar__dot" aria-hidden /> Unsaved changes
            </span>
            <span className="settings-bar__actions">
              <button type="button" className="btn btn--sm btn--ghost" onClick={reset} disabled={saving}>
                Discard
              </button>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={!!saveReason || saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
