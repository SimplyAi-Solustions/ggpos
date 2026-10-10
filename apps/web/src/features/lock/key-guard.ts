/**
 * Keeps the keyboard for the lock screen and the approval dialog.
 *
 * Behind either of them the counter is still listening: the wedge scanner,
 * the letter shortcuts, and on the till a money keypad that takes digits
 * from the Mac's keyboard. A PIN typed on that keyboard must never also
 * land in the cash tendered field behind the lock. So while a guard is
 * active every keydown is stopped at the window in the capture phase, before
 * any of those listeners hear it; digits, Backspace and Delete are handed to
 * the PIN step instead, and Esc to whatever "back" means on the step.
 *
 * Stopping propagation does not cancel the key's default action, so typing
 * into the lock's own password field, Tab between its controls and Enter on
 * a focused button all still work.
 */
import * as React from "react"

import type { KeypadKey } from "@/components/ui/keypad"

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

interface GuardOptions {
  active: boolean
  /** The PIN step's keys; leave it off to swallow keys without using them. */
  onKey?: (key: KeypadKey) => void
  onEscape?: () => void
}

export function useKeyGuard({ active, onKey, onEscape }: GuardOptions) {
  const onKeyRef = React.useRef(onKey)
  const onEscapeRef = React.useRef(onEscape)
  React.useEffect(() => {
    onKeyRef.current = onKey
    onEscapeRef.current = onEscape
  })

  React.useEffect(() => {
    if (!active) return undefined
    const handler = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "Escape") {
        if (onEscapeRef.current) {
          event.preventDefault()
          onEscapeRef.current()
        }
        return
      }
      if (isEditable(event.target)) return
      const press = onKeyRef.current
      if (!press) return
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault()
        press(event.key as KeypadKey)
      } else if (event.key === "Backspace") {
        event.preventDefault()
        press("back")
      } else if (event.key === "Delete") {
        event.preventDefault()
        press("clear")
      }
    }
    window.addEventListener("keydown", handler, true)
    return () => window.removeEventListener("keydown", handler, true)
  }, [active])
}
