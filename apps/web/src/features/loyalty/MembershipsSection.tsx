/**
 * Paid plans: who is on one, when it renews, and the two things staff do
 * with one at the counter (take another year's money, or stop it).
 *
 * A plan pins a tier, so every write here re-evaluates the customer's tier
 * on the server. Nothing is deleted: a cancelled plan stays on the list of
 * everything so the counter can see what happened.
 */
import * as React from "react"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
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
import { ConfirmDialog } from "@/features/customers/ConfirmDialog"
import { formatShortDate } from "@/features/customers/format"
import { CustomerPicker } from "@/features/loyalty/CustomerPicker"
import { MoneyInput } from "@/features/sell/money-input"
import { poundsToPence } from "@/features/settings/mapping"
import {
  EMPTY_MEMBERSHIP,
  validateMembership,
  type MembershipForm,
} from "@/features/loyalty/mapping"
import type {
  LoyaltyTierRecord,
  MembershipRecord,
  SaleCustomer,
} from "@/lib/api/types"

const NOTE_MAX = 500

export function planLine(membership: MembershipRecord): string {
  const renews = formatShortDate(membership.renews_at)
  if (membership.status === "cancelled") return "Cancelled"
  if (membership.status === "lapsed") return `Lapsed on ${renews}`
  return `Renews ${renews}`
}

/** The fields a plan and a renewal share: how long, how much, and a note. */
function PlanFields({
  draft,
  errors,
  onChange,
}: {
  draft: MembershipForm
  errors: Record<string, string>
  onChange: (patch: Partial<MembershipForm>) => void
}) {
  return (
    <>
      <Field
        label="Months"
        htmlFor="plan-months"
        layout="stacked"
        error={errors.months}
      >
        <Input
          id="plan-months"
          className="tnum"
          inputMode="numeric"
          autoComplete="off"
          maxLength={2}
          trailingHint="months"
          value={draft.months}
          aria-invalid={Boolean(errors.months) || undefined}
          onChange={(event) => onChange({ months: event.target.value })}
        />
      </Field>

      <Field label="Paid" htmlFor="plan-price" layout="stacked" error={errors.price}>
        <MoneyInput
          id="plan-price"
          value={draft.price}
          invalid={Boolean(errors.price)}
          onChange={(next) => onChange({ price: next })}
        />
      </Field>

      <Field label="Note" htmlFor="plan-note" layout="stacked">
        <Textarea
          id="plan-note"
          maxLength={NOTE_MAX}
          placeholder="How they paid, if it is worth recording"
          trailingHint={`${draft.note.length} / ${NOTE_MAX}`}
          value={draft.note}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </Field>
    </>
  )
}

export interface MembershipsSectionProps {
  memberships: MembershipRecord[]
  tiers: LoyaltyTierRecord[]
  busy: boolean
  error: string | null
  onRecord: (form: MembershipForm) => Promise<unknown>
  onRenew: (id: string, form: MembershipForm) => Promise<unknown>
  onCancel: (id: string) => Promise<unknown>
  onDismissError: () => void
}

export function MembershipsSection({
  memberships,
  tiers,
  busy,
  error,
  onRecord,
  onRenew,
  onCancel,
  onDismissError,
}: MembershipsSectionProps) {
  const [recording, setRecording] = React.useState(false)
  const [renewing, setRenewing] = React.useState<MembershipRecord | null>(null)
  const [cancelling, setCancelling] = React.useState<MembershipRecord | null>(null)
  const [chosen, setChosen] = React.useState<SaleCustomer | null>(null)
  const [draft, setDraft] = React.useState<MembershipForm>(EMPTY_MEMBERSHIP)
  const [showErrors, setShowErrors] = React.useState(false)

  const paidTiers = tiers.filter((tier) => tier.paid_plan === true)
  const errors = validateMembership(draft)
  const shown = showErrors ? errors : {}

  function reset() {
    setDraft(EMPTY_MEMBERSHIP)
    setChosen(null)
    setShowErrors(false)
    onDismissError()
  }

  return (
    <>
      <ul data-testid="memberships">
        {memberships.length === 0 ? (
          <li className="py-3 text-[15px] text-muted-foreground-2">
            Nobody is on a paid plan. Record one when somebody buys a pass.
          </li>
        ) : null}
        {memberships.map((membership) => (
          <li
            key={membership.id}
            className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-hairline-soft py-4 first:border-t"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-foreground">
                {membership.customerName}
              </span>
              <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
                {displayCode(membership.customerCode)}
              </span>
            </span>
            <Badge variant="volt">{membership.tierName}</Badge>
            <Hint className="tnum">{planLine(membership)}</Hint>
            <span className="tnum text-[15px] text-foreground">
              {formatGBP(membership.price)}
            </span>
            {membership.status === "active" ? (
              <span className="flex items-center gap-6">
                <Button
                  variant="text"
                  type="button"
                  onClick={() => {
                    setDraft({
                      ...EMPTY_MEMBERSHIP,
                      customer: membership.customer,
                      tier: membership.tier,
                      price: (membership.price / 100).toFixed(2),
                    })
                    setShowErrors(false)
                    setRenewing(membership)
                  }}
                >
                  Renew
                </Button>
                <Button
                  variant="text-destructive"
                  type="button"
                  onClick={() => setCancelling(membership)}
                >
                  Cancel
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-6">
        <Button
          variant="text"
          type="button"
          onClick={() => {
            reset()
            setRecording(true)
          }}
        >
          Record a plan
        </Button>
      </div>

      {/* ---- Record a plan ---- */}
      <Sheet
        open={recording}
        onOpenChange={(open: boolean) => {
          setRecording(open)
          if (!open) reset()
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Record a plan</SheetTitle>
            <SheetDescription>
              A paid plan pins the tier until it runs out.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="flex flex-col gap-8">
              <CustomerPicker
                id="plan-customer"
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
                        paidTiers.find((tier) => tier.id === value)?.name ?? "Pick a tier"
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
                    No tier is marked as a paid plan yet. Mark one in Tiers and perks
                    first.
                  </p>
                ) : null}
              </Field>

              <PlanFields
                draft={draft}
                errors={shown}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
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
                void onRecord(draft).then(() => {
                  setRecording(false)
                  reset()
                })
              }}
            >
              Save plan
            </Button>
            <Button
              variant="text"
              type="button"
              onClick={() => {
                setRecording(false)
                reset()
              }}
            >
              Cancel
            </Button>
            {error ? <FieldError>{error}</FieldError> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* ---- Renew ---- */}
      <Sheet
        open={renewing !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setRenewing(null)
            reset()
          }
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Renew</SheetTitle>
            <SheetDescription>
              {renewing
                ? `${renewing.customerName}, ${renewing.tierName}. The new date runs from ${formatShortDate(renewing.renews_at)}.`
                : ""}
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="flex flex-col gap-8">
              <PlanFields
                draft={draft}
                errors={shown}
                onChange={(patch) =>
                  setDraft((current) => ({ ...current, ...patch }))
                }
              />
            </div>
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              trailingArrow
              loading={busy}
              onClick={() => {
                setShowErrors(true)
                const months = Number(draft.months)
                if (
                  !renewing ||
                  Number.isNaN(months) ||
                  months < 1 ||
                  months > 24 ||
                  poundsToPence(draft.price) === null
                ) {
                  return
                }
                void onRenew(renewing.id, draft).then(() => {
                  setRenewing(null)
                  reset()
                })
              }}
            >
              Save renewal
            </Button>
            <Button
              variant="text"
              type="button"
              onClick={() => {
                setRenewing(null)
                reset()
              }}
            >
              Cancel
            </Button>
            {error ? <FieldError>{error}</FieldError> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setCancelling(null)
            onDismissError()
          }
        }}
        title="Cancel this plan"
        description={
          cancelling
            ? `${cancelling.customerName} goes back to the tier their points earn them. Nothing is refunded here: hand that back through SumUp.`
            : ""
        }
        confirmLabel="Cancel the plan"
        busy={busy}
        error={error}
        onConfirm={() => {
          if (!cancelling) return
          void onCancel(cancelling.id).then(() => setCancelling(null))
        }}
      />
    </>
  )
}
