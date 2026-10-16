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

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  /** The words on the button that does the thing. */
  confirmLabel: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
}

/**
 * A dialog rather than a sheet, because these are the two actions on the
 * profile that cannot be undone and so need protected focus. The block stays
 * black: the red is carried by the link that opened this and by the words,
 * so the one primary button on the screen still looks like every other.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" loading={busy} trailingArrow onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <DialogClose render={<Button variant="text" type="button" />}>
            Cancel
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
