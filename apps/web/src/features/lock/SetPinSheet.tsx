/**
 * Set your own PIN, from the account menu or the More sheet
 * (docs/api-contract-epos.md, section 2, "Setting a PIN").
 *
 * A sheet, because it is a secondary task: the PIN twice, then your
 * password once through the step-up prompt, since a PIN is a way into the
 * counter as you. Four or six digits, and not a run or a repeat; the shared
 * `pinProblem` says so before anything is sent, in the server's own words.
 * "Remove my PIN" is the destructive text action, for somebody who would
 * rather sign in with a password every time.
 */
import * as React from "react"
import { pinProblem } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { StepUpCancelled, stepUp } from "@/lib/auth-stepup"
import { refusalOrFallback } from "@/lib/api/refusal"
import { clearOwnPin, setOwnPin } from "@/lib/api/staff"

/** Digits only, at most six, as they are typed. */
function digits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 6)
}

function PinForm({ onDone }: { onDone: (said: string) => void }) {
  const [pin, setPin] = React.useState("")
  const [again, setAgain] = React.useState("")
  const [problem, setProblem] = React.useState<{ field: "pin" | "again" | "form"; message: string } | null>(
    null
  )
  const [busy, setBusy] = React.useState<"save" | "remove" | null>(null)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const rule = pinProblem(pin)
    if (rule) {
      setProblem({ field: "pin", message: rule })
      return
    }
    if (again !== pin) {
      setProblem({ field: "again", message: "The two PINs are different. Type the same one twice." })
      return
    }
    setProblem(null)
    setBusy("save")
    try {
      await setOwnPin(pin, await stepUp())
      onDone("Your PIN is set. Use it at the lock screen on any till.")
    } catch (cause) {
      if (!(cause instanceof StepUpCancelled)) {
        setProblem({ field: "pin", message: refusalOrFallback(cause, "Your PIN did not save. Try again.") })
      }
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setProblem(null)
    setBusy("remove")
    try {
      await clearOwnPin(await stepUp())
      onDone("Your PIN is removed. Sign in with your password at the lock screen.")
    } catch (cause) {
      if (!(cause instanceof StepUpCancelled)) {
        setProblem({ field: "form", message: refusalOrFallback(cause, "Your PIN was not removed. Try again.") })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="Set your PIN">
      <SheetBody>
        <FieldRow>
          <Field
            layout="stacked"
            label="New PIN"
            hint="4 or 6 digits"
            htmlFor="own-pin"
            error={problem?.field === "pin" ? problem.message : null}
          >
            <Input
              id="own-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              autoFocus
              className="tnum font-mono tracking-[0.3em]"
              value={pin}
              aria-invalid={problem?.field === "pin" ? true : undefined}
              onChange={(event) => setPin(digits(event.target.value))}
            />
          </Field>
          <Field
            layout="stacked"
            label="New PIN again"
            htmlFor="own-pin-again"
            error={problem?.field === "again" ? problem.message : null}
          >
            <Input
              id="own-pin-again"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              className="tnum font-mono tracking-[0.3em]"
              value={again}
              aria-invalid={problem?.field === "again" ? true : undefined}
              onChange={(event) => setAgain(digits(event.target.value))}
            />
          </Field>
        </FieldRow>
        {problem?.field === "form" ? (
          <p role="alert" className="mt-6 text-[13px] text-destructive">
            {problem.message}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy === "save"} disabled={busy !== null}>
          Save PIN
        </Button>
        <Button
          type="button"
          variant="text-destructive"
          disabled={busy !== null}
          onClick={() => void remove()}
        >
          Remove my PIN
        </Button>
      </SheetFooter>
    </form>
  )
}

export function SetPinSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // What happened, said in the sheet itself rather than in a toast, until
  // the sheet is closed.
  const [said, setSaid] = React.useState<string | null>(null)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setSaid(null)
        onOpenChange(next)
      }}
    >
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Set your PIN</SheetTitle>
          <SheetDescription>
            Your PIN unlocks the till as you, and switches user without
            signing anybody out. Your password confirms the change.
          </SheetDescription>
        </SheetHeader>
        {said ? (
          <>
            <SheetBody>
              <p data-testid="pin-saved" aria-live="polite" className="text-[15px] leading-[1.5] text-foreground">
                {said}
              </p>
            </SheetBody>
            <SheetFooter>
              <Button
                onClick={() => {
                  setSaid(null)
                  onOpenChange(false)
                }}
              >
                Done
              </Button>
            </SheetFooter>
          </>
        ) : open ? (
          <PinForm onDone={setSaid} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
