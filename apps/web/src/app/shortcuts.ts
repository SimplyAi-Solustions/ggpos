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
  /** True for a key that only fires with Ctrl, or the command key on a Mac. */
  modifier?: boolean
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "S", label: "Scan", group: "Go to" },
  { keys: "N", label: "Add stock", group: "Go to" },
  { keys: "B", label: "New buy-in", group: "Go to" },
  { keys: "/", label: "Search", group: "Find" },
  { keys: "K", label: "Command palette", group: "Find", modifier: true },
  { keys: "?", label: "Keyboard shortcuts", group: "Help" },
]

/** What the modifier is called on this machine, for the keys that need one. */
export function modifierKey(): string {
  if (typeof navigator === "undefined") return "Ctrl"
  return /mac/i.test(navigator.userAgent) ? "Cmd" : "Ctrl"
}

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

/**
 * A scan is a burst of keystrokes with nothing focused, which is exactly
 * when a letter shortcut would otherwise fire: `GGS7F3K2Q` would reach `S`
 * on its third character and walk off to the Scan screen mid-code. The
 * wedge listener treats keys closer together than this as one scan
 * (`lib/scanning/wedge.ts`), and so does this.
 */
const SCAN_GAP_MS = 50

/** A sheet, a dialog or a menu owns the keyboard while it is open. */
const POPUP =
  "[data-slot='dialog-content'],[data-slot='sheet-content'],[data-slot='menu-content']"

export function useShortcuts({ openPalette, openShortcuts }: ShortcutHandlers) {
  const navigate = useNavigate()

  React.useEffect(() => {
    let lastKeyAt = 0

    function handle(event: KeyboardEvent) {
      if (event.repeat) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openPalette()
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event.target)) return
      // Whatever is open on top of the page has the keyboard: pressing B
      // while the shortcut list is open should not walk off to a buy-in
      // behind it.
      if (document.querySelector(POPUP)) return

      // A scanner's own keystrokes never fire a shortcut, whether or not a
      // field has the caret.
      const at = Date.now()
      const inScan = at - lastKeyAt <= SCAN_GAP_MS
      lastKeyAt = at
      if (inScan) return

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
