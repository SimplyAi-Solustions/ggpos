/**
 * Whether the till has room for its two panes side by side: 900px and up
 * (DESIGN.md, section 10, "Frame"). Below that the panes are two tabs.
 *
 * Decided in script rather than CSS because the two layouts are different
 * trees: one scan field, one ticket, never a hidden copy of either.
 */
import * as React from "react"

const QUERY = "(min-width: 900px)"

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const query = window.matchMedia(QUERY)
  query.addEventListener("change", listener)
  return () => query.removeEventListener("change", listener)
}

function snapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true
  return window.matchMedia(QUERY).matches
}

export function useWide(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => true)
}
