import { useEffect, useState, type FormEvent } from "react";
import * as api from "../../api";
import type { ConnectionTest } from "../../api";
import { Icon } from "../../components/Icon";
import { useLibrary } from "../../state/library";
import { useToast } from "../../state/toast";

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

export function SettingsScreen() {
  const lib = useLibrary();
  const toast = useToast();
  const s = lib.settings;
  const [apiKey, setApiKey] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [civitaiKey, setCivitaiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);

  useEffect(() => {
    if (s) setEndpointId(s.endpointId ?? "");
  }, [s]);

  const dirty = !!apiKey || !!civitaiKey || (s ? endpointId.trim() !== (s.endpointId ?? "") : false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setSaving(true);
    try {
      const input: api.SaveSettingsInput = {};
      if (apiKey) input.apiKey = apiKey;
      if (civitaiKey) input.civitaiKey = civitaiKey;
      if (s && endpointId.trim() !== (s.endpointId ?? "")) input.endpointId = endpointId.trim();
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
            <Icon name="cloud" /> RunPod Serverless
          </h2>
          <SecretField
            id="runpod-key"
            label="API key"
            saved={!!s?.hasApiKey}
            value={apiKey}
            onChange={setApiKey}
            help="RunPod → Settings → API Keys. A key with access to Serverless is enough."
          />
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
              Shown on the endpoint's page in the RunPod console (scripts/runpod_setup.py also writes it to .env).
            </p>
          </div>

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
            <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {dirty && <p className="hint settings__dirty">Save your changes before testing the connection.</p>}

          {result && (
            <div className={`test-result ${result.ok ? "is-ok" : "is-error"}`} role="status">
              <Icon name={result.ok ? "check" : "alert"} />
              {result.ok ? (
                <div>
                  <strong>Connected.</strong> Workers: {result.workers.idle} idle, {result.workers.running} running · Jobs: {result.jobs.inQueue} in queue,{" "}
                  {result.jobs.inProgress} in progress.
                </div>
              ) : (
                <div>
                  <strong>Couldn't connect.</strong> {result.error ?? "Unknown error"}
                </div>
              )}
            </div>
          )}
        </form>

        <section className="card note" aria-labelledby="cost-title">
          <h2 id="cost-title" className="card__title">
            <Icon name="info" /> Costs and cold starts
          </h2>
          <ul className="plain note__list">
            <li>You pay per second while a GPU worker runs — nothing while idle (min workers 0, idle timeout 5 s).</li>
            <li>The first image after a pause waits for a cold start: usually 20–60 s while a worker boots and loads the model.</li>
            <li>Images right after that are fast — a warm worker skips the cold start.</li>
            <li>Downloads, deletes and Refresh on the Models tab also start a worker briefly. Storage on the 100 GB network volume is billed monthly.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
