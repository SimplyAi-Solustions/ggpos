/**
 * The step-up prompt: "Confirm your password to continue."
 *
 * It mounts its own React root on demand rather than living in the counter
 * shell, so any screen (a refund here, an ID photo on the customers screen)
 * can await one line and get the same paper dialog with protected focus.
 */
import * as React from "react"
import { createRoot, type Root } from "react-dom/client"

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

function PasswordDialog({
  onDone,
}: {
  onDone: (password: string | null) => void
}) {
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

let host: HTMLDivElement | null = null
let root: Root | null = null

/** Resolves with the typed password, or null when the dialog is dismissed. */
export function askForPassword(): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null)

  if (!host) {
    host = document.createElement("div")
    host.setAttribute("data-slot", "step-up-host")
    document.body.appendChild(host)
    root = createRoot(host)
  }

  return new Promise((resolve) => {
    root?.render(
      <PasswordDialog
        onDone={(password) => {
          // Let the dialog play its 200ms exit before it is torn down.
          window.setTimeout(() => root?.render(null), 250)
          resolve(password)
        }}
      />
    )
  })
}
