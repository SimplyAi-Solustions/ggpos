/**
 * The quote queue: everything customers have sent in from home, newest
 * first.
 *
 * A hairline list rather than a table: a quote is a person and a pile of
 * photos, not a row of figures, and at 390 it has to read as one block per
 * quote. Nothing is created here, so the screen carries no block button; the
 * rows are the way in.
 *
 * The chips filter on the server, not in this file: a shop with more than a
 * page of quotes would otherwise have a "Waiting" chip that disagreed with
 * the count in the nav, because the chip would only ever see the newest
 * hundred.
 */
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerCards } from "@/components/ui/sticker"
import {
  QUOTE_FILTERS,
  statusesForFilters,
  type QuoteFilter,
} from "@/features/quotes/filters"
import {
  QUOTE_STATUS_LABEL,
  formatAge,
  photoCount,
} from "@/features/quotes/format"
import { quoteQueueQuery } from "@/lib/api/quotes"
import { refusalOrFallback } from "@/lib/api/refusal"

export function QuotesScreen() {
  const [active, setActive] = React.useState<QuoteFilter[]>([])
  const statuses = statusesForFilters(active)
  const { data, isPending, error } = useQuery(quoteQueueQuery(statuses))
  const visible = data?.rows ?? []
  const total = data?.total ?? 0

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Quotes</PageTitle>
      <Lede>Photos sent in from home, newest first.</Lede>

      <div className="mt-12">
        <ChipGroup
          aria-label="Filter quotes"
          multiple
          value={active}
          onValueChange={(next) => setActive(next as QuoteFilter[])}
        >
          {QUOTE_FILTERS.map((filter) => (
            <Chip key={filter.value} value={filter.value}>
              {filter.label}
            </Chip>
          ))}
        </ChipGroup>
      </div>

      <div className="mt-12">
        {error ? (
          <p role="alert" className="max-w-[56ch] text-[15px] text-destructive">
            {refusalOrFallback(
              error,
              "The queue would not load. Check the connection and try again."
            )}
          </p>
        ) : isPending ? (
          <SkeletonText lines={5} />
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-start gap-6 py-10">
            <StickerCards className="size-14" aria-hidden="true" />
            <p className="max-w-[46ch] text-base leading-[1.5] text-muted-foreground">
              {active.length === 0
                ? "No quotes yet. They arrive when somebody sends photos from My Vault."
                : "Nothing matches those filters. Clear one to see more."}
            </p>
          </div>
        ) : (
          <ul data-testid="quote-queue" aria-label="Quotes">
            {visible.map((row) => (
              <li key={row.id} className="border-b border-hairline-soft first:border-t">
                <Link
                  to="/counter/quotes/$id"
                  params={{ id: row.id }}
                  data-testid="quote-row"
                  className="flex min-h-12 flex-col gap-2 py-4 outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt min-[900px]:flex-row min-[900px]:items-baseline min-[900px]:gap-6"
                >
                  <span className="flex items-center gap-4 min-[900px]:w-36 min-[900px]:shrink-0">
                    <Badge variant="outline">{QUOTE_STATUS_LABEL[row.status]}</Badge>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">
                      {row.customerName || "Not named"}
                    </span>
                    <span className="mt-1 block truncate text-[13px] text-muted-foreground-2">
                      <span className="tnum font-mono">{row.customerCode}</span>
                      {row.customerCode ? " · " : ""}
                      {photoCount(row.photoCount)} · {formatAge(row.created)}
                    </span>
                  </span>
                  {row.offerTotal ? (
                    <span className="tnum shrink-0 text-[15px] font-medium text-foreground">
                      {formatGBP(row.offerTotal)}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {visible.length > 0 ? (
        <div className="mt-10">
          <Hint>
            {total > visible.length
              ? `Showing ${visible.length} of ${total}`
              : `${visible.length} shown`}
          </Hint>
        </div>
      ) : null}
    </section>
  )
}
