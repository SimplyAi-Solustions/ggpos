/**
 * Recording a paid plan, or renewing one.
 *
 * The same sheet does both, and both from either screen: the Loyalty screen
 * searches for the customer, the customer's own profile already knows who it
 * is. A renewal has no tier to pick, because a plan never changes tier: it
 * is cancelled and a new one recorded instead.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { CustomerPicker } from "@/features/loyalty/CustomerPicker"
import { MoneyInput } from "@/features/sell/money-input"
import {
  EMPTY_MEMBERSHIP,
  validateMembership,
  type MembershipForm,
} from "@/features/loyalty/mapping"
import type { LoyaltyTierRecord, SaleCustomer } from "@/lib/api/types"

const NOTE_MAX = 500

export interface PlanSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  /** Already known on a profile; searched for on the Loyalty screen. */
  customer: { id: string; name: string } | null
  /** The paid-plan tiers to choose from, or null when renewing. */
  tiers: LoyaltyTierRecord[] | null
  initial?: Partial<MembershipForm>
  busy: boolean
  error: string | null
  saveLabel: string
  onSubmit: (form: MembershipForm) => Promise<unknown>
  onDismissError: () => void
}

export function PlanSheet({
  open,
  onOpenChange,
  title,
  description,
  customer,
  tiers,
  initial,
  busy,
  error,
  saveLabel,
  onSubmit,
  onDismissError,
}: PlanSheetProps) {
  const [chosen, setChosen] = React.useState<SaleCustomer | null>(null)
  const [draft, setDraft] = React.useState<MembershipForm>({
    ...EMPTY_MEMBERSHIP,
    ...initial,
    customer: customer?.id ?? initial?.customer ?? "",
  })
  const [showErrors, setShowErrors] = React.useState(false)

  // The sheet is mounted while it is open, so a second opening starts from
  // the values it was given rather than from the last one's leftovers.
  // React's own "adjusting state while rendering" pattern: the comparison
  // is state rather than a ref, so the re-render happens before anything is
  // painted with the old draft in it.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDraft({
        ...EMPTY_MEMBERSHIP,
        ...initial,
        customer: customer?.id ?? initial?.customer ?? "",
      })
      setChosen(null)
      setShowErrors(false)
    }
  }

  const form: MembershipForm = {
    ...draft,
    customer: customer?.id ?? chosen?.id ?? draft.customer,
    // A renewal has its tier from the plan it is renewing.
    tier: tiers ? draft.tier : draft.tier || "renewal",
  }
  const errors = validateMembership(form)
  const shown = showErrors ? errors : {}
  const paidTiers = tiers ?? []

  return (
    <Sheet
      open={open}
      onOpenChange={(next: boolean) => {
        onOpenChange(next)
        if (!next) onDismissError()
      }}
    >
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-col gap-8">
            {customer ? null : (
              <CustomerPicker
                id="plan-customer"
                chosen={chosen}
                error={shown.customer}
                onChoose={(next) => {
                  setChosen(next)
                  setDraft((current) => ({
                    ...current,
                    customer: next?.id ?? "",
                    customerName: next?.name ?? "",
                  }))
                }}
              />
            )}

            {tiers ? (
              <Field label="Tier" layout="stacked" error={shown.tier}>
                <Select
                  value={draft.tier || null}
                  onValueChange={(next: string | null) =>
                    setDraft((current) => ({ ...current, tier: next ?? "" }))
                  }
                >
                  <SelectTrigger aria-label="The tier this plan grants">
                    <SelectValue placeholder="Pick a tier">
                      {(value: string) =>
                        paidTiers.find((tier) => tier.id === value)?.name ??
                        "Pick a tier"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {paidTiers.map((tier) => (
                      <SelectItem key={tier.id} value={tier.id}>
                        {tier.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {paidTiers.length === 0 ? (
                  <p className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                    No tier is a paid plan yet. Mark one as a paid plan on the
                    Loyalty screen first.
                  </p>
                ) : null}
              </Field>
            ) : null}

            <Field label="Months" htmlFor="plan-months" layout="stacked" error={shown.months}>
              <Input
                id="plan-months"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={2}
                trailingHint="months"
                value={draft.months}
                aria-invalid={Boolean(shown.months) || undefined}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, months: event.target.value }))
                }
              />
            </Field>

            <Field label="Paid" htmlFor="plan-price" layout="stacked" error={shown.price}>
              <MoneyInput
                id="plan-price"
                value={draft.price}
                invalid={Boolean(shown.price)}
                onChange={(next) =>
                  setDraft((current) => ({ ...current, price: next }))
                }
              />
            </Field>

            <Field label="Note" htmlFor="plan-note" layout="stacked">
              <Textarea
                id="plan-note"
                maxLength={NOTE_MAX}
                placeholder="How they paid, if it is worth recording"
                trailingHint={`${draft.note.length} / ${NOTE_MAX}`}
                value={draft.note}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, note: event.target.value }))
                }
              />
            </Field>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            trailingArrow
            loading={busy}
            onClick={() => {
              setShowErrors(true)
              if (Object.keys(errors).length > 0) return
              // The refusal is already shown in the footer by the caller's
              // mutation, so this only has to not become an unhandled
              // rejection: the sheet stays open with the message on it.
              void onSubmit(form).then(
                () => onOpenChange(false),
                () => {}
              )
            }}
          >
            {saveLabel}
          </Button>
          <Button variant="text" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {error ? <FieldError>{error}</FieldError> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
