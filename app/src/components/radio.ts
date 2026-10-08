import type { KeyboardEvent } from "react";

/**
 * Arrow-key handling for a role="radiogroup" whose children are role="radio" buttons.
 * Moves selection and focus like native radio buttons.
 */
export function radioKeys<T>(values: T[], current: T, select: (v: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = Math.max(0, values.indexOf(current));
    let n = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % values.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + values.length) % values.length;
    if (e.key === "Home") n = 0;
    if (e.key === "End") n = values.length - 1;
    select(values[n]);
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[n]?.focus();
  };
}
