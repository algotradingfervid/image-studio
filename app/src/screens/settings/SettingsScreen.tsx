import { useEffect, useState, type FormEvent } from "react";
import * as api from "../../api";
import type { BackendKind, ConnectionTest } from "../../api";
import { Icon } from "../../components/Icon";
import { shortGpuName } from "../../lib/format";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";
import { useVault } from "../../state/vault";
import { PasswordField } from "../create/VaultViews";

function SecretField({
  id,
  label,
  saved,
  value,
  onChange,
  help,
}: {
  id: string;
  label: string;
  saved: boolean;
  value: string;
  onChange: (v: string) => void;
  help: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <div className="field__label-row">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {saved && (
          <span className="badge badge--ok">
            <Icon name="lock" size={11} /> Saved in Keychain
          </span>
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

function TestResult({ result }: { result: ConnectionTest }) {
  if (!result.ok)
    return (
      <div className="test-result is-error" role="status">
        <Icon name="alert" />
        <div>
          <strong>{result.target === "pod" ? "Couldn't reach the GPU pod." : "Couldn't connect."}</strong> {result.error ?? result.message ?? "Unknown error"}
        </div>
      </div>
    );
  let body;
  if (result.target === "pod")
    body = (
      <>
        <strong>GPU pod {result.ready === false ? "reachable, still booting." : "is ready."}</strong>
        {result.message ? ` ${result.message}.` : ""}
        {result.gpu ? (
          <>
            {" "}
            <span className="mono">{result.gpu}</span> ·
          </>
        ) : null}{" "}
        Jobs: {result.jobs.inQueue} in queue, {result.jobs.inProgress} in progress.
      </>
    );
  else if (result.target === "api")
    body = (
      <>
        <strong>Connected.</strong> {result.message ?? "API key OK — GPU is stopped"}
      </>
    );
  else
    body = (
      <>
        <strong>Connected.</strong> {result.message ? `${result.message} · ` : ""}Workers: {result.workers.idle} idle, {result.workers.running} running · Jobs:{" "}
        {result.jobs.inQueue} in queue, {result.jobs.inProgress} in progress.
      </>
    );
  return (
    <div className="test-result is-ok" role="status">
      <Icon name="check" />
      <div>{body}</div>
    </div>
  );
}

function parseAutoLock(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= api.VAULT_AUTOLOCK_MIN && n <= api.VAULT_AUTOLOCK_MAX ? n : null;
}

/** Vault (spec v6): auto-lock minutes, change password, lock now. */
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
  }, [st?.autoLockMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const minN = parseAutoLock(minutes);
  const minDirty = !!st && minN !== st.autoLockMinutes;

  const saveMinutes = async (e: FormEvent) => {
    e.preventDefault();
    if (minN == null || !minDirty) return;
    setSavingMin(true);
    try {
      await vault.setAutoLock(minN);
      toast.success("Auto-lock saved", `The vault locks after ${minN} minute${minN === 1 ? "" : "s"} without activity.`);
    } catch (err) {
      toast.error("Couldn't save the auto-lock time", err);
    } finally {
      setSavingMin(false);
    }
  };

  const short = newPw.length > 0 && newPw.length < api.VAULT_PASSWORD_MIN;
  const mismatch = confirmPw.length > 0 && confirmPw !== newPw;
  const pwValid = !!oldPw && newPw.length >= api.VAULT_PASSWORD_MIN && confirmPw === newPw;

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
      const code = api.errorCode(err);
      setPwError(
        code === "WRONG_PASSWORD"
          ? "The current password is wrong."
          : code === "WEAK_PASSWORD"
            ? `Use at least ${api.VAULT_PASSWORD_MIN} characters.`
            : code === "VAULT_LOCKED"
              ? "The vault locked. Unlock it and try again."
              : api.errorMessage(err),
      );
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <section className="card settings vault-settings" aria-labelledby="vault-settings-title">
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
        <p className="hint">No vault yet. Create one from the Vault tab of the gallery on the Create screen.</p>
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
                  className="input mono"
                  type="number"
                  inputMode="numeric"
                  min={api.VAULT_AUTOLOCK_MIN}
                  max={api.VAULT_AUTOLOCK_MAX}
                  step={1}
                  value={minutes}
                  onChange={(e) => setMinutes(e.target.value)}
                  aria-invalid={minN == null}
                  aria-describedby="vault-autolock-help"
                />
                <span className="input-suffix__unit">min</span>
              </div>
              <button type="submit" className="btn" disabled={minN == null || !minDirty || savingMin}>
                {savingMin ? "Saving…" : "Save"}
              </button>
            </div>
            <p id="vault-autolock-help" className={`hint ${minN == null ? "hint--error" : ""}`}>
              {minN == null
                ? `Enter a whole number from ${api.VAULT_AUTOLOCK_MIN} to ${api.VAULT_AUTOLOCK_MAX}.`
                : "The vault also locks when the app quits and when the Mac sleeps or locks its screen. Default 10."}
            </p>
          </form>

          <h3 className="card__title card__title--sub">
            <Icon name="key" /> Change password
          </h3>
          {st.unlocked ? (
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
                    invalid={short}
                    describedBy="vault-new-pw-help"
                    autoComplete="new-password"
                  />
                  <p id="vault-new-pw-help" className={`hint ${short ? "hint--error" : ""}`}>
                    At least {api.VAULT_PASSWORD_MIN} characters.
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
          ) : (
            <p className="hint">Unlock the vault (Create → Gallery → Vault) to change its password.</p>
          )}

          {st.unlocked && (
            <>
              <h3 className="card__title card__title--sub">
                <Icon name="lock" /> Lock
              </h3>
              <div className="vault-settings__row">
                <p className="hint vault-settings__grow">Locking wipes the key and every decrypted item from memory. Vault items disappear until you unlock again.</p>
                <button type="button" className="btn" onClick={() => void vault.lock()}>
                  <Icon name="lock" /> Lock now
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function SettingsScreen() {
  const lib = useLibrary();
  const toast = useToast();
  const s = lib.settings;
  const [apiKey, setApiKey] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [civitaiKey, setCivitaiKey] = useState("");
  const [backend, setBackend] = useState<BackendKind>("pod");
  const [idle, setIdle] = useState("30");
  const [passKey, setPassKey] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);

  useEffect(() => {
    if (!s) return;
    setEndpointId(s.endpointId ?? "");
    setBackend(s.backend);
    setIdle(String(s.idleMinutes));
    setPassKey(s.passApiKeyToPod);
  }, [s]);

  const idleN = parseIdle(idle);
  const idleInvalid = idleN == null;
  const changed = {
    endpointId: !!s && endpointId.trim() !== (s.endpointId ?? ""),
    backend: !!s && backend !== s.backend,
    idle: !!s && (idleN == null ? idle.trim() !== String(s.idleMinutes) : idleN !== s.idleMinutes),
    passKey: !!s && passKey !== s.passApiKeyToPod,
  };
  const dirty = !!apiKey || !!civitaiKey || changed.endpointId || changed.backend || changed.idle || changed.passKey;
  const pod = backend === "pod";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || idleInvalid) return;
    setSaving(true);
    try {
      const input: api.SaveSettingsInput = {};
      if (apiKey) input.apiKey = apiKey;
      if (civitaiKey) input.civitaiKey = civitaiKey;
      if (changed.endpointId) input.endpointId = endpointId.trim();
      if (changed.backend) input.backend = backend;
      if (changed.idle && idleN != null) input.idleMinutes = idleN;
      if (changed.passKey) input.passApiKeyToPod = passKey;
      await api.saveSettings(input); // returns the new view; reload keeps one source of truth
      setApiKey("");
      setCivitaiKey("");
      setResult(null);
      await lib.reloadSettings();
      toast.success("Settings saved");
    } catch (err) {
      toast.error("Couldn't save settings", err);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testConnection());
    } catch (err) {
      setResult({ ok: false, workers: { idle: 0, running: 0 }, jobs: { inQueue: 0, inProgress: 0 }, error: api.errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const cost = s?.fallbackCostPerHr ?? 2.49;
  const idleShown = idleN ?? s?.idleMinutes ?? 30;

  return (
    <div className="page">
      <div className="page__inner page__inner--narrow">
        <header className="page__head">
          <div>
            <h1 className="page__title">Settings</h1>
            <p className="page__lede">Keys are stored in the macOS Keychain and never shown again.</p>
          </div>
        </header>

        <form className="card settings" onSubmit={save} aria-labelledby="runpod-title">
          <h2 id="runpod-title" className="card__title">
            <Icon name="cloud" /> RunPod
          </h2>
          <SecretField
            id="runpod-key"
            label="API key"
            saved={!!s?.hasApiKey}
            value={apiKey}
            onChange={setApiKey}
            help="RunPod → Settings → API Keys. The app uses it to start and stop your GPU pod (and for the legacy serverless endpoint)."
          />
          <div className="field">
            <label className="field__label" htmlFor="backend">
              Run generations on
            </label>
            <select id="backend" className="input select" value={backend} onChange={(e) => setBackend(e.target.value as BackendKind)} aria-describedby="backend-help">
              <option value="pod">Dedicated GPU pod (recommended)</option>
              <option value="serverless">Serverless (legacy)</option>
            </select>
            <p id="backend-help" className="hint">
              {pod
                ? "You start and stop one GPU pod from the header. No waiting for a free serverless worker."
                : "Jobs go to your serverless endpoint. Workers can queue for a long time when GPUs are scarce."}
            </p>
          </div>

          {pod ? (
            <>
              <div className="field-row">
                <div className="field">
                  <label className="field__label" htmlFor="idle-minutes">
                    Auto-stop after N idle minutes
                  </label>
                  <div className="input-suffix">
                    <input
                      id="idle-minutes"
                      className="input mono"
                      type="number"
                      inputMode="numeric"
                      min={IDLE_MIN}
                      max={IDLE_MAX}
                      step={1}
                      value={idle}
                      onChange={(e) => setIdle(e.target.value)}
                      aria-invalid={idleInvalid}
                      aria-describedby="idle-help"
                    />
                    <span className="input-suffix__unit">min</span>
                  </div>
                  <p id="idle-help" className={`hint ${idleInvalid ? "hint--error" : ""}`}>
                    {idleInvalid ? `Enter a whole number from ${IDLE_MIN} to ${IDLE_MAX}.` : "With no jobs or downloads for this long, the app stops the GPU. Default 30."}
                  </p>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="gpu-type">
                    GPU priority
                  </label>
                  <input
                    id="gpu-type"
                    className="input"
                    value={(s?.gpuTypes?.length ? s.gpuTypes : s?.gpuType ? [s.gpuType] : []).map(shortGpuName).join(" → ")}
                    title={(s?.gpuTypes ?? []).join("\n")}
                    readOnly
                    aria-describedby="gpu-type-help"
                  />
                  <p id="gpu-type-help" className="hint">
                    Fixed for now · the pod gets the first one available · up to ${cost.toFixed(2)}/h while running.
                  </p>
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="field__label" htmlFor="video-gpu-types">
                    Video GPU priority
                  </label>
                  <input
                    id="video-gpu-types"
                    className="input"
                    value={(s?.videoGpuTypes ?? []).map(shortGpuName).join(" → ") || "—"}
                    title={(s?.videoGpuTypes ?? []).join("\n")}
                    readOnly
                    aria-describedby="video-gpu-help"
                  />
                  <p id="video-gpu-help" className="hint">
                    The video pod (Canada) gets the first one available.
                  </p>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="video-volumes">
                    Video volume
                  </label>
                  <input
                    id="video-volumes"
                    className="input mono"
                    value={(s?.videoVolumeNames ?? []).join(", ") || "—"}
                    readOnly
                    aria-describedby="video-volumes-help"
                  />
                  <p id="video-volumes-help" className="hint">
                    Image volume: <span className="mono">{(s?.volumeNames ?? []).join(", ") || "—"}</span>. Change both lists in the settings file.
                  </p>
                </div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="worker-ref">
                  Worker code
                </label>
                <input
                  id="worker-ref"
                  className="input mono"
                  value={s?.workerRef ?? "main"}
                  title={s?.podImage ?? ""}
                  readOnly
                  aria-describedby="worker-ref-help"
                />
                <p id="worker-ref-help" className="hint">
                  Git ref the pod loads its code from at each start. Change <code>workerRef</code> (or <code>podImage</code>) in the settings file.
                </p>
              </div>
              <div className="field">
                <label className="switch">
                  <input type="checkbox" checked={passKey} onChange={(e) => setPassKey(e.target.checked)} aria-describedby="pass-key-help" />
                  <span className="switch__track" aria-hidden />
                  <span>Let the pod stop itself when idle</span>
                </label>
                <p id="pass-key-help" className="hint">
                  Passes your RunPod API key to the pod so its own watchdog can terminate it after {idleShown} idle minutes, even when this app is closed.
                </p>
              </div>
            </>
          ) : (
            <>
              <h3 className="card__title card__title--sub">Legacy serverless</h3>
              <div className="field">
                <label className="field__label" htmlFor="endpoint-id">
                  Endpoint ID
                </label>
                <input
                  id="endpoint-id"
                  className="input mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. a1b2c3d4e5f6g7"
                  value={endpointId}
                  onChange={(e) => setEndpointId(e.target.value)}
                  aria-describedby="endpoint-help"
                />
                <p id="endpoint-help" className="hint">
                  Only needed for the serverless backend. Shown on the endpoint's page in the RunPod console (scripts/runpod_setup.py also writes it to .env).
                </p>
              </div>
            </>
          )}

          <h2 className="card__title card__title--sub">
            <Icon name="layers" /> Civitai
          </h2>
          <SecretField
            id="civitai-key"
            label="Civitai API key (optional)"
            saved={!!s?.hasCivitaiKey}
            value={civitaiKey}
            onChange={setCivitaiKey}
            help="Used to look up LoRA details from Civitai links. Some models need it to download."
          />

          <div className="settings__actions">
            <button type="button" className="btn" onClick={test} disabled={testing || dirty}>
              <Icon name="bolt" className={testing ? "pulse-icon" : ""} /> {testing ? "Testing…" : "Test connection"}
            </button>
            <button type="submit" className="btn btn--primary" disabled={!dirty || idleInvalid || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {dirty && <p className="hint settings__dirty">Save your changes before testing the connection.</p>}
          {!dirty && s?.backend === "pod" && (
            <p className="hint settings__dirty">Checks the GPU pod when it's running; otherwise only the API key (it doesn't start the GPU).</p>
          )}

          {result && <TestResult result={result} />}
        </form>

        <VaultSettings />

        <section className="card note" aria-labelledby="cost-title">
          <h2 id="cost-title" className="card__title">
            <Icon name="info" /> Costs
          </h2>
          {s?.backend === "serverless" ? (
            <ul className="plain note__list">
              <li>You pay per second while a GPU worker runs — nothing while idle (min workers 0, idle timeout 5 s).</li>
              <li>The first image after a pause waits for a cold start: usually 20–60 s while a worker boots and loads the model.</li>
              <li>Downloads, deletes and Refresh on the Models tab also start a worker briefly.</li>
              <li>Storage on the network volume is billed monthly.</li>
            </ul>
          ) : (
            <ul className="plain note__list">
              <li>
                The GPU pod is billed ~${cost.toFixed(2)}/h or less (depends on which GPU it gets) while it runs — from Start until you press Stop or it auto-stops. The header shows the running time and
                cost so far.
              </li>
              <li>
                The app stops it after {s?.idleMinutes ?? 30} idle minutes (no jobs, downloads or deletes) while it's open. The pod also stops itself when idle, even if
                the app is closed.
              </li>
              <li>Generating, Refresh, downloads and deletes start the GPU when it's stopped. Starting takes a few minutes.</li>
              <li>Storage on the network volume is billed monthly, whether the GPU runs or not.</li>
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
