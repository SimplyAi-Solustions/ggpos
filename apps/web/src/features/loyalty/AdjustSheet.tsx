/**
 * Moving somebody's points by hand.
 *
 * Admin only and behind a step-up, the way a refund is: it is the one place
 * points appear from nowhere, so the password is asked for again and the
 * reason is written onto the customer's record with it. The balance can
 * never go below zero, and the sentence that says so is the server's own.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
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
import { Textarea } from "@/components/ui/textarea"
import { StepUpCancelled, stepUp } from "@/lib/auth-stepup"
import { adjustPoints } from "@/lib/api/loyalty"
import { refusalOrFallback } from "@/lib/api/refusal"
import { CustomerPicker } from "@/features/loyalty/CustomerPicker"
import {
  EMPTY_ADJUST,
  validateAdjust,
  parseSigned,
  type AdjustForm,
} from "@/features/loyalty/mapping"
import type { SaleCustomer } from "@/lib/api/types"

const REASON_MAX = 500

export interface AdjustTarget {
  id: string
  name: string
  code: string
  pointsBalance: number
}

export interface AdjustSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fixed on a customer's own profile; picked on the Loyalty screen. */
  target?: AdjustTarget | null
  onDone: (result: { customer: string; balance: number }) => void
}

export function AdjustSheet({
  open,
  onOpenChange,
  target = null,
  onDone,
}: AdjustSheetProps) {
  const [chosen, setChosen] = React.useState<SaleCustomer | null>(null)
  const [draft, setDraft] = React.useState<AdjustForm>(EMPTY_ADJUST)
  const [showErrors, setShowErrors] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const customerId = target?.id ?? chosen?.id ?? ""
  const balance = target?.pointsBalance ?? chosen?.pointsBalance ?? 0
  const form: AdjustForm = { ...draft, customer: customerId }
  const errors = validateAdjust(form, balance)
  const shown = showErrors ? errors : {}

  function reset() {
    setDraft(EMPTY_ADJUST)
    setChosen(null)
    setShowErrors(false)
    setError(null)
    setBusy(false)
  }

  async function save() {
    setShowErrors(true)
    if (Object.keys(errors).length > 0) return
    setBusy(true)
    setError(null)
    try {
      const token = await stepUp()
      const result = await adjustPoints(
        {
          customer: customerId,
          delta: parseSigned(draft.delta) ?? 0,
          reason: draft.reason.trim(),
        },
        token
      )
      onDone({ customer: customerId, balance: result.balance })
      onOpenChange(false)
      reset()
    } catch (problem) {
      if (problem instanceof StepUpCancelled) {
        setBusy(false)
        return
      }
      setError(
        refusalOrFallback(problem, "Those points did not move. Try it again.")
      )
      setBusy(false)
      return
    }
    setBusy(false)
  }

  const delta = parseSigned(draft.delta)

  return (
    <Sheet
      open={open}
      onOpenChange={(next: boolean) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Adjust points</SheetTitle>
          <SheetDescription>
            {target
              ? `${target.name} has ${target.pointsBalance.toLocaleString("en-GB")} points. This asks for your password.`
              : "It asks for your password, and the reason goes on their record."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-col gap-8">
            {target ? null : (
              <CustomerPicker
                id="adjust-customer"
                chosen={chosen}
                error={shown.customer}
                onChoose={(customer) => {
                  setChosen(customer)
                  setDraft((current) => ({
                    ...current,
                    customer: customer?.id ?? "",
                    customerName: customer?.name ?? "",
                  }))
                }}
              />
            )}

            <Field
              label="Points"
              htmlFor="adjust-delta"
              layout="stacked"
              error={shown.delta}
            >
              <Input
                id="adjust-delta"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                placeholder="250, or -250 to take some away"
                value={draft.delta}
                aria-invalid={Boolean(shown.delta) || undefined}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, delta: event.target.value }))
                }
              />
              {delta !== null && delta !== 0 && !shown.delta ? (
                <p
                  aria-live="polite"
                  className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2"
                >
                  They would hold {(balance + delta).toLocaleString("en-GB")} points.
                </p>
              ) : null}
            </Field>

            <Field
              label="Reason"
              htmlFor="adjust-reason"
              layout="stacked"
              error={shown.reason}
            >
              <Textarea
                id="adjust-reason"
                maxLength={REASON_MAX}
                placeholder="Goodwill after a mis-priced sale"
                trailingHint={`${draft.reason.length} / ${REASON_MAX}`}
                value={draft.reason}
                aria-invalid={Boolean(shown.reason) || undefined}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, reason: event.target.value }))
                }
              />
            </Field>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button type="button" trailingArrow loading={busy} onClick={() => void save()}>
            Adjust points
          </Button>
          <Button
            variant="text"
            type="button"
            onClick={() => {
              onOpenChange(false)
              reset()
            }}
          >
            Cancel
          </Button>
          {error ? <FieldError>{error}</FieldError> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
