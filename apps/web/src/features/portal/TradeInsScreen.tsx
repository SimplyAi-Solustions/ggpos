import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerOrbit } from "@/components/ui/sticker"
import { getMyTradeIn, getMyTradeIns } from "@/lib/api/portal"
import { formatDate } from "@/features/portal/format"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"

const PAYOUT_LABEL: Record<string, string> = {
  cash: "Paid in cash",
  credit: "Paid in store credit",
  mixed: "Cash and store credit",
}

/**
 * What to say about a trade-in that is not finished.
 *
 * The list carries every status, not only the completed ones: a quote that
 * has been accepted sits here as a draft for days before it is paid, and a
 * customer looking for it should find it rather than wonder where it went.
 * A completed one says nothing, because its payout line already does.
 */
const STATUS_LABEL: Record<string, string> = {
  draft: "Waiting for your items",
  offered: "Offer made",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
}

/** Everything this customer has sold us, newest first. */
export function TradeInsScreen() {
  const { data: rows, isPending, isError, error, refetch } = useQuery({
    queryKey: ["portal", "trade-ins"],
    queryFn: getMyTradeIns,
  })

  if (isError) {
    return (
      <LoadFailed
        title="My trade-ins"
        error={error}
        fallback="We could not read your trade-ins just now. Check your connection and try again."
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>My trade-ins</PageTitle>
      <Lede>Everything you have sold us, with what we paid.</Lede>

      {isPending ? (
        <div className="mt-12">
          <SkeletonText lines={4} />
        </div>
      ) : (rows ?? []).length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerOrbit className="size-14" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing yet. Bring cards or games in, or send photos for a quote
            first.
          </p>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col">
          {(rows ?? []).map((row) => (
            <li key={row.id} className="border-b border-hairline-soft">
              <Link
                to="/account/trade-ins/$id"
                params={{ id: row.id }}
                className="flex min-h-16 items-center justify-between gap-5 py-4 transition-colors duration-150 ease-gg hover:bg-row-hover"
              >
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="tnum font-mono text-[13px] text-foreground">
                    {row.number}
                  </span>
                  <Note>
                    {[
                      formatDate(row.at),
                      row.status === "completed"
                        ? PAYOUT_LABEL[row.payoutType ?? ""]
                        : (STATUS_LABEL[row.status] ?? "In progress"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Note>
                </span>
                {/* A draft has not paid anything yet, so it shows what was
                    offered rather than a £0.00 that would read as a payout. */}
                <span className="tnum shrink-0 text-[20px] leading-none font-medium">
                  {formatGBP(
                    row.status === "completed"
                      ? row.payoutCash + row.payoutCredit
                      : row.totalOffer
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** One trade-in: the lines, the payout and the date. */
export function TradeInDetailScreen({ id }: { id: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["portal", "trade-in", id],
    queryFn: () => getMyTradeIn(id),
  })

  if (isError) {
    return (
      <LoadFailed
        title="Trade-in"
        error={error}
        fallback="We could not read that trade-in just now. Check your connection and try again."
        onRetry={() => void refetch()}
      />
    )
  }

  if (isPending) {
    return (
      <section className="pt-12 sm:pt-20">
        <SkeletonText lines={5} />
      </section>
    )
  }

  if (!data) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>Trade-in</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          That trade-in is not on your record. Go back and pick one from the
          list.
        </p>
        <div className="mt-10">
          <Button variant="text" render={<Link to="/account/trade-ins" />}>
            Back to trade-ins
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Trade-in</PageTitle>
      <p className="mt-3 text-base leading-[1.5] text-muted-foreground">
        {data.number ? (
          <>
            <span className="tnum font-mono text-[13px] text-foreground">
              {data.number}
            </span>
            {", "}
          </>
        ) : null}
        {formatDate(data.at)}
        {data.status !== "completed"
          ? `, ${STATUS_LABEL[data.status] ?? "in progress"}`
          : ""}
      </p>

      <SectionHeading className="mt-14">What you sold</SectionHeading>
      <ul className="flex flex-col">
        {data.lines.map((line) => (
          <li
            key={line.id}
            className="flex items-baseline justify-between gap-5 border-b border-hairline-soft py-3"
          >
            <span className="min-w-0 text-[15px] leading-[1.4]">
              {line.title}
              {line.qty > 1 ? (
                <span className="text-muted-foreground-2"> x{line.qty}</span>
              ) : null}
              {line.detail ? (
                <span className="block text-[13px] text-muted-foreground-2">
                  {line.detail}
                </span>
              ) : null}
            </span>
            <span className="tnum shrink-0 text-[15px] font-medium">
              {formatGBP(line.offerPrice * line.qty)}
            </span>
          </li>
        ))}
      </ul>

      <SectionHeading className="mt-14">What we paid</SectionHeading>
      <div className="grid grid-cols-2 gap-x-6 gap-y-8">
        <div className="flex flex-col gap-1.5">
          <MicroLabel>Cash</MicroLabel>
          <span className="tnum text-[20px] leading-none font-medium">
            {formatGBP(data.payoutCash)}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <MicroLabel>Store credit</MicroLabel>
          <span className="tnum text-[20px] leading-none font-medium">
            {formatGBP(data.payoutCredit)}
          </span>
        </div>
      </div>

      <div className="mt-14">
        <Button variant="text" render={<Link to="/account/trade-ins" />}>
          Back to trade-ins
        </Button>
      </div>
    </section>
  )
}
