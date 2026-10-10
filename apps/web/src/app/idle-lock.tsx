import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { MicroLabel } from "@/components/ui/micro-label"
import { useKeyGuard } from "@/features/lock/key-guard"
import { unlockCounter } from "@/features/lock/lock-store"
import { confirmPassword, initials, useStaff } from "@/lib/auth"

/**
 * The password lock: the counter's lock on a browser that is not a
 * registered till (DESIGN.md section 10: "An unregistered device shows no
 * lock screen and no roster: the password idle lock, as before").
 *
 * A full-screen paper panel over the counter. It is not a dialog over a
 * dimmed page: there is nothing behind it to go back to until the signed-in
 * member's password is right. It is a Base UI dialog underneath only so it
 * takes the focus trap from anything already open behind it, and the
 * keyboard guard keeps every key from reaching the counter.
 *
 * `features/lock/CounterLock.tsx` decides when it shows: after ten quiet
 * minutes, or when the Lock key or the account menu locks the counter.
 */
export function PasswordLock() {
  const staff = useStaff()
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)

  useKeyGuard({ active: true })

  if (!staff) return null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setChecking(true)
    setError(null)
    const ok = await confirmPassword(password).catch(() => false)
    setChecking(false)
    if (!ok) {
      setError("That password did not match. Try again.")
      return
    }
    setPassword("")
    unlockCounter()
  }

  return (
    <DialogPrimitive.Root open modal disablePointerDismissal onOpenChange={() => {}}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          data-slot="password-lock"
          aria-labelledby="idle-lock-title"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-y-auto bg-background px-5 text-foreground outline-none sm:px-10"
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
            <Lede>The counter is locked. Enter your password to carry on.</Lede>

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
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
