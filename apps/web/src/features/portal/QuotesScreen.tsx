import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerOrbit } from "@/components/ui/sticker"
import { listMyQuotes } from "@/lib/api/quotes"
import { usePortalDock } from "@/features/portal/dock"
import { formatDate, QUOTE_STATUS_LABEL } from "@/features/portal/format"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { needsAnswer } from "@/features/portal/timeline"

/**
 * Every quote this customer has sent, newest first.
 *
 * A row says three things: what state it is in, when it was sent, and what
 * the offer came to. The one thing that needs a decision is called out in
 * words, not by colour, so it reads the same to everyone.
 */
export function QuotesScreen() {
  const dock = usePortalDock()
  const { data: quotes, isPending, isError, error, refetch } = useQuery({
    queryKey: ["portal", "quotes"],
    queryFn: listMyQuotes,
  })

  if (isError) {
    return (
      <LoadFailed
        title="Quotes"
        error={error}
        fallback="We could not read your quotes just now. Check your connection and try again."
        onRetry={() => void refetch()}
      />
    )
  }

  const primary = (
    <Button render={<Link to="/account/quotes/new" />} trailingArrow>
      Get a quote
    </Button>
  )

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Quotes</PageTitle>
      <Lede>Send photos and we will tell you what we would pay.</Lede>

      {isPending ? (
        <div className="mt-12">
          <SkeletonText lines={4} />
        </div>
      ) : (quotes ?? []).length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerOrbit className="size-14" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing here yet. Photograph what you want to sell, send it over,
            and we will price it before you travel.
          </p>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col">
          {(quotes ?? []).map((quote) => (
            <li key={quote.id} className="border-b border-hairline-soft">
              <Link
                to="/account/quotes/$id"
                params={{ id: quote.id }}
                className="flex min-h-16 items-center justify-between gap-5 py-4 transition-colors duration-150 ease-gg hover:bg-row-hover"
              >
                <span className="flex min-w-0 flex-col gap-1.5">
                  <MicroLabel tone="ink">
                    {QUOTE_STATUS_LABEL[quote.status]}
                  </MicroLabel>
                  <span className="text-[15px] leading-[1.4] text-muted-foreground">
                    {quote.number ? (
                      <>
                        <span className="tnum font-mono text-[13px] text-foreground">{quote.number}</span>,{" "}
                      </>
                    ) : null}
                    sent {formatDate(quote.created)}
                  </span>
                  {needsAnswer(quote) ? (
                    // Ink, not a grey hint: this is the one row on the
                    // screen that is waiting on the person reading it.
                    <span className="text-[15px] leading-[1.4] text-foreground">
                      Waiting on you
                    </span>
                  ) : null}
                </span>
                {quote.offer_total ? (
                  <span className="tnum shrink-0 text-[20px] leading-none font-medium">
                    {formatGBP(quote.offer_total)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-14 hidden min-[900px]:block">{primary}</div>

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
