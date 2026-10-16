/**
 * The step-up prompt: "Confirm your password to continue."
 *
 * A dialog rather than a sheet because it is the one kind of task DESIGN.md
 * says needs protected focus. `stepUp()` in `auth-stepup.ts` mounts it on
 * demand, so any screen (a refund here, an ID photo on the customers screen)
 * can await one line and get the same paper panel.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export interface StepUpDialogProps {
  /** Called with the typed password, or null when the dialog is dismissed. */
  onDone: (password: string | null) => void
}

export function StepUpDialog({ onDone }: StepUpDialogProps) {
  const [open, setOpen] = React.useState(true)
  const [password, setPassword] = React.useState("")

  function close(result: string | null) {
    setOpen(false)
    onDone(result)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close(null)
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby="step-up-why">
        <DialogHeader>
          <DialogTitle>Confirm your password to continue</DialogTitle>
          <DialogDescription id="step-up-why">
            This one needs a second check. Your password unlocks it for ten
            minutes.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (password) close(password)
          }}
        >
          <Field layout="stacked" label="Password" htmlFor="step-up-password">
            <Input
              id="step-up-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <DialogFooter>
            <Button type="submit" trailingArrow disabled={!password}>
              Continue
            </Button>
            <Button variant="text" type="button" onClick={() => close(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
