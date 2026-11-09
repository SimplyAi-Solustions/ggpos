import * as React from "react"

/**
 * Binder light and dark, separate from the app's own theme.
 *
 * The binder's pages default to the GG HQ night look (smoked glass sleeves,
 * paper text) because cards read best on dark; the choice is kept per
 * device. Only the `bx-dark` class is managed here: the Vault chrome around
 * the book stays on the app's own ThemeProvider, whose effect runs after
 * this one and would strip a `dark` class this hook added, so touching the
 * app theme would leave the two fighting over <html>.
 */
export type BinderTheme = "dark" | "light"

const KEY = "gg_binder_theme"

function read(): BinderTheme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

export function useBinderTheme(): [BinderTheme, () => void] {
  const [theme, setTheme] = React.useState<BinderTheme>(read)

  React.useEffect(() => {
    const root = document.documentElement
    root.classList.toggle("bx-dark", theme === "dark")
    return () => {
      root.classList.remove("bx-dark")
    }
  }, [theme])

  const toggle = React.useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark"
      try {
        localStorage.setItem(KEY, next)
      } catch {
        // Private browsing: the choice lasts for this visit.
      }
      return next
    })
  }, [])

  return [theme, toggle]
}

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
