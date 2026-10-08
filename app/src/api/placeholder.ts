// Canvas-drawn placeholder images for the dev mock (never used inside Tauri).

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Abstract, "generated-looking" image as a JPEG data URL at 1/scale of the given size. */
export function placeholderImage(opts: {
  width: number;
  height: number;
  seed: number;
  prompt: string;
  label: string;
  scale?: number;
}): string {
  const scale = opts.scale ?? 3;
  const w = Math.max(64, Math.round(opts.width / scale));
  const h = Math.max(64, Math.round(opts.height / scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const r = rng(hashString(opts.prompt) ^ opts.seed);
  const hue = Math.floor(r() * 360);
  const g = ctx.createLinearGradient(0, 0, w * r(), h);
  g.addColorStop(0, `hsl(${hue} 45% 14%)`);
  g.addColorStop(1, `hsl(${(hue + 40 + r() * 80) % 360} 55% 30%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 7; i++) {
    const x = r() * w;
    const y = r() * h;
    const rad = (0.15 + r() * 0.5) * Math.max(w, h);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const hh = (hue + r() * 120 - 60 + 360) % 360;
    rg.addColorStop(0, `hsla(${hh} 80% 60% / ${0.18 + r() * 0.25})`);
    rg.addColorStop(1, `hsla(${hh} 80% 50% / 0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = "source-over";

  // Horizon / subject silhouette
  ctx.fillStyle = `hsla(${hue} 40% 6% / 0.55)`;
  ctx.beginPath();
  ctx.moveTo(0, h);
  const base = h * (0.6 + r() * 0.2);
  for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, base - r() * h * 0.18);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // Grain
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `600 ${Math.max(10, Math.round(w / 26))}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(opts.label, Math.round(w * 0.05), Math.round(h * 0.09));
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `${Math.max(9, Math.round(w / 34))}px ui-monospace, monospace`;
  ctx.fillText(`seed ${opts.seed}`, Math.round(w * 0.05), Math.round(h * 0.09) + Math.max(12, Math.round(w / 22)));
  return canvas.toDataURL("image/jpeg", 0.85);
}
