/**
 * The last thirty days of the programme, read through the loyalty report so
 * this screen and the Reports screen can never disagree about a figure.
 *
 * Figures only: the chart, the ranges and the CSV live on the report itself,
 * and the link at the bottom goes there.
 */
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP, pointsToPence, type LoyaltyProgramme } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { SkeletonText } from "@/components/ui/skeleton"
import { PERK_LABEL } from "@/features/loyalty/perks"
import { addDays, todayIso } from "@/lib/api/dates"
import { getReport } from "@/lib/api/reports"
import type { TierPerk } from "@gg/shared"

interface TierCount {
  tier?: string
  label?: string
  count?: number
}

interface PerkCount {
  perk_type?: string
  used_count?: number
}

interface RewardCount {
  reward?: string
  label?: string
  count?: number
  points_spent?: number
}

function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div>
      <MicroLabel className="mb-2">{label}</MicroLabel>
      <p className="tnum text-[20px] leading-none font-medium text-foreground">{value}</p>
      {note ? (
        <p className="mt-2 max-w-[28ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          {note}
        </p>
      ) : null}
    </div>
  )
}

export function StatsSection({ programme }: { programme: LoyaltyProgramme }) {
  const to = todayIso()
  const from = addDays(to, -29)

  const { data, isPending, error } = useQuery({
    queryKey: ["report", "loyalty", from, to],
    queryFn: () => getReport("loyalty", { from, to, group: "day" }),
    staleTime: 5 * 60_000,
  })

  if (isPending) return <SkeletonText lines={4} />

  if (error || !data) {
    return (
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        The programme's figures would not load. Open the loyalty report to try
        again.
      </p>
    )
  }

  const totals = data.totals as {
    points_earned?: number
    points_redeemed?: number
    tier_distribution?: TierCount[]
    perk_usage?: PerkCount[]
    reward_take_up?: RewardCount[]
    referrals?: { total?: number; earned?: number }
    programme_cost_pct?: number
  }

  const issued = totals.points_earned ?? 0
  const redeemed = totals.points_redeemed ?? 0
  const outstanding = Math.max(0, issued - redeemed)
  const rewards = totals.reward_take_up ?? []
  const rewardCount = rewards.reduce((sum, row) => sum + (row.count ?? 0), 0)
  const rewardPoints = rewards.reduce((sum, row) => sum + (row.points_spent ?? 0), 0)
  const perks = totals.perk_usage ?? []
  const tiers = totals.tier_distribution ?? []

  return (
    <div data-testid="loyalty-stats">
      <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        The last 30 days, to {to}.
      </p>

      <div className="flex flex-wrap gap-x-14 gap-y-8">
        <Figure label="Points issued" value={issued.toLocaleString("en-GB")} />
        <Figure label="Points redeemed" value={redeemed.toLocaleString("en-GB")} />
        <Figure
          label="Liability added"
          value={formatGBP(pointsToPence(outstanding, programme))}
          note="What the points issued and not yet spent are worth at the redemption rate."
        />
        <Figure
          label="Programme cost"
          value={`${(totals.programme_cost_pct ?? 0).toFixed(1)}%`}
          note="Points redeemed as a share of what the shop took."
        />
        <Figure
          label="Rewards redeemed"
          value={rewardCount.toLocaleString("en-GB")}
          note={`${rewardPoints.toLocaleString("en-GB")} points spent on them.`}
        />
        <Figure
          label="Referrals earned"
          value={(totals.referrals?.earned ?? 0).toLocaleString("en-GB")}
          note={`${(totals.referrals?.total ?? 0).toLocaleString("en-GB")} on file in total.`}
        />
      </div>

      <div className="mt-14 flex flex-col gap-14 min-[900px]:flex-row min-[900px]:gap-16">
        <div className="min-w-0 flex-1">
          <MicroLabel tone="ink" className="mb-4">
            Members by tier
          </MicroLabel>
          <ul>
            {tiers.length === 0 ? (
              <li className="py-3 text-[15px] text-muted-foreground-2">
                Nobody is on a tier yet.
              </li>
            ) : null}
            {tiers.map((row) => (
              <li
                key={row.tier || "none"}
                className="flex items-baseline justify-between gap-6 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="text-[15px] text-foreground">{row.label}</span>
                <span className="tnum text-[15px] text-foreground">
                  {(row.count ?? 0).toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0 flex-1">
          <MicroLabel tone="ink" className="mb-4">
            Perks used
          </MicroLabel>
          <ul>
            {perks.length === 0 ? (
              <li className="py-3 text-[15px] text-muted-foreground-2">
                No perks were used in this range.
              </li>
            ) : null}
            {perks.map((row) => (
              <li
                key={row.perk_type}
                className="flex items-baseline justify-between gap-6 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="text-[15px] text-foreground">
                  {PERK_LABEL[(row.perk_type ?? "") as TierPerk["type"]] ??
                    row.perk_type}
                </span>
                <span className="tnum text-[15px] text-foreground">
                  {(row.used_count ?? 0).toLocaleString("en-GB")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-10">
        <Button
          variant="text"
          render={<Link to="/counter/reports/$key" params={{ key: "loyalty" }} />}
        >
          The full loyalty report
        </Button>
      </div>
    </div>
  )
}
