export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function toDate(v: string | number | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function formatRelative(v: string | number | null | undefined, now = Date.now()): string {
  const d = toDate(v);
  if (!d) return "never";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(v: string | number | null | undefined): string {
  const d = toDate(v);
  return d
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** "NVIDIA RTX PRO 6000 Blackwell Server Edition" -> "RTX PRO 6000", "NVIDIA GeForce RTX 4090" -> "RTX 4090"; falls back to the raw string. */
export function shortGpuName(gpuType: string | null | undefined): string {
  if (!gpuType) return "GPU";
  const short = gpuType
    .replace(/^NVIDIA\s+/i, "")
    .replace(/^GeForce\s+/i, "")
    .replace(/\s+Blackwell(\s+Server Edition)?$/i, "")
    .trim();
  return short || gpuType;
}

/** Elapsed time for the GPU pill: "<1 min", "23 min", "1 h 05 min". */
export function formatElapsed(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}
