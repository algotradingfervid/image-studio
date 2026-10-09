// Small inline icon set (1.5px strokes, 20px grid). Decorative by default.

const paths: Record<string, string> = {
  spark: "M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3M4.7 4.7l2.1 2.1M13.2 13.2l2.1 2.1M4.7 15.3l2.1-2.1M13.2 6.8l2.1-2.1",
  wand: "M3 17 13 7M12 3.5v2M15.5 7h2M14.6 4.4l1-1M11 6l3 3",
  cube: "M10 2.5 17 6.5v7L10 17.5 3 13.5v-7L10 2.5ZM3 6.5l7 4 7-4M10 10.5v7",
  sliders: "M4 5h7M15 5h1M4 10h2M10 10h6M4 15h9M17 15h-1M13 3.5v3M8 8.5v3M15 13.5v3",
  gear: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
  image: "M3.5 4.5h13v11h-13zM3.5 13l4-4 3.5 3.5 2-2 3.5 3.5M12.5 8a1 1 0 1 0 0-.01",
  plus: "M10 4v12M4 10h12",
  x: "M5 5l10 10M15 5 5 15",
  check: "M4 10.5 8 14.5 16 6",
  alert: "M10 3 18 16.5H2L10 3ZM10 8v4M10 14.2v.3",
  info: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 9v5M10 6.2v.3",
  download: "M10 3v9.5M6 9l4 4 4-4M4 16.5h12",
  trash: "M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6M8.5 9v5M11.5 9v5",
  copy: "M7 7h9v9H7zM4 13V4h9",
  refresh: "M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3.5h-3.5",
  chevronLeft: "M12.5 4.5 7 10l5.5 5.5",
  chevronRight: "M7.5 4.5 13 10l-5.5 5.5",
  chevronDown: "M5 7.5 10 12.5 15 7.5",
  dice: "M4 4h12v12H4zM7.5 7.5v.01M12.5 7.5v.01M10 10v.01M7.5 12.5v.01M12.5 12.5v.01",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1",
  restore: "M4 10a6 6 0 1 0 1.8-4.3M4 3.5V7h3.5",
  stop: "M6 6h8v8H6z",
  key: "M12.5 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM10.5 9.6 16 15.5M13.5 12.5l1.5-1.5M15 14l1.5-1.5",
  lock: "M5.5 9h9v8h-9zM7.5 9V6.5a2.5 2.5 0 0 1 5 0V9",
  unlock: "M5.5 9h9v8h-9zM7.5 9V6.5a2.5 2.5 0 0 1 4.9-.7",
  shield: "M10 2.5 16 5v4.5c0 3.8-2.6 6.7-6 8-3.4-1.3-6-4.2-6-8V5l6-2.5Z",
  bolt: "M11 2.5 4.5 11H10l-1 6.5L15.5 9H10l1-6.5Z",
  upload: "M10 13V3.5M6 7l4-4 4 4M4 16.5h12",
  eye: "M2.5 10S5 4.5 10 4.5 17.5 10 17.5 10 15 15.5 10 15.5 2.5 10 2.5 10ZM10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  layers: "M10 3 17.5 7 10 11 2.5 7 10 3ZM2.5 10.5 10 14.5l7.5-4M2.5 14 10 18l7.5-4",
  video: "M3 5.5h10v9H3zM13 8.8l4-2.3v7l-4-2.3",
  play: "M7 4.8v10.4L15.5 10 7 4.8Z",
  volume: "M3.5 8h2.8L10 4.8v10.4L6.3 12H3.5zM13 7.5a3.5 3.5 0 0 1 0 5M15 5.5a6.3 6.3 0 0 1 0 9",
  mute: "M3.5 8h2.8L10 4.8v10.4L6.3 12H3.5zM13 8l4 4M17 8l-4 4",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM13.5 13.5 17 17",
  globe: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM2.5 10h15M10 2.5c2 2 3 4.5 3 7.5s-1 5.5-3 7.5c-2-2-3-4.5-3-7.5s1-5.5 3-7.5Z",
  cloud: "M6 15.5h8.5a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 5.2 9.6 3 3 0 0 0 6 15.5Z",
};

export type IconName = keyof typeof paths;

export function Icon({ name, className, size = 16, label }: { name: IconName; className?: string; size?: number; label?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** A small rectangle drawn at the given aspect ratio, for aspect chips. */
export function AspectShape({ w, h }: { w: number; h: number }) {
  const max = 14;
  const sw = w >= h ? max : Math.round((max * w) / h);
  const sh = h >= w ? max : Math.round((max * h) / w);
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden className="aspect-shape">
      <rect x={(18 - sw) / 2} y={(18 - sh) / 2} width={sw} height={sh} rx={2} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}
