import * as React from "react"

/*
 * The binder pages used to carry their own night mode (`bx-dark`); that is
 * gone. My Vault's one theme (components/theme-provider.tsx, dark by
 * default for customers) drives the pages too: binders.css keys the paper
 * look off `html:not(.dark)`.
 */

/** True when the visitor asked the system for less motion. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)"
  return React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(query)
      m?.addEventListener("change", cb)
      return () => m?.removeEventListener("change", cb)
    },
    () => !!window.matchMedia?.(query).matches,
    () => false
  )
}

/** True on a screen wide enough for a two-page spread. */
export function useWide(min = 900): boolean {
  const query = `(min-width: ${min}px)`
  return React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(query)
      m?.addEventListener("change", cb)
      return () => m?.removeEventListener("change", cb)
    },
    () => !!window.matchMedia?.(query).matches,
    () => false
  )
}
