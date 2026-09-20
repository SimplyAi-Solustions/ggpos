/**
 * Paid plans: who is on one, when it renews, and the two things staff do
 * with one at the counter (take another period's money, or stop it).
 *
 * A plan pins a tier, so every write here re-evaluates the customer's tier
 * on the server. Nothing is deleted: a cancelled plan stays on the list so
 * the counter can see what happened.
 */
import * as React from "react"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/micro-label"
import { ConfirmDialog } from "@/features/customers/ConfirmDialog"
import { formatShortDate } from "@/features/customers/format"
import { PlanSheet } from "@/features/loyalty/PlanSheet"
import { planLine, type MembershipForm } from "@/features/loyalty/mapping"
import type { LoyaltyTierRecord, MembershipRecord } from "@/lib/api/types"

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

  const paidTiers = tiers.filter((tier) => tier.paid_plan === true)

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
                  onClick={() => setRenewing(membership)}
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
        <Button variant="text" type="button" onClick={() => setRecording(true)}>
          Record a plan
        </Button>
      </div>

      <PlanSheet
        open={recording}
        onOpenChange={setRecording}
        title="Record a plan"
        description="A paid plan pins the tier until it runs out."
        customer={null}
        tiers={paidTiers}
        busy={busy}
        error={error}
        saveLabel="Save plan"
        onSubmit={onRecord}
        onDismissError={onDismissError}
      />

      <PlanSheet
        open={renewing !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setRenewing(null)
        }}
        title="Renew"
        description={
          renewing
            ? `${renewing.customerName}, ${renewing.tierName}. The new date runs from ${formatShortDate(renewing.renews_at)}.`
            : ""
        }
        customer={
          renewing ? { id: renewing.customer, name: renewing.customerName } : null
        }
        tiers={null}
        initial={
          renewing
            ? { price: (renewing.price / 100).toFixed(2), tier: renewing.tier }
            : undefined
        }
        busy={busy}
        error={error}
        saveLabel="Save renewal"
        onSubmit={(form) => onRenew(renewing?.id ?? "", form)}
        onDismissError={onDismissError}
      />

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
