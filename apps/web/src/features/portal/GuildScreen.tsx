import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { displayCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { getGuild } from "@/lib/api/guild"
import { getMe } from "@/lib/api/portal"
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
