import { useEffect, useState } from "react";

/**
 * Subscribes to a CSS media query. Used where a breakpoint has to change
 * the rendered markup rather than just its styling -- e.g. swapping a
 * vertical slider for a horizontal one, which CSS alone cannot do for a
 * pointer-driven control.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
