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
import { Sparkline } from "@/components/ui/sparkline"
import { useCountUp } from "@/design/motion"
import { getCurrentCashSession, getTodayStats } from "@/lib/api"
import { countQuotesWaiting } from "@/lib/api/quotes"
import { countHoldsEndingToday } from "@/lib/api/wants"
import { getSparklines } from "@/lib/api/reports"
import type { SparklineSeries, TodayStats } from "@/lib/api/types"

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
  /** The figure in pence, so the tile can count up to it before formatting. */
  pence: (stats: TodayStats) => number
  /** Which of the last thirty days' figures the line under it draws. */
  trend: keyof Omit<SparklineSeries, "dates">
}

const TILES: Tile[] = [
  {
    label: "Sales",
    hint: "Taken today",
    pence: (stats) => stats.salesTotal,
    trend: "sales",
  },
  {
    label: "Buy-ins",
    hint: "Paid out today",
    pence: (stats) => stats.buyInTotal,
    trend: "buyIns",
  },
  {
    label: "Cash out",
    hint: "From the drawer",
    pence: (stats) => stats.cashOut,
    trend: "cashOut",
  },
  {
    label: "Credit issued",
    hint: "On to accounts",
    pence: (stats) => stats.creditIssued,
    trend: "creditIssued",
  },
]

/**
 * The day's figure, counted up once when the numbers land. Before they do the
 * tile says so in words rather than showing a zero that could be read as a
 * quiet day.
 */
function TileFigure({ pence, counted }: { pence: number; counted: boolean }) {
  const shown = useCountUp(counted ? pence : 0)
  if (!counted) {
    return (
      <>
        <span aria-hidden="true">-</span>
        <span className="sr-only">Not counted yet</span>
      </>
    )
  }
  return <>{formatGBP(Number(shown))}</>
}

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
  // The last thirty days under each tile. A day old at the most, so it is
  // read once and left alone for the session.
  const { data: trend } = useQuery({
    queryKey: ["sparklines", 30],
    queryFn: () => getSparklines(30),
    staleTime: 30 * 60_000,
  })
  // The two things waiting on somebody rather than on the day: quotes
  // nobody has priced, and holds that run out before the shop shuts.
  const { data: quotesWaiting = 0 } = useQuery({
    queryKey: ["quotes-waiting"],
    queryFn: countQuotesWaiting,
    staleTime: 60_000,
  })
  const { data: holdsToday = 0 } = useQuery({
    queryKey: ["holds-ending-today"],
    queryFn: () => countHoldsEndingToday(),
    staleTime: 60_000,
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
                <TileFigure
                  pence={stats ? tile.pence(stats) : 0}
                  counted={Boolean(stats)}
                />
              </span>
              <span className="mt-2 block text-[13px] text-muted-foreground-2">
                {tile.hint}
              </span>
              {/* The 40px is reserved whether or not the line has arrived,
                  so the tiles do not jump when it does. */}
              <span className="mt-3 block" style={{ height: 40 }}>
                {trend ? (
                  <>
                    <Sparkline values={trend[tile.trend]} height={40} />
                    <span className="sr-only">
                      Over the last 30 days, the highest was{" "}
                      {formatGBP(Math.max(0, ...trend[tile.trend]))}.
                    </span>
                  </>
                ) : null}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-16 flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft pb-6">
        {session ? (
          <>
            <span className="tnum text-[15px] text-foreground">
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

      <div
        data-testid="waiting-line"
        className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft py-6"
      >
        <MicroLabel>Waiting</MicroLabel>
        {quotesWaiting === 0 && holdsToday === 0 ? (
          <span className="text-[15px] text-muted-foreground">
            No quotes to price and no holds ending today.
          </span>
        ) : (
          <>
            {quotesWaiting > 0 ? (
              <span className="flex items-center gap-4">
                <span className="tnum text-[15px] text-foreground">
                  {quotesWaiting} {quotesWaiting === 1 ? "quote" : "quotes"} to price
                </span>
                <Button variant="text" render={<Link to="/counter/quotes" />}>
                  Quotes
                </Button>
              </span>
            ) : null}
            {holdsToday > 0 ? (
              <span className="flex items-center gap-4">
                <span className="tnum text-[15px] text-foreground">
                  {holdsToday} {holdsToday === 1 ? "hold ends" : "holds end"} today
                </span>
                <Button
                  variant="text"
                  render={<Link to="/counter/stock" search={{ status: "reserved" }} />}
                >
                  Holds
                </Button>
              </span>
            ) : null}
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
