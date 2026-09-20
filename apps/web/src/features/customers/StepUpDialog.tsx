import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { refusalOrFallback, stepUp } from "@/lib/api"

export interface StepUpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  /** The words on the button that does the thing. */
  confirmLabel: string
  /**
   * Runs once the password has been accepted, with the ten-minute token.
   * Returns the one line to show afterwards, or null to just close.
   */
  onConfirm: (token: string) => Promise<string | null>
}

function Body({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: Omit<StepUpDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<string | null>(null)

  async function run(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const token = await stepUp(password)
      const line = await onConfirm(token)
      if (line) setDone(line)
      else onClose()
    } catch (failure) {
      // 400 from the step-up route is a wrong password; 422 from the action
      // is a business rule, such as credit still on the account. Both carry
      // a sentence written for the counter, so both are shown as sent.
      setError(refusalOrFallback(failure, "That did not go through. Try again."))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{done}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" trailingArrow onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form onSubmit={run} noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="mt-5">
        <Field
          label="Your password"
          htmlFor="step-up-password"
          layout="stacked"
          error={error ?? undefined}
        >
          <Input
            id="step-up-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={!!error}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </div>
      <DialogFooter>
        <Button type="submit" loading={busy} trailingArrow>
          {confirmLabel}
        </Button>
        <DialogClose render={<Button variant="text" type="button" />}>
          Cancel
        </DialogClose>
      </DialogFooter>
    </form>
  )
}

/**
 * The two actions on a profile that cannot be undone.
 *
 * Both are step-up routes: the password is re-checked, the server does the
 * whole thing in one transaction, and the answer comes back as one line the
 * counter can read. A dialog rather than a sheet, because this is the one
 * place on the screen that needs protected focus, and the body is mounted
 * only while it is open so a second visit starts from a blank box.
 */
export function StepUpDialog({ open, onOpenChange, ...rest }: StepUpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? <Body {...rest} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
