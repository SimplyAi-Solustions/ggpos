import * as React from "react"

/**
 * Binder light and dark, separate from the app's own theme.
 *
 * The binders default to the GG HQ night look (ink #040406, smoked glass
 * panels, paper text) because cards read best on dark. The choice is kept
 * per device. While a binder screen is open it puts `dark` and `bx-dark` on
 * <html> so the portal shell and sheets match, and puts back whatever was
 * there when the screen closes.
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
    const hadDark = root.classList.contains("dark")
    const hadLight = root.classList.contains("light")
    if (theme === "dark") {
      root.classList.add("dark", "bx-dark")
      root.classList.remove("light")
    } else {
      root.classList.remove("dark", "bx-dark")
      root.classList.add("light")
    }
    return () => {
      root.classList.remove("bx-dark")
      root.classList.toggle("dark", hadDark)
      root.classList.toggle("light", hadLight)
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
