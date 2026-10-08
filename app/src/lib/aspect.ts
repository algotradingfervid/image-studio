// Aspect-ratio keys accepted by `generate({aspectRatio})`. Pixel sizes mirror
// shared/models.json `aspectRatios` (display only — the Rust core maps the key to a size).
export const ASPECTS: { key: string; w: number; h: number }[] = [
  { key: "1:1", w: 1024, h: 1024 },
  { key: "4:3", w: 1152, h: 896 },
  { key: "3:4", w: 896, h: 1152 },
  { key: "3:2", w: 1216, h: 832 },
  { key: "2:3", w: 832, h: 1216 },
  { key: "16:9", w: 1344, h: 768 },
  { key: "9:16", w: 768, h: 1344 },
];

export function aspectNumbers(key: string): [number, number] {
  const [a, b] = key.split(":").map(Number);
  return a && b ? [a, b] : [1, 1];
}
