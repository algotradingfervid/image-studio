import { useEffect, useState } from "react";

/** Re-render every `ms` while `on`; returns the current time. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const h = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(h);
  }, [on, ms]);
  return now;
}
