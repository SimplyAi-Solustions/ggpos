/**
 * The Guild block on a customer's profile: what tier they are on, what the
 * tier gives them this month, the plan they pay for, who sent them in, the
 * vouchers they are holding, and every points row behind the balance.
 *
 * It is the counter's half of My Vault's Guild screen, so the wording and
 * the arithmetic match: the window total decides the tier, a paid plan pins
 * it, and a spent perk says when the next one comes rather than going grey
 * without a reason.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { ConfirmDialog } from "@/features/customers/ConfirmDialog"
import { formatShortDate } from "@/features/customers/format"
import { AdjustSheet } from "@/features/loyalty/AdjustSheet"
import { PlanSheet } from "@/features/loyalty/PlanSheet"
import { planLine } from "@/features/loyalty/MembershipsSection"
import { PERK_LABEL, isCountedPerk, perkCountLine, perkValueLine, remaining } from "@/features/loyalty/perks"
import { POINTS_REASON_LABEL } from "@/features/loyalty/ledger"
import { voucherStatusWord, voucherWorth } from "@/features/loyalty/vouchers"
import type { MembershipForm } from "@/features/loyalty/mapping"
import { parseCount, poundsToPence } from "@/features/settings/mapping"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  cancelMembership,
  getCustomerGuild,
  getLoyaltyAdmin,
  getPointsLedger,
  recordMembership,
  renewMembership,
  usePerk,
} from "@/lib/api/loyalty"
import type {
  CountedPerkType,
  CustomerGuild,
  MembershipRecord,
} from "@/lib/api/types"

function Row({
  label,
  children,
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-hairline-soft py-3 first:border-t">
      {label}
      {children}
    </div>
  )
}

/** The points history, newest first, with the sentence for each row. */
function PointsHistorySheet({
  open,
  onOpenChange,
  customerId,
  customerName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customerId: string
  customerName: string
}) {
  const { data = [], isPending } = useQuery({
    queryKey: ["points-ledger", customerId],
    queryFn: () => getPointsLedger(customerId),
    enabled: open && Boolean(customerId),
    staleTime: 30_000,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Points history</SheetTitle>
          <SheetDescription>{customerName}, newest first.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {isPending ? <SkeletonText lines={5} /> : null}
          {!isPending && data.length === 0 ? (
            <p className="text-[15px] leading-[1.5] text-muted-foreground">
              No points have been earned or spent yet.
            </p>
          ) : null}
          <ul data-testid="points-history">
            {data.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">
                    {row.note}
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground-2">
                    {POINTS_REASON_LABEL[row.reason] ?? row.reason} ·{" "}
                    {formatShortDate(row.created)}
                    {row.ref ? ` · ${row.ref}` : ""}
                  </span>
                </span>
                <span className="tnum text-[15px] text-foreground">
                  {row.delta > 0 ? "+" : ""}
                  {row.delta.toLocaleString("en-GB")}
                </span>
                <span className="tnum w-20 shrink-0 text-right text-[13px] text-muted-foreground-2">
                  {row.balance_after.toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

export interface GuildSectionProps {
  customerId: string
  customerName: string
  /** The cached balance from `customer_private`, for the adjustment sheet. */
  pointsBalance: number
  customerCode: string
}

export function GuildSection({
  customerId,
  customerName,
  customerCode,
  pointsBalance,
}: GuildSectionProps) {
  const queryClient = useQueryClient()
  const staff = useStaff()
  const isAdmin = staff?.role === "admin"

  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [adjustOpen, setAdjustOpen] = React.useState(false)
  const [planOpen, setPlanOpen] = React.useState(false)
  const [renewing, setRenewing] = React.useState<MembershipRecord | null>(null)
  const [cancelling, setCancelling] = React.useState<MembershipRecord | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const guildQuery = useQuery({
    queryKey: ["customer-guild", customerId],
    queryFn: () => getCustomerGuild(customerId),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  })
  const guild: CustomerGuild | undefined = guildQuery.data

  // Only needed when a plan is being recorded, so it waits for the sheet.
  const { data: admin } = useQuery({
    queryKey: ["loyalty-admin"],
    queryFn: getLoyaltyAdmin,
    enabled: planOpen && isAdmin,
    staleTime: 60_000,
  })

  function settle() {
    void queryClient.invalidateQueries({ queryKey: ["customer-guild", customerId] })
    void queryClient.invalidateQueries({ queryKey: ["customer"] })
    void queryClient.invalidateQueries({ queryKey: ["memberships"] })
    void queryClient.invalidateQueries({ queryKey: ["points-ledger", customerId] })
  }

  const spendPerk = useMutation({
    mutationFn: (type: CountedPerkType) => usePerk(customerId, type, 1),
    onSuccess: (entry) => {
      setError(null)
      setNote(
        `${PERK_LABEL[entry.type]}: ${remaining(entry).toLocaleString("en-GB")} left this month.`
      )
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That perk was not used. Try again.")),
  })

  const plan = useMutation({
    mutationFn: (form: MembershipForm) =>
      recordMembership({
        customer: customerId,
        tier: form.tier,
        months: parseCount(form.months) ?? 12,
        price: poundsToPence(form.price) ?? 0,
        payment_note: form.note.trim() || undefined,
      }),
    onSuccess: (membership) => {
      setError(null)
      setNote(`${membership.tierName} recorded. ${planLine(membership)}.`)
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That plan was not recorded.")),
  })

  const renew = useMutation({
    mutationFn: ({ id, form }: { id: string; form: MembershipForm }) =>
      renewMembership(id, {
        months: parseCount(form.months) ?? 12,
        price: poundsToPence(form.price) ?? 0,
        payment_note: form.note.trim() || undefined,
      }),
    onSuccess: (membership) => {
      setError(null)
      setNote(`Renewed. ${planLine(membership)}.`)
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That renewal did not go through.")),
  })

  const stop = useMutation({
    mutationFn: (id: string) => cancelMembership(id),
    onSuccess: () => {
      setError(null)
      setCancelling(null)
      setNote("The plan is cancelled. Their tier goes back to what their points earn.")
      settle()
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That plan was not cancelled.")),
  })

  if (guildQuery.isPending) {
    return (
      <div className="mt-24">
        <SectionHeading className="mt-0">Guild</SectionHeading>
        <SkeletonText lines={4} />
      </div>
    )
  }

  if (!guild) {
    return (
      <div className="mt-24">
        <SectionHeading className="mt-0">Guild</SectionHeading>
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          The Guild details would not load. Check the connection and try again.
        </p>
      </div>
    )
  }

  const counted = guild.perks.filter((perk) => isCountedPerk(perk.type))
  const informational = guild.perks.filter((perk) => !isCountedPerk(perk.type))
  const openVouchers = guild.vouchers.filter((voucher) => voucher.status === "issued")

  return (
    <div className="mt-24" data-testid="guild-section">
      <SectionHeading className="mt-0">Guild</SectionHeading>

      <div className="flex flex-wrap items-end gap-x-14 gap-y-6">
        <div>
          <MicroLabel className="mb-2">Tier</MicroLabel>
          <span data-testid="guild-tier">
            <Badge variant="volt">{guild.tier?.name ?? "No tier yet"}</Badge>
          </span>
        </div>
        <div>
          <MicroLabel className="mb-2">In the window</MicroLabel>
          <p
            data-testid="guild-window"
            className="tnum text-[20px] leading-none font-medium text-foreground"
          >
            {guild.windowPoints.toLocaleString("en-GB")}
          </p>
        </div>
        <div>
          <MicroLabel className="mb-2">Next tier</MicroLabel>
          <p className="tnum text-[20px] leading-none font-medium text-foreground">
            {guild.next
              ? `${guild.next.points.toLocaleString("en-GB")} to ${guild.next.name}`
              : "At the top"}
          </p>
        </div>
      </div>

      {/* ---- Perks ---- */}
      <MicroLabel tone="ink" className="mt-12 mb-4">
        Perks
      </MicroLabel>
      {guild.perks.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          This tier carries no perks.
        </p>
      ) : (
        <ul className="max-w-[40rem]" data-testid="perk-wallet">
          {counted.map((perk) => (
            <Row
              key={perk.type}
              label={
                <span className="min-w-0">
                  <span className="block text-[15px] text-foreground">
                    {PERK_LABEL[perk.type]}
                  </span>
                  <span
                    data-testid={`perk-${perk.type}`}
                    className="tnum block text-[13px] text-muted-foreground-2"
                  >
                    {perkCountLine(perk)}
                  </span>
                </span>
              }
            >
              <Button
                variant="text"
                type="button"
                disabled={remaining(perk) <= 0 || spendPerk.isPending}
                onClick={() => spendPerk.mutate(perk.type as CountedPerkType)}
              >
                Use one
              </Button>
            </Row>
          ))}
          {informational.map((perk) => (
            <Row
              key={perk.type}
              label={
                <span className="min-w-0">
                  <span className="block text-[15px] text-foreground">
                    {PERK_LABEL[perk.type]}
                  </span>
                  <span className="block text-[13px] text-muted-foreground-2">
                    {perkValueLine(perk)}
                  </span>
                </span>
              }
            >
              <Hint>Applied at the till</Hint>
            </Row>
          ))}
        </ul>
      )}

      {/* ---- Membership ---- */}
      <MicroLabel tone="ink" className="mt-12 mb-4">
        Membership
      </MicroLabel>
      {guild.membership ? (
        <div className="flex max-w-[40rem] flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft pb-4">
          <Badge variant="volt">{guild.membership.tierName}</Badge>
          <Hint className="tnum">{planLine(guild.membership)}</Hint>
          <span className="tnum text-[15px] text-foreground">
            {formatGBP(guild.membership.price)}
          </span>
          <Button
            variant="text"
            type="button"
            onClick={() => setRenewing(guild.membership)}
          >
            Renew
          </Button>
          <Button
            variant="text-destructive"
            type="button"
            onClick={() => setCancelling(guild.membership)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <p className="text-[15px] text-muted-foreground-2">
            No paid plan. Their tier is whatever their points earn.
          </p>
          {isAdmin ? (
            <Button variant="text" type="button" onClick={() => setPlanOpen(true)}>
              Record a plan
            </Button>
          ) : null}
        </div>
      )}

      {/* ---- Referrals ---- */}
      <MicroLabel tone="ink" className="mt-12 mb-4">
        Referrals
      </MicroLabel>
      <div className="max-w-[40rem]">
        <Row label={<MicroLabel>Referred by</MicroLabel>}>
          <span className="text-[15px] text-foreground">
            {guild.referral.referredBy
              ? `${guild.referral.referredBy.name} (${displayCode(guild.referral.referredBy.code)})`
              : "Nobody"}
          </span>
        </Row>
        <Row label={<MicroLabel>They referred</MicroLabel>}>
          <span className="tnum text-[15px] text-foreground">
            {guild.referral.earned.toLocaleString("en-GB")} earned,{" "}
            {guild.referral.pending.toLocaleString("en-GB")} waiting
          </span>
        </Row>
      </div>

      {/* ---- Vouchers ---- */}
      <MicroLabel tone="ink" className="mt-12 mb-4">
        Vouchers
      </MicroLabel>
      {openVouchers.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          No open vouchers.
        </p>
      ) : (
        <ul className="max-w-[40rem]" data-testid="customer-vouchers">
          {openVouchers.map((voucher) => (
            <Row
              key={voucher.id}
              label={
                <span className="min-w-0">
                  <span className="block text-[15px] text-foreground">
                    {voucher.rewardName}
                  </span>
                  <span className="tnum block font-mono text-[13px] text-muted-foreground-2">
                    {displayCode(voucher.code)}
                  </span>
                </span>
              }
            >
              <span className="flex items-center gap-6">
                <Hint className="tnum">
                  {voucher.expiresAt
                    ? `Until ${formatShortDate(voucher.expiresAt)}`
                    : "No expiry"}
                </Hint>
                <span className="text-[15px] text-foreground">
                  {voucherWorth(voucher.type, voucher.value)}
                </span>
                <Badge variant="outline">{voucherStatusWord(voucher.status)}</Badge>
              </span>
            </Row>
          ))}
        </ul>
      )}

      {/* ---- Points ---- */}
      <div className="mt-10 flex flex-wrap items-center gap-x-10 gap-y-4">
        <Button variant="text" type="button" onClick={() => setHistoryOpen(true)}>
          Points history
        </Button>
        {isAdmin ? (
          <Button variant="text" type="button" onClick={() => setAdjustOpen(true)}>
            Adjust points
          </Button>
        ) : null}
        {note ? (
          <p
            role="status"
            className="max-w-[46ch] text-[13px] leading-[1.45] text-muted-foreground"
          >
            {note}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="max-w-[46ch] text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <PointsHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        customerId={customerId}
        customerName={customerName}
      />

      <AdjustSheet
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        target={{
          id: customerId,
          name: customerName,
          code: customerCode,
          pointsBalance: guild.pointsBalance || pointsBalance,
        }}
        onDone={({ balance }) => {
          setNote(`Adjusted. They now hold ${balance.toLocaleString("en-GB")} points.`)
          settle()
        }}
      />

      <PlanSheet
        open={planOpen}
        onOpenChange={setPlanOpen}
        title="Record a plan"
        description={`${customerName}'s plan pins their tier until it runs out.`}
        customer={{ id: customerId, name: customerName }}
        tiers={(admin?.tiers ?? []).filter((tier) => tier.paid_plan === true)}
        busy={plan.isPending}
        error={error}
        saveLabel="Save plan"
        onSubmit={(form) => plan.mutateAsync(form)}
        onDismissError={() => setError(null)}
      />

      <PlanSheet
        open={renewing !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setRenewing(null)
        }}
        title="Renew"
        description={
          renewing
            ? `${renewing.tierName}. The new date runs from ${formatShortDate(renewing.renews_at)}.`
            : ""
        }
        customer={{ id: customerId, name: customerName }}
        tiers={null}
        initial={
          renewing
            ? { price: (renewing.price / 100).toFixed(2), tier: renewing.tier }
            : undefined
        }
        busy={renew.isPending}
        error={error}
        saveLabel="Save renewal"
        onSubmit={(form) => renew.mutateAsync({ id: renewing?.id ?? "", form })}
        onDismissError={() => setError(null)}
      />

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setCancelling(null)
        }}
        title="Cancel this plan"
        description={`${customerName} goes back to the tier their points earn them. Nothing is refunded here: hand that back through SumUp.`}
        confirmLabel="Cancel the plan"
        busy={stop.isPending}
        error={error}
        onConfirm={() => {
          if (cancelling) stop.mutate(cancelling.id)
        }}
      />
    </div>
  )
}
