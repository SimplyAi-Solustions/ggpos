/**
 * Home: the day in four numbers, the state of the drawer, the five ways into
 * the work, and what has just happened.
 *
 * The figures come from the day's own rows rather than `daily_stats`, which
 * is built nightly and would be a day late on a screen that says "today".
 */
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { getCurrentCashSession, getTodayStats } from "@/lib/api"
import type { TodayStats } from "@/lib/api/types"

const QUICK_ACTIONS = [
  { to: "/counter/scan", label: "Scan" },
  { to: "/counter/sell", label: "Sell" },
  { to: "/counter/trade", label: "Buy-in" },
  { to: "/counter/stock/new", label: "Add stock" },
  { to: "/counter/cash", label: "Cash" },
] as const

interface Tile {
  label: string
  hint: string
  value: (stats: TodayStats) => string
}

const TILES: Tile[] = [
  {
    label: "Sales",
    hint: "Taken today",
    value: (stats) => formatGBP(stats.salesTotal),
  },
  {
    label: "Buy-ins",
    hint: "Paid out today",
    value: (stats) => formatGBP(stats.buyInTotal),
  },
  {
    label: "Cash out",
    hint: "From the drawer",
    value: (stats) => formatGBP(stats.cashOut),
  },
  {
    label: "Credit issued",
    hint: "On to accounts",
    value: (stats) => formatGBP(stats.creditIssued),
  },
]

function time(iso?: string): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function HomeScreen() {
  const { data: stats } = useQuery({
    queryKey: ["today-stats"],
    queryFn: getTodayStats,
    staleTime: 15_000,
  })
  const { data: cash } = useQuery({
    queryKey: ["cash-current"],
    queryFn: getCurrentCashSession,
    staleTime: 15_000,
  })

  const session = cash?.session ?? null

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Today</PageTitle>
      <Lede>Sales, buy-ins, cash out and credit, counted as the day goes.</Lede>

      <dl
        data-testid="today-tiles"
        className="mt-14 grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-4"
      >
        {TILES.map((tile) => (
          <div key={tile.label} className="flex flex-col gap-2">
            <dt>
              <MicroLabel>{tile.label}</MicroLabel>
            </dt>
            <dd className="m-0">
              <span className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground">
                {stats ? (
                  tile.value(stats)
                ) : (
                  <>
                    <span aria-hidden="true">-</span>
                    <span className="sr-only">Not counted yet</span>
                  </>
                )}
              </span>
              <span className="mt-2 block text-[13px] text-muted-foreground-2">
                {tile.hint}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-16 flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft pb-6">
        {session ? (
          <>
            <span className="text-[15px] text-foreground">
              Session open since {time(session.opened_at)}, float{" "}
              {formatGBP(session.float ?? 0)}
            </span>
            <Hint className="tnum">Expected {formatGBP(cash?.expected ?? 0)}</Hint>
            <Button variant="text" render={<Link to="/counter/cash" />}>
              Cash
            </Button>
          </>
        ) : (
          <>
            <span className="text-[15px] text-muted-foreground">
              No cash session open, so no cash sale and no cash payout can go
              through.
            </span>
            <Button variant="text" render={<Link to="/counter/cash" />}>
              Open
            </Button>
          </>
        )}
      </div>

      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          Quick actions
        </MicroLabel>
        <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
          <Button render={<Link to="/counter/scan" />} trailingArrow>
            Scan
          </Button>
          {QUICK_ACTIONS.filter((action) => action.to !== "/counter/scan").map(
            (action) => (
              <Button
                key={action.to}
                variant="text"
                render={<Link to={action.to} />}
              >
                {action.label}
              </Button>
            )
          )}
        </div>
      </div>

      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Recent
        </MicroLabel>
        {!stats || stats.recent.length === 0 ? (
          <p className="text-[15px] text-muted-foreground-2">
            Nothing has gone through the counter yet today.
          </p>
        ) : (
          <ul data-testid="recent-list">
            {stats.recent.map((entry) => (
              <li
                key={`${entry.kind}-${entry.id}`}
                className="flex min-h-12 items-center gap-4 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="tnum shrink-0 font-mono text-[13px] text-foreground">
                  {entry.number}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground-2">
                  {entry.kind === "sale" ? "Sale" : "Buy-in"} &middot; {entry.detail}
                </span>
                <span className="tnum shrink-0 text-[15px] text-foreground">
                  {formatGBP(entry.total)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
