import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"

/**
 * Four numbers and four ways into the day's work. The figures are dashes
 * until Phase 2 wires `daily_stats`; a dash is honest, a zero is not.
 */
const TILES = [
  { label: "Sales", hint: "Taken today" },
  { label: "Buy-ins", hint: "Paid out today" },
  { label: "Cash out", hint: "From the drawer" },
  { label: "Stock value", hint: "At market" },
] as const

function CounterHome() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Today</PageTitle>
      <Lede>Sales, buy-ins, cash out and stock value, counted as the day goes.</Lede>

      <dl className="mt-14 grid grid-cols-2 gap-x-10 gap-y-10 min-[900px]:grid-cols-4">
        {TILES.map((tile) => (
          <div key={tile.label} className="flex flex-col gap-2">
            <dt>
              <MicroLabel>{tile.label}</MicroLabel>
            </dt>
            <dd className="m-0">
              <span className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground">
                <span aria-hidden="true">-</span>
                <span className="sr-only">Not counted yet</span>
              </span>
              <span className="mt-2 block text-[13px] text-muted-foreground-2">
                {tile.hint}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-24 flex flex-wrap items-center gap-8">
        <Button render={<Link to="/counter/scan" />} trailingArrow>
          Scan
        </Button>
        <Button variant="text" render={<Link to="/counter/stock/new" />}>
          Add stock
        </Button>
        <Button variant="text" render={<Link to="/counter/trade" />}>
          New buy-in
        </Button>
      </div>
    </section>
  )
}

export const Route = createFileRoute("/counter/")({
  component: CounterHome,
})
