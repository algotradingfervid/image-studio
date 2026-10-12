import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// Per-area sheets (UI review fixes) load after the base sheet so they can override it.
import "./styles/models.css";
import "./styles/vault.css";
import "./styles/jobs.css";
import "./styles/viewer.css";
import { logUi } from "./api";

// Uncaught UI errors go to the diagnostics log (~/Library/Logs/Image Studio/app.log).
window.addEventListener("error", (e) => logUi("error", `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  logUi("error", `unhandled rejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
