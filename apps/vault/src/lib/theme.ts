import * as React from "react"

/**
 * Light, dark or follow the system. The choice lives in localStorage and
 * public/theme-init.js applies it before first paint; keep the key and the
 * class name in step with that file.
 */
export type ThemePreference = "light" | "dark" | "system"

export const THEME_KEY = "gg-vault-theme"

const listeners = new Set<() => void>()

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null
}

export function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === "light" || value === "dark" ? value : "system"
  } catch {
    return "system"
  }
}

export function resolveDark(pref: ThemePreference): boolean {
  if (pref === "dark") return true
  if (pref === "light") return false
  return media()?.matches ?? false
}

export function applyTheme(pref: ThemePreference = readPreference()) {
  const dark = resolveDark(pref)
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
}

export function setPreference(pref: ThemePreference) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    // Private browsing: applies for this page load only.
  }
  applyTheme(pref)
  for (const listener of listeners) listener()
}

/** Follows the system while the preference is "system". Call once at boot. */
export function watchSystemTheme() {
  const mq = media()
  if (!mq) return
  mq.addEventListener("change", () => {
    if (readPreference() === "system") {
      applyTheme("system")
      for (const listener of listeners) listener()
    }
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = React.useSyncExternalStore(subscribe, readPreference, () => "system" as const)
  return [pref, setPreference]
}

/** Whether dark is showing right now, whatever the preference. */
export function useIsDark(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => resolveDark(readPreference()),
    () => false
  )
}
