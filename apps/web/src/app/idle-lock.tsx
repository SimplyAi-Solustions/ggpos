import * as React from "react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { MicroLabel } from "@/components/ui/micro-label"
import { confirmPassword, initials, useStaff } from "@/lib/auth"
import { clearStepUp } from "@/lib/auth-stepup"

/** Ten minutes without a keystroke, a tap or a scan. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * PIN HOOK POINT
 * -------------------------------------------------------------------------
 * The counter PC is shared, so unlocking will eventually take a 4 to 6 digit
 * PIN (`staff.pin_hash` already exists in the migration) and will be able to
 * switch to a different staff member without a full sign-out. Until that
 * route exists the lock re-prompts for the signed-in member's password.
 * Replace `unlock` below with the PIN verification call and add a "Not you?"
 * action beside Continue; nothing else on this screen needs to change.
 */
async function unlock(password: string): Promise<boolean> {
  return confirmPassword(password)
}

const ACTIVITY = ["keydown", "pointerdown", "wheel", "touchstart"] as const

/**
 * A full-screen paper panel over the counter after ten idle minutes. It is
 * not a dialog: there is nothing behind it to go back to until the password
 * is right.
 */
export function IdleLock() {
  const staff = useStaff()
  const [locked, setLocked] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)

  React.useEffect(() => {
    if (locked || !staff) return undefined

    // Locking drops any step-up confirmation: whoever unlocks the counter
    // confirms again before a refund or an ID photo.
    const lock = () => {
      clearStepUp()
      setLocked(true)
    }

    let timer = window.setTimeout(lock, IDLE_TIMEOUT_MS)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(lock, IDLE_TIMEOUT_MS)
    }

    for (const event of ACTIVITY) {
      window.addEventListener(event, reset, { passive: true })
    }
    return () => {
      window.clearTimeout(timer)
      for (const event of ACTIVITY) window.removeEventListener(event, reset)
    }
  }, [locked, staff])

  if (!locked || !staff) return null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setChecking(true)
    setError(null)
    const ok = await unlock(password).catch(() => false)
    setChecking(false)
    if (!ok) {
      setError("That password did not match. Try again.")
      return
    }
    setPassword("")
    setLocked(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="idle-lock-title"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background px-5 sm:px-10"
    >
      <div className="w-full max-w-[420px]">
        <div className="flex items-center gap-4">
          <Avatar>
            <AvatarFallback>{initials(staff.name)}</AvatarFallback>
          </Avatar>
          <MicroLabel tone="ink">{staff.name}</MicroLabel>
        </div>

        <PageTitle id="idle-lock-title" className="mt-8">
          Locked
        </PageTitle>
        <Lede>The counter locked itself after ten quiet minutes.</Lede>

        <form className="mt-10" onSubmit={submit}>
          <Field
            layout="stacked"
            label="Password"
            htmlFor="idle-lock-password"
            error={error}
          >
            <Input
              id="idle-lock-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              aria-invalid={error ? true : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <div className="mt-10">
            <Button type="submit" trailingArrow loading={checking}>
              Continue
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
