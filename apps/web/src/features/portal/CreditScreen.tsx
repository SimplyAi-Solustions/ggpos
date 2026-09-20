import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerRing } from "@/components/ui/sticker"
import { getMe, getMyCredit } from "@/lib/api/portal"
import { formatDate } from "@/features/portal/format"
import { Note } from "@/features/portal/Note"
import type { CreditLedgerRecord } from "@/lib/api/types"

const REASON_LABEL: Record<CreditLedgerRecord["reason"], string> = {
  trade_in: "Sold to us",
  sale: "Spent in the shop",
  adjustment: "Adjustment",
  expiry: "Expired",
  reward: "Reward",
}

/**
 * Store credit: the balance, and every row behind it.
 *
 * The balance is the sum of the ledger the server sends, not a cached field,
 * so the figure at the top and the rows under it can never disagree.
 */
export function CreditScreen() {
  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const ledger = useQuery({ queryKey: ["portal", "credit"], queryFn: getMyCredit })

  const balance = me.data?.balances.credit ?? 0
  const rows = ledger.data ?? []

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Store credit</PageTitle>
      <Lede>Spend it on anything in the shop. It does not run out.</Lede>

      <div className="mt-12 flex flex-col gap-2">
        <MicroLabel>Balance</MicroLabel>
        {me.isPending ? (
          <SkeletonText lines={1} />
        ) : (
          <span
            data-testid="credit-balance"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(balance)}
          </span>
        )}
      </div>

      {ledger.isPending ? (
        <div className="mt-14">
          <SkeletonText lines={4} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-14 flex items-start gap-5">
          <StickerRing className="size-14" />
          <p className="max-w-[48ch] text-base leading-[1.5] text-muted-foreground">
            No credit yet. Take credit instead of cash when you sell to us and
            it lands here straight away.
          </p>
        </div>
      ) : (
        <ul className="mt-14 flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-baseline justify-between gap-5 border-b border-hairline-soft py-4"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px] leading-[1.35] text-foreground">
                  {REASON_LABEL[row.reason] ?? "Adjustment"}
                </span>
                <Note>
                  {formatDate(row.created)}
                  {row.ref ? (
                    <>
                      {" · "}
                      <span className="tnum font-mono">{row.ref}</span>
                    </>
                  ) : null}
                </Note>
              </span>
              <span className="tnum shrink-0 text-[15px] font-medium">
                {row.amount < 0
                  ? `- ${formatGBP(Math.abs(row.amount))}`
                  : formatGBP(row.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
