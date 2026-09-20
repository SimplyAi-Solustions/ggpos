import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerCards } from "@/components/ui/sticker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useCounterDock } from "@/app/counter-dock"
import { formatShortDate } from "@/features/customers/format"
import {
  FILTERS,
  applyFilters,
  type Filter,
} from "@/features/tradein/filters"
import { listTradeIns, type TradeInSummary } from "@/lib/api"

/** Cash, credit or both, written the way the counter says it. */
function payoutWords(row: TradeInSummary): string {
  if (row.payoutCash > 0 && row.payoutCredit > 0) {
    return `${formatGBP(row.payoutCash)} cash, ${formatGBP(row.payoutCredit)} credit`
  }
  if (row.payoutCash > 0) return `${formatGBP(row.payoutCash)} cash`
  if (row.payoutCredit > 0) return `${formatGBP(row.payoutCredit)} credit`
  return formatGBP(row.totalOffer)
}

/** Recent buy-ins, and the one button that starts another. */
export function TradeInListScreen() {
  const navigate = useNavigate()
  const dock = useCounterDock()
  const [active, setActive] = React.useState<Filter[]>([])

  const { data: rows = [], isPending } = useQuery({
    queryKey: ["trade-ins"],
    queryFn: listTradeIns,
    staleTime: 10_000,
  })
  const visible = applyFilters(rows, active)

  const start = () => void navigate({ to: "/counter/trade/new" })

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Trade</PageTitle>
      <Lede>Every buy-in over the counter, newest first.</Lede>

      <div className="mt-12">
        <ChipGroup
          aria-label="Filter buy-ins"
          multiple
          value={active}
          onValueChange={(next) => setActive(next as Filter[])}
        >
          {FILTERS.map((filter) => (
            <Chip key={filter.value} value={filter.value}>
              {filter.label}
            </Chip>
          ))}
        </ChipGroup>
      </div>

      <div className="mt-12">
        {isPending ? (
          <SkeletonText lines={5} />
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-start gap-6 py-10">
            <StickerCards className="size-14" aria-hidden="true" />
            <p className="max-w-[46ch] text-base leading-[1.5] text-muted-foreground">
              {rows.length === 0
                ? "No buy-ins yet. Start one when somebody brings cards in."
                : "Nothing matches those filters. Clear one to see more."}
            </p>
          </div>
        ) : (
          <Table>
            <caption className="sr-only">Recent buy-ins</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Market</TableHead>
                <TableHead>Paid</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.status === "completed" ? (
                      <Link
                        to="/counter/trade/$id/receipt"
                        params={{ id: row.id }}
                        className="tnum font-mono text-[13px] text-foreground underline-offset-4 outline-none hover:underline"
                      >
                        {row.number}
                      </Link>
                    ) : (
                      <Link
                        to="/counter/trade/$id"
                        params={{ id: row.id }}
                        className="tnum font-mono text-[13px] text-foreground underline-offset-4 outline-none hover:underline"
                      >
                        Draft
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{row.customerName || "Not named"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.status}</Badge>
                  </TableCell>
                  <TableCell numeric>{formatGBP(row.totalMarket)}</TableCell>
                  <TableCell>
                    <span className="tnum text-[15px] text-foreground">
                      {payoutWords(row)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-[15px] text-muted-foreground">
                      {row.staffName || "-"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="tnum text-[15px] text-muted-foreground">
                      {formatShortDate(row.at) || "-"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="mt-14 hidden items-center gap-8 min-[900px]:flex">
        <Button type="button" trailingArrow onClick={start}>
          New buy-in
        </Button>
        <Hint>{visible.length} shown</Hint>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3">
              <Button type="button" trailingArrow className="w-full" onClick={start}>
                New buy-in
              </Button>
            </div>,
            dock
          )
        : null}
    </section>
  )
}
