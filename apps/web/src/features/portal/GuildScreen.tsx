import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode, encodeCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { getGuild, joinGuild, type GuildPlan } from "@/lib/api/guild"
import { getMe } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"
import { QrCode } from "@/features/customers/GuildCard"
import { portalLink } from "@/features/customers/format"
import { Code128 } from "@/features/portal/Barcode"
import { usePortalDock } from "@/features/portal/dock"
import { formatDate } from "@/features/portal/format"
import {
  formatPoints,
  perkLine,
  referralProgressSentence,
  referralSentence,
  tierProgressSentence,
  tierRail,
} from "@/features/portal/guild"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"
import {
  browserShareTarget,
  shareActionLabel,
  shareOrCopy,
  shareResultSentence,
  type ShareResult,
} from "@/features/portal/share"

/**
 * GG Guild: the tier, what it is worth, and the code that brings a friend in.
 *
 * Two reads, because the two figures on this screen mean different things
 * and a customer who confuses them would be misled about their own money:
 * `/me` carries the points they can spend, `/me/guild` the points that count
 * towards a tier, which redeeming never reduces. Both are labelled, and
 * neither is ever shown as a zero because a read failed.
 */

/** A hairline rail from nothing to the next tier, with the marker on it. */
function TierRail({ position }: { position: number }) {
  return (
    <div aria-hidden="true" className="relative h-2.5 w-full">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hairline" />
      <span className="absolute top-0 right-0 h-2.5 w-px bg-hairline" />
      {/* Offset by the marker's own width rather than translated, so it sits
          fully inside the rail at both ends. */}
      <span
        className="absolute top-0 size-2.5 rounded-full bg-foreground"
        style={{ left: `calc(${position} * (100% - 0.625rem))` }}
      />
    </div>
  )
}

/**
 * A paid plan, from asking to join to paying for it.
 *
 * Nothing is paid online: asking to join makes a pending membership, and the
 * customer pays at the counter by showing this screen. The barcode is their
 * bare GGC code, the card number on the shop's Epos Now till, so scanning it
 * puts them on the sale and the sale starts the membership. The QR beside it
 * is the same one on their card, for The Counter's own scanner.
 */
function MembershipBlock({
  pending,
  plans,
  live,
  code,
  qrToken,
}: {
  pending: { tier_name: string; price: number } | null
  plans: GuildPlan[]
  live: boolean
  code: string
  qrToken: string | undefined
}) {
  const queryClient = useQueryClient()
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const join = useMutation({
    mutationFn: (plan: GuildPlan) => joinGuild(plan.id),
    onSuccess: async () => {
      setRefusal(null)
      await queryClient.invalidateQueries({ queryKey: ["portal", "guild"] })
    },
    onError: (problem) =>
      setRefusal(
        refusalOrFallback(problem, "Your request did not go through. Try again in a minute.")
      ),
  })

  if (pending) {
    return (
      <div data-testid="guild-pending">
        <SectionHeading className="mt-16">Your membership</SectionHeading>
        <p className="max-w-[48ch] text-base leading-[1.5] text-foreground">
          Pay at the counter to start your membership.
        </p>
        {pending.price > 0 ? (
          <span
            data-testid="guild-pending-price"
            className="tnum mt-5 block text-[20px] leading-none font-medium text-foreground"
          >
            {formatGBP(pending.price)}
          </span>
        ) : null}
        <Note className="mt-3">
          {`${pending.tier_name}, for 12 months from the day you pay.`}
        </Note>

        <div className="mt-10 flex w-full max-w-[360px] flex-col gap-3">
          <MicroLabel>Show at the till</MicroLabel>
          <Code128
            text={encodeCode(code)}
            title={`Barcode for card ${displayCode(code)}`}
            className="h-[88px] w-full px-3 py-2"
          />
          <span className="tnum font-mono text-[13px] text-foreground">
            {displayCode(code)}
          </span>
        </div>
        <div className="mt-8 flex items-center gap-5">
          <QrCode
            text={portalLink(qrToken)}
            title={`Guild card QR for ${displayCode(code)}`}
            className="shrink-0"
            style={{ width: 96, height: 96 }}
          />
          <Note className="max-w-[32ch]">
            The same QR as your card, if the counter scans that instead.
          </Note>
        </div>
      </div>
    )
  }

  if (live || plans.length === 0) return null

  return (
    <div data-testid="guild-plans">
      <SectionHeading className="mt-16">Paid membership</SectionHeading>
      <ul className="flex flex-col">
        {plans.map((plan) => (
          <li
            key={plan.id}
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-hairline-soft py-4 first:border-t"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[15px] leading-[1.35] text-foreground">{plan.name}</span>
              <Note>
                {plan.price > 0
                  ? `${formatGBP(plan.price)} for 12 months, paid at the counter.`
                  : "12 months, paid at the counter."}
              </Note>
            </span>
            <Button
              type="button"
              variant="text"
              disabled={join.isPending}
              onClick={() => join.mutate(plan)}
            >
              Ask to join
            </Button>
          </li>
        ))}
      </ul>
      {refusal ? (
        <p role="alert" className="mt-4 max-w-[52ch] text-[15px] leading-[1.5] text-destructive">
          {refusal}
        </p>
      ) : null}
    </div>
  )
}

export function GuildScreen() {
  const dock = usePortalDock()
  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const guild = useQuery({ queryKey: ["portal", "guild"], queryFn: getGuild })

  // Read once: whether there is a share sheet decides the button's own words,
  // so it cannot be worked out after the press.
  const shareTarget = React.useMemo(() => browserShareTarget(), [])
  const [shared, setShared] = React.useState<ShareResult | null>(null)

  if (me.isError || guild.isError) {
    return (
      <LoadFailed
        title="GG Guild"
        error={guild.error ?? me.error}
        fallback="We could not read your Guild just now. Check your connection and try again."
        onRetry={() => {
          void me.refetch()
          void guild.refetch()
        }}
      />
    )
  }

  const primary = (
    <Button render={<Link to="/account/rewards" />} trailingArrow>
      See rewards
    </Button>
  )

  if (guild.isPending || me.isPending) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>GG Guild</PageTitle>
        <div className="mt-12">
          <SkeletonText lines={6} />
        </div>
      </section>
    )
  }

  const summary = guild.data
  const rail = tierRail(summary)
  const perks = summary.perks ?? []
  const code = displayCode(summary.referral.code)
  const shareNote = shared ? shareResultSentence(shared, code) : null

  async function onShare() {
    setShared(
      await shareOrCopy(
        {
          title: "GG Guild",
          text: `Join GG Guild at GG Entertainment in Bolsover with my code ${code} and we both get points.`,
          copy: code,
        },
        shareTarget
      )
    )
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>GG Guild</PageTitle>
      <Lede>{`${summary.points_name} on what you buy and what you sell us.`}</Lede>

      <div className="mt-12 flex flex-col items-start gap-5">
        {summary.tier ? (
          <Badge variant="volt" data-testid="guild-tier">
            {summary.tier.name}
          </Badge>
        ) : null}

        {/* The rail carries no label of its own: the sentence under it says
            the same two things in words, and a figure glued to a tier name
            ("10,000 Legend") is not how anybody says it. */}
        <div className="w-full">
          <TierRail position={rail.position} />
        </div>

        <p
          data-testid="guild-progress"
          className="text-base leading-[1.5] text-foreground"
        >
          {tierProgressSentence(summary)}
        </p>
        <Note>
          {`${formatPoints(summary.window_points)} points count towards your tier. Spending points does not take that back.`}
        </Note>
        {summary.membership ? (
          <Note data-testid="guild-membership">
            {`${summary.membership.tier_name} membership. Renews on ${formatDate(summary.membership.renews_at)}.`}
          </Note>
        ) : null}
      </div>

      <MembershipBlock
        pending={summary.pending ?? null}
        plans={summary.plans ?? []}
        live={Boolean(summary.membership)}
        code={me.data.customer.code}
        qrToken={me.data.customer.qr_token}
      />

      <SectionHeading className="mt-16">Points</SectionHeading>
      <span
        data-testid="guild-balance"
        className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
      >
        {formatPoints(me.data.balances.points)}
      </span>
      <Note className="mt-3">
        {`${summary.points_name} you can spend on a reward.`}
      </Note>
      <div className="mt-8">
        <Button variant="text" render={<Link to="/account/points" />}>
          Points history
        </Button>
      </div>

      <SectionHeading className="mt-16">Your perks</SectionHeading>
      {perks.length === 0 ? (
        <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
          No perks on this tier yet. Points still count towards the next one.
        </p>
      ) : (
        <ul data-testid="perk-list" className="flex flex-col">
          {perks.map((perk, index) => {
            const line = perkLine(perk)
            return (
              <li
                key={`${perk.type}-${index}`}
                className="flex flex-col gap-1 border-b border-hairline-soft py-4"
              >
                <span className="text-[15px] leading-[1.35] text-foreground">
                  {line.title}
                </span>
                {line.detail ? <Note>{line.detail}</Note> : null}
              </li>
            )
          })}
        </ul>
      )}

      <SectionHeading className="mt-16">Bring a friend</SectionHeading>
      <span
        data-testid="referral-code"
        className="tnum block font-mono text-[20px] leading-none text-foreground"
      >
        {code}
      </span>
      <p className="mt-4 max-w-[52ch] text-[15px] leading-[1.5] text-muted-foreground">
        {referralSentence(summary.referral)}
      </p>
      <div className="mt-6 flex flex-col items-start gap-3">
        <Button type="button" variant="text" onClick={() => void onShare()}>
          {shareActionLabel(shareTarget)}
        </Button>
        {/* Said once, politely: a share sheet or a clipboard write leaves
            nothing on screen of its own. */}
        <Note aria-live="polite" data-testid="share-result">
          {shareNote ?? ""}
        </Note>
      </div>
      <Note className="mt-6">
        {referralProgressSentence(summary.referral.earned, summary.referral.pending)}
      </Note>

      {summary.vouchers_open > 0 ? (
        <>
          <SectionHeading className="mt-16">Vouchers</SectionHeading>
          {/* A sentence rather than a tracked label: a section heading, a
              micro-label and a text link stacked would be three uppercase
              lines saying one thing between them. */}
          <div className="flex flex-col items-start gap-5">
            <p className="text-base leading-[1.5] text-foreground">
              {summary.vouchers_open === 1
                ? "One voucher is ready to show at the counter."
                : `${formatPoints(summary.vouchers_open)} vouchers are ready to show at the counter.`}
            </p>
            <Button variant="text" render={<Link to="/account/rewards" />}>
              My vouchers
            </Button>
          </div>
        </>
      ) : null}

      <div className="mt-16 hidden min-[900px]:block">{primary}</div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}
