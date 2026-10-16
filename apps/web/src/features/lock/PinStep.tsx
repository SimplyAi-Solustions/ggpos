/**
 * The two parts the lock screen and manager approval share: a name on the
 * roster, and the PIN step (DESIGN.md section 10, "Lock screen and
 * approval").
 */
import * as React from "react"
import { cn } from "cn"
import type { RosterEntry } from "@gg/shared"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Keypad, PinDots, type KeypadKey } from "@/components/ui/keypad"
import { Hint } from "@/components/ui/micro-label"
import { useKeyGuard } from "@/features/lock/key-guard"
import { pressPinKey } from "@/features/lock/pin"
import { firstName, pinNote } from "@/features/lock/roster"

/**
 * One name: a 64px avatar with the initials in Space Mono 20px, the first
 * name under it, and "No PIN" or "PIN locked" when the PIN cannot be used.
 * The tile is 96px wide; the whole of it is the target.
 */
export function RosterTile({
  entry,
  onChoose,
  disabled = false,
}: {
  entry: RosterEntry
  onChoose: (entry: RosterEntry) => void
  disabled?: boolean
}) {
  const note = pinNote(entry)
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid="roster-tile"
      aria-label={note ? `${entry.name}, ${note.toLowerCase()}` : entry.name}
      onClick={() => onChoose(entry)}
      className={cn(
        "flex w-24 flex-col items-center gap-2 rounded-[var(--radius)] px-1 pt-2 pb-3 outline-none",
        "transition-colors duration-150 ease-gg hover:bg-row-hover active:bg-row-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-50"
      )}
    >
      <Avatar className="data-[size=default]:size-16">
        <AvatarFallback className="text-[20px] tracking-[0.08em]">{entry.initials}</AvatarFallback>
      </Avatar>
      <span className="max-w-full truncate text-[15px] leading-[1.3] text-foreground">
        {firstName(entry.name)}
      </span>
      {note ? <Hint className="text-center">{note}</Hint> : null}
    </button>
  )
}

/**
 * The name, a dot for each digit of their PIN, and the keypad at most 320px
 * wide. The last digit submits; there is no Enter key. A wrong PIN clears
 * the dots and the server's sentence sits under them: the parent keys this
 * component on the attempt, so every refusal starts it again from empty.
 */
export function PinStep({
  name,
  length,
  busy,
  error,
  locked = false,
  onSubmit,
  onBack,
  children,
  className,
}: {
  name: string
  /** 4 or 6. */
  length: number
  busy: boolean
  error: string | null
  /** The PIN cannot be used: no keypad, just the sentence and the way out. */
  locked?: boolean
  onSubmit: (pin: string) => void
  onBack: () => void
  /** The text actions under the keypad. */
  children?: React.ReactNode
  className?: string
}) {
  const [pin, setPin] = React.useState("")
  // What has been typed, read synchronously: two keys pressed faster than
  // a render must both count, and the last one must submit exactly once.
  const typed = React.useRef("")

  const press = (key: KeypadKey) => {
    if (busy || locked) return
    const before = typed.current
    const next = pressPinKey(before, key, length)
    if (next === before) return
    typed.current = next
    setPin(next)
    if (next.length === length) onSubmit(next)
  }

  useKeyGuard({ active: true, onKey: press, onEscape: onBack })

  return (
    <div className={cn("flex w-full max-w-[320px] flex-col items-center", className)}>
      <p data-testid="pin-name" className="text-[20px] leading-[1.3] font-medium text-foreground">
        {name}
      </p>
      <PinDots className="mt-6" length={length} filled={busy ? length : pin.length} />
      <p
        role="alert"
        data-testid="pin-error"
        className="mt-4 min-h-10 max-w-[32ch] text-center text-[13px] leading-[1.45] text-destructive"
      >
        {error}
      </p>
      {locked ? null : (
        <Keypad
          mode="pin"
          aria-label={`PIN for ${name}`}
          className="mt-2 w-full"
          disabled={busy}
          onKey={press}
        />
      )}
      <div className="mt-8 flex w-full flex-wrap items-center justify-between gap-6">{children}</div>
    </div>
  )
}
