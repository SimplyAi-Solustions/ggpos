import * as React from "react"

import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

export interface IdPhotoSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** An object URL for the decrypted photo, fetched by the profile. */
  url: string | null
  customerName: string
}

/**
 * The ID photo, once the counter has confirmed a password and the server has
 * decrypted it.
 *
 * The password prompt is the counter's one shared step-up dialog
 * (`lib/auth-stepup.ts`), so this is only the viewer. The object URL holds
 * the decrypted bytes alive until it is released, and a shared counter PC is
 * the last place to leave them lying about, so it is revoked the moment the
 * sheet closes.
 */
export function IdPhotoSheet({
  open,
  onOpenChange,
  url,
  customerName,
}: IdPhotoSheetProps) {
  React.useEffect(() => {
    if (!url) return undefined
    return () => {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url)
    }
  }, [url])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>ID photo</SheetTitle>
          <SheetDescription>
            Held for {customerName}. Opening it was recorded in the audit log.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {url ? (
            <img
              src={url}
              alt={`Identity document on file for ${customerName}`}
              className="w-full border border-hairline"
            />
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
