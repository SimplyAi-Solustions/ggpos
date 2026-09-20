import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { fetchIdPhoto, latestIdDocument, refusalOrFallback, stepUp } from "@/lib/api"

export interface IdPhotoSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customerId: string
  customerName: string
}

/**
 * The step-up and the photo itself.
 *
 * Mounted only while the sheet is open, so every open starts from a blank
 * password box rather than resetting state on the way out, and the blob URL
 * is revoked by this component's own unmount: an object URL holds the
 * decrypted bytes alive until it is released, and a shared counter screen is
 * the last place to leave them lying about.
 */
function IdPhotoBody({
  customerId,
  customerName,
}: {
  customerId: string
  customerName: string
}) {
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [photo, setPhoto] = React.useState<string | null>(null)
  const photoRef = React.useRef<string | null>(null)

  React.useEffect(
    () => () => {
      if (photoRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(photoRef.current)
      }
    },
    []
  )

  async function confirm(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const token = await stepUp(password)
      const documentId = await latestIdDocument(customerId)
      if (!documentId) {
        setError(
          "No ID photo is stored for this customer, or it has passed its retention date."
        )
        return
      }
      const url = await fetchIdPhoto(documentId, token)
      photoRef.current = url
      setPhoto(url)
    } catch (failure) {
      setError(refusalOrFallback(failure, "Confirm your password to continue."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>ID photo</SheetTitle>
        <SheetDescription>
          {photo
            ? `Held for ${customerName}. Opening it was recorded in the audit log.`
            : "Confirm your password. Opening an ID photo is recorded in the audit log."}
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        {photo ? (
          <img
            src={photo}
            alt={`Identity document on file for ${customerName}`}
            className="w-full border border-hairline"
          />
        ) : (
          <form onSubmit={confirm} noValidate>
            <Field
              label="Password"
              htmlFor="id-photo-password"
              layout="stacked"
              error={error ?? undefined}
            >
              <Input
                id="id-photo-password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!error}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <div className="mt-8">
              <Button type="submit" loading={busy} trailingArrow>
                Continue
              </Button>
            </div>
          </form>
        )}
      </SheetBody>
    </>
  )
}

/** Admin only, and only after a password: `docs/PLAN.md`, "Security". */
export function IdPhotoSheet({
  open,
  onOpenChange,
  customerId,
  customerName,
}: IdPhotoSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        {open ? (
          <IdPhotoBody customerId={customerId} customerName={customerName} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
