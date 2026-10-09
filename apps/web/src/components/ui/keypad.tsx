import * as React from "react"
import { DeleteIcon } from "lucide-react"
import { cn } from "cn"

/**
 * The till's number pad: PIN entry on the lock screen and the manager
 * approval, cash tendered and keyed prices on the till, the float and the
 * drawer count when cashing up. Twelve 72px keys drawn as a grid of
 * hairlines, the way a phone draws its keypad, with Jost 300 digits.
 *
 * `mode="pin"` puts Clear and Backspace either side of 0; `mode="money"`
 * puts 00 and Backspace there, so £20.00 is 2, 0, 00. The parent owns the
 * value: each press calls `onKey` with "0" to "9", "00", "clear" or
 * "back", and `applyKey` turns that into the next string for the common
 * cases.
 *
 * With `captureKeyboard` the pad also takes digits, Backspace, Delete and
 * Enter from a physical keyboard (the Mac at the counter), unless the caret
 * is in a field of its own.
 */

type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "clear" | "back"

interface KeypadProps {
  mode?: "pin" | "money"
  onKey: (key: KeypadKey) => void
  /** Enter on a physical keyboard. */
  onEnter?: () => void
  disabled?: boolean
  captureKeyboard?: boolean
  className?: string
  /** Names the pad for a screen reader, e.g. "PIN" or "Cash tendered". */
  "aria-label": string
}

const DIGITS: KeypadKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

function Keypad({
  mode = "pin",
  onKey,
  onEnter,
  disabled = false,
  captureKeyboard = false,
  className,
  "aria-label": ariaLabel,
}: KeypadProps) {
  const onKeyRef = React.useRef(onKey)
  const onEnterRef = React.useRef(onEnter)
  React.useEffect(() => {
    onKeyRef.current = onKey
    onEnterRef.current = onEnter
  })

  React.useEffect(() => {
    if (!captureKeyboard || disabled) return undefined
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditable(event.target)) return
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault()
        onKeyRef.current(event.key as KeypadKey)
      } else if (event.key === "Backspace") {
        event.preventDefault()
        onKeyRef.current("back")
      } else if (event.key === "Delete") {
        event.preventDefault()
        onKeyRef.current("clear")
      } else if (event.key === "Enter" && onEnterRef.current) {
        event.preventDefault()
        onEnterRef.current()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [captureKeyboard, disabled])

  const bottom: { key: KeypadKey; label: React.ReactNode; name: string }[] =
    mode === "money"
      ? [
          { key: "00", label: "00", name: "Double zero" },
          { key: "0", label: "0", name: "0" },
          {
            key: "back",
            label: <DeleteIcon aria-hidden="true" className="size-6 stroke-[1.25]" />,
            name: "Delete last digit",
          },
        ]
      : [
          {
            key: "clear",
            label: (
              <span className="font-mono text-[11px] font-bold tracking-[0.16em] uppercase">
                Clear
              </span>
            ),
            name: "Clear",
          },
          { key: "0", label: "0", name: "0" },
          {
            key: "back",
            label: <DeleteIcon aria-hidden="true" className="size-6 stroke-[1.25]" />,
            name: "Delete last digit",
          },
        ]

  const keys = [
    ...DIGITS.map((d) => ({ key: d, label: d as React.ReactNode, name: d })),
    ...bottom,
  ]

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-slot="keypad"
      className={cn(
        // The gap shows the hairline behind the keys: a grid of 1px rules
        // with no outer edge, rather than twelve boxes.
        "grid grid-cols-3 gap-px bg-hairline-soft",
        className
      )}
    >
      {keys.map(({ key, label, name }) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          aria-label={name}
          onClick={() => onKey(key)}
          className={cn(
            "flex h-18 items-center justify-center bg-background outline-none select-none",
            "font-sans text-[32px] leading-none font-light text-foreground tnum",
            "transition-colors duration-150 ease-gg",
            "hover:bg-secondary active:bg-surface-3",
            "focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
            "disabled:pointer-events-none disabled:opacity-50"
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * The next value after a key press, for a string of digits.
 * - PIN: digits up to `maxLength`; Clear empties; Backspace drops one.
 * - Money (pence as a digit string): "00" appends two zeros; leading zeros
 *   are dropped, so the string is always the pence figure.
 */
function applyKey(value: string, key: KeypadKey, maxLength: number): string {
  if (key === "clear") return ""
  if (key === "back") return value.slice(0, -1)
  const next = (value + key).replace(/^0+(?=\d)/, "")
  if (next.length > maxLength) return value
  return next === "0" || next === "00" ? "" : next
}

/**
 * Where a PIN has got to: one dot per digit of the PIN's length, filled ink
 * as each is entered and a hairline ring until then. Never shows a digit.
 */
function PinDots({
  length,
  filled,
  className,
}: {
  length: number
  filled: number
  className?: string
}) {
  return (
    <div
      data-slot="pin-dots"
      role="img"
      aria-label={`${filled} of ${length} digits entered`}
      className={cn("flex items-center justify-center gap-4", className)}
    >
      {Array.from({ length }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "size-3.5 rounded-full border transition-colors duration-150 ease-gg",
            index < filled ? "border-foreground bg-foreground" : "border-hairline bg-transparent"
          )}
        />
      ))}
    </div>
  )
}

export { Keypad, PinDots, applyKey }
export type { KeypadKey, KeypadProps }
