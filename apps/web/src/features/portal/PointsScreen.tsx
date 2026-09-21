import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerOrbit } from "@/components/ui/sticker"
import { listMyPoints } from "@/lib/api/guild"
import { getMe } from "@/lib/api/portal"
import { formatDate } from "@/features/portal/format"
import { formatPoints, pointsDelta, pointsNote } from "@/features/portal/guild"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { Note } from "@/features/portal/Note"

/**
 * Every points row on the record, newest first.
 *
 * The same rule as the credit ledger: the figure at the top is the balance
 * the shop holds and the rows under it are what moved it, so a customer can
 * always see where a number came from. A read that fails says so rather than
 * showing an empty history, which would read as "you have never earned
 * anything".
 */
export function PointsScreen() {
  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const points = useQuery({ queryKey: ["portal", "points"], queryFn: listMyPoints })

  if (me.isError || points.isError) {
    return (
      <LoadFailed
        title="Points"
        error={points.error ?? me.error}
        fallback="We could not read your points just now. Check your connection and try again."
        onRetry={() => {
          void me.refetch()
          void points.refetch()
        }}
      />
    )
  }

  const rows = points.data ?? []

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Points</PageTitle>
      <Lede>What you have earned, and what you have spent.</Lede>

      <div className="mt-12 flex flex-col gap-2">
        <MicroLabel>Balance</MicroLabel>
        {me.isPending ? (
          <SkeletonText lines={1} />
        ) : (
          <span
            data-testid="points-balance"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatPoints(me.data?.balances.points ?? 0)}
          </span>
        )}
      </div>

      {points.isPending ? (
        <div className="mt-14">
          <SkeletonText lines={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerOrbit className="size-14 shrink-0" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            Nothing here yet. Points land when you buy something or take store
            credit for a trade-in.
          </p>
        </div>
      ) : (
        <ul data-testid="points-list" className="mt-14 flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-5 border-b border-hairline-soft py-4"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] leading-[1.35] text-foreground">
                  {pointsNote(row)}
                </span>
                {/* The date and nothing else: `/me/points` sends the
                    sentence and the figures, and the reference a row was
                    written against is the shop's own id, not the
                    customer's. */}
                <Note>{formatDate(row.created)}</Note>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="tnum text-[15px] font-medium">
                  {pointsDelta(row.delta)}
                </span>
                <Note>{`${formatPoints(row.balance_after)} after`}</Note>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-14">
        <Button variant="text" render={<Link to="/account/guild" />}>
          Back to the Guild
        </Button>
      </div>
    </section>
  )
}
