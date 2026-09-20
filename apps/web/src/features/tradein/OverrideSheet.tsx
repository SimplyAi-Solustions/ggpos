import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { MoneyField } from "@/features/tradein/MoneyField"

export interface OverrideValues {
  cash: number
  credit: number
  reason: string
}

export interface OverrideSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  initial: OverrideValues
  onSave: (values: OverrideValues) => void
  onClear?: () => void
  /** True when this line is already overridden. */
  overridden?: boolean
}

/**
 * Changing what the shop offers for one line.
 *
 * The reason is required: `docs/PLAN.md` puts overrides in the audit log, and
 * an audit row that says only "someone changed it" is worth nothing. A sheet
 * rather than a dialog, because it is a secondary action and because the
 * keyboard needs the top of the screen on a phone.
 */
export function OverrideSheet({
  open,
  onOpenChange,
  title,
  initial,
  onSave,
  onClear,
  overridden = false,
}: OverrideSheetProps) {
  const [cash, setCash] = React.useState(initial.cash)
  const [credit, setCredit] = React.useState(initial.credit)
  const [reason, setReason] = React.useState(initial.reason)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setCash(initial.cash)
    setCredit(initial.credit)
    setReason(initial.reason)
    setError(null)
  }, [open, initial.cash, initial.credit, initial.reason])

  function save() {
    if (reason.trim().length < 3) {
      setError("Say why the offer is different. It goes in the audit log.")
      return
    }
    onSave({ cash, credit, reason: reason.trim() })
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Override the offer</SheetTitle>
          <SheetDescription>{title}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-col gap-8">
            <Field label="Cash" htmlFor="override-cash" layout="stacked">
              <MoneyField
                id="override-cash"
                label="Cash offer for this line"
                value={cash}
                onChange={setCash}
              />
            </Field>
            <Field label="Store credit" htmlFor="override-credit" layout="stacked">
              <MoneyField
                id="override-credit"
                label="Store credit offer for this line"
                value={credit}
                onChange={setCredit}
              />
            </Field>
            <Field
              label="Reason"
              htmlFor="override-reason"
              layout="stacked"
              error={error ?? undefined}
            >
              <Textarea
                id="override-reason"
                maxLength={200}
                aria-invalid={!!error}
                placeholder="Edge wear the photo does not show"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                trailingHint={`${reason.length} / 200`}
              />
            </Field>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button type="button" trailingArrow onClick={save}>
            Save override
          </Button>
          {overridden && onClear ? (
            <Button
              variant="text"
              type="button"
              onClick={() => {
                onClear()
                onOpenChange(false)
              }}
            >
              Back to the rule
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
