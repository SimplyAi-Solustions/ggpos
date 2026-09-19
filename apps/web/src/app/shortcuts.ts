import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { focusScanField, focusSearchField } from "@/app/focus-registry"

/**
 * The counter is a keyboard-first desktop screen. Nothing here fires while
 * the caret is in a field, and nothing here uses a modifier except the
 * palette, so a scanner's keystrokes can never trigger an action.
 *
 * Esc is not listed: every sheet and dialog in the system is a Base UI
 * popup, which closes itself on Esc.
 */
export const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "S", label: "Scan" },
  { keys: "N", label: "Add stock" },
  { keys: "B", label: "New buy-in" },
  { keys: "/", label: "Search" },
  { keys: "K", label: "Command palette" },
]

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type
    return type !== "checkbox" && type !== "radio" && type !== "button"
  }
  return false
}

export function useShortcuts(openPalette: () => void) {
  const navigate = useNavigate()

  React.useEffect(() => {
    function handle(event: KeyboardEvent) {
      if (event.repeat) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openPalette()
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event.target)) return

      switch (event.key) {
        case "s":
        case "S":
          event.preventDefault()
          if (!focusScanField()) void navigate({ to: "/counter/scan" })
          return
        case "n":
        case "N":
          event.preventDefault()
          void navigate({ to: "/counter/stock/new" })
          return
        case "b":
        case "B":
          event.preventDefault()
          void navigate({ to: "/counter/trade" })
          return
        case "/":
          event.preventDefault()
          if (!focusSearchField()) openPalette()
          return
        default:
      }
    }

    window.addEventListener("keydown", handle)
    return () => window.removeEventListener("keydown", handle)
  }, [navigate, openPalette])
}
