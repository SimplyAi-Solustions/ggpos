import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { focusScanField, focusSearchField } from "@/app/focus-registry"

/**
 * The counter is a keyboard-first desktop screen. Nothing here fires while
 * the caret is in a field, and nothing here uses a modifier except the
 * palette, so a scanner's keystrokes can never trigger an action.
 *
 * Esc has no entry of its own: every sheet and dialog in the system is a
 * Base UI popup, which closes itself on Esc. The overlay says so in a line
 * of its own instead.
 */
export type ShortcutGroup = "Go to" | "Find" | "Help"

export interface Shortcut {
  keys: string
  label: string
  group: ShortcutGroup
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "S", label: "Scan", group: "Go to" },
  { keys: "N", label: "Add stock", group: "Go to" },
  { keys: "B", label: "New buy-in", group: "Go to" },
  { keys: "/", label: "Search", group: "Find" },
  { keys: "K", label: "Command palette", group: "Find" },
  { keys: "?", label: "Keyboard shortcuts", group: "Help" },
]

/**
 * The one line that is true of every sheet and dialog in the system. It is
 * written to follow a drawn Esc key, not to stand on its own.
 */
export const ESC_LINE = "closes any sheet, dialog or menu."

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["Go to", "Find", "Help"]

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

export interface ShortcutHandlers {
  openPalette: () => void
  /** The overlay listing everything on this page. */
  openShortcuts: () => void
}

export function useShortcuts({ openPalette, openShortcuts }: ShortcutHandlers) {
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
        case "?":
          // Shift and slash on a UK keyboard. The caret is never in a field
          // here, so a question mark being typed is never taken for this.
          event.preventDefault()
          openShortcuts()
          return
        default:
      }
    }

    window.addEventListener("keydown", handle)
    return () => window.removeEventListener("keydown", handle)
  }, [navigate, openPalette, openShortcuts])
}
