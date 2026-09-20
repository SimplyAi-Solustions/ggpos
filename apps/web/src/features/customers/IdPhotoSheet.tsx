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
 * The ID photo, for an admin who has just confirmed their password.
 *
 * Two gates, in the order `docs/PLAN.md` sets out: the step-up route checks
 * the password and hands back a ten-minute token, then the photo route
 * writes its audit row, decrypts and streams the image. The blob URL is
 * revoked the moment the sheet closes, so the picture does not sit in memory
 * behind a shared counter screen.
 */
export function IdPhotoSheet({
  open,
  onOpenChange,
  customerId,
  customerName,
}: IdPhotoSheetProps) {
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [photo, setPhoto] = React.useState<string | null>(null)

  // Revoke on the way out: an object URL holds the decrypted bytes alive
  // until it is released.
  React.useEffect(() => {
    if (open) return
    setPassword("")
    setError(null)
    setBusy(false)
    setPhoto((current) => {
      if (current?.startsWith("blob:")) URL.revokeObjectURL(current)
      return null
    })
  }, [open])

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
      setPhoto(await fetchIdPhoto(documentId, token))
    } catch (failure) {
      setError(
        refusalOrFallback(failure, "Confirm your password to continue.")
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
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
      </SheetContent>
    </Sheet>
  )
}
