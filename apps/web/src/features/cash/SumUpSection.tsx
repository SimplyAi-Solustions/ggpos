/**
 * SumUp, on the Cash screen: card takings on SumUp's side beside card sales
 * on ours, for one day.
 *
 * It is a comparison and a link, never a ledger write. Nothing in here
 * touches a cash movement or a sale's own figures: matching a transaction to
 * a sale only records which is which, so a drawer that was counted stays
 * counted.
 *
 * The amount compared is the card share on both sides. A mixed sale's total
 * includes what was paid in cash, credit or points, and none of that ever
 * reached the card reader.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useCounterConfig } from "@/lib/api/config"
import { refusalOrFallback } from "@/lib/api/refusal"
import { matchSumUpTransaction, pullSumUp, reconcileSumUp } from "@/lib/api/sumup"
import { useStaff } from "@/lib/auth"
import type { SumUpSale, SumUpTransaction } from "@/lib/api/types"
import { formatDay } from "@/features/reports/range"
import {
  candidateReason,
  salesForTransaction,
  transactionsForSale,
  differenceLine,
} from "@/features/cash/reconcile"

function time(iso?: string): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

type Pending =
  | { side: "transaction"; transaction: SumUpTransaction }
  | { side: "sale"; sale: SumUpSale }

function Row({
  title,
  detail,
  amount,
  action,
}: {
  title: string
  detail: string
  amount: number
  action?: React.ReactNode
}) {
  return (
    <li className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-hairline-soft py-3 first:border-t">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="tnum truncate font-mono text-[13px] text-foreground">{title}</span>
        <span className="truncate text-[13px] text-muted-foreground-2">{detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-6">
        <span className="tnum text-[15px] text-foreground">{formatGBP(amount)}</span>
        {action}
      </span>
    </li>
  )
}

function MatchSheet({
  pending,
  transactions,
  sales,
  onClose,
  onConfirm,
  saving,
}: {
  pending: Pending | null
  transactions: SumUpTransaction[]
  sales: SumUpSale[]
  onClose: () => void
  onConfirm: (transactionId: string, saleId: string) => void
  saving: boolean
}) {
  const [picked, setPicked] = React.useState<string | null>(null)

  // The sheet is mounted only while there is a row to match, and the caller
  // keys it on that row, so the choice starts empty every time without an
  // effect reaching in to clear it.
  if (!pending) return null

  // Narrowed into a local so the confirm handler below keeps the type: a
  // closure over the prop itself loses what the check above proved.
  const open = pending
  const fromSumUp = open.side === "transaction"
  const target = fromSumUp
    ? { amount: open.transaction.amount, at: open.transaction.timestamp }
    : { amount: open.sale.card_share, at: open.sale.created ?? "" }

  const candidates = open.side === "transaction"
    ? salesForTransaction(open.transaction, sales).map((sale) => ({
        id: sale.id,
        title: sale.number,
        detail: `${time(sale.created)} · ${candidateReason(target, {
          amount: sale.card_share,
          at: sale.created ?? "",
        })}`,
        amount: sale.card_share,
      }))
    : transactionsForSale(open.sale, transactions).map((transaction) => ({
        id: transaction.id,
        title: transaction.transaction_code || transaction.sumup_id,
        detail: `${time(transaction.timestamp)} · ${candidateReason(target, {
          amount: transaction.amount,
          at: transaction.timestamp,
        })}`,
        amount: transaction.amount,
      }))

  function confirm() {
    if (!picked) return
    if (open.side === "transaction") onConfirm(open.transaction.id, picked)
    else onConfirm(picked, open.sale.id)
  }

  return (
    <Sheet open onOpenChange={(next: boolean) => (next ? undefined : onClose())}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>
            {fromSumUp ? "Which sale is this?" : "Which transaction is this?"}
          </SheetTitle>
          <SheetDescription>
            {formatGBP(target.amount)} at {time(target.at)}. The same amount is
            offered first, then whatever happened nearest to it.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {candidates.length === 0 ? (
            <p className="text-[15px] text-muted-foreground-2">
              There is nothing on the other side to match this to. Pull again,
              or leave it for the day it belongs to.
            </p>
          ) : (
            <ul data-testid="match-candidates">
              {candidates.map((candidate) => (
                <li key={candidate.id} className="border-b border-hairline-soft">
                  <button
                    type="button"
                    aria-pressed={picked === candidate.id}
                    onClick={() => setPicked(candidate.id)}
                    className="flex min-h-12 w-full items-center justify-between gap-4 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover aria-pressed:bg-secondary"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="tnum truncate font-mono text-[13px] text-foreground">
                        {candidate.title}
                      </span>
                      <span className="truncate text-[13px] text-muted-foreground-2">
                        {candidate.detail}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-[15px] text-foreground">
                      {formatGBP(candidate.amount)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SheetBody>
        <SheetFooter>
          <Button onClick={confirm} disabled={!picked} loading={saving} trailingArrow>
            Confirm the match
          </Button>
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function SumUpSection({
  date,
  onDateChange,
  maxDate,
}: {
  date: string
  onDateChange: (next: string) => void
  /** Today: there is nothing to compare on a day that has not happened. */
  maxDate: string
}) {
  const admin = useStaff()?.role === "admin"
  const config = useCounterConfig()
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pulled, setPulled] = React.useState<string | null>(null)

  const configured = Boolean(config.data?.sumupMerchantCode)

  const day = useQuery({
    queryKey: ["sumup-reconcile", date],
    queryFn: () => reconcileSumUp(date),
    enabled: configured,
    staleTime: 30_000,
  })

  const pull = useMutation({
    mutationFn: pullSumUp,
    onMutate: () => setError(null),
    onSuccess: (result) => {
      setPulled(
        `${result.fetched} fetched, ${result.matched} matched, ${result.unmatched} still to match, ${result.refunded} refunded.`
      )
      void day.refetch()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "SumUp did not answer. Try again in a minute.")),
  })

  const match = useMutation({
    mutationFn: ({ transaction, sale }: { transaction: string; sale: string }) =>
      matchSumUpTransaction(transaction, sale),
    onSuccess: () => {
      setPending(null)
      void day.refetch()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "That did not link. Try again.")),
  })

  if (config.isPending) return null

  if (!configured) {
    return (
      <div className="mt-16">
        <MicroLabel tone="ink" className="mb-5">
          SumUp
        </MicroLabel>
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          Add the SumUp API key in Settings to compare card takings.
        </p>
      </div>
    )
  }

  const totals = day.data?.totals
  const unmatchedTransactions = day.data?.unmatched_transactions ?? []
  const unmatchedSales = day.data?.unmatched_sales ?? []
  const matched = day.data?.matched ?? []

  return (
    <div className="mt-16" data-testid="sumup-section">
      <MicroLabel tone="ink" className="mb-5">
        SumUp
      </MicroLabel>

      <p className="mb-6 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
        Card takings for {formatDay(date)}, SumUp's side against ours. Nothing
        here changes the drawer.
      </p>

      <Field label="Day" htmlFor="sumup-date" layout="stacked" className="mb-10 max-w-52">
        <Input
          id="sumup-date"
          type="date"
          value={date}
          max={maxDate}
          onChange={(event) => onDateChange(event.target.value)}
        />
      </Field>

      {admin ? (
        <div className="mb-10 flex flex-wrap items-center gap-5">
          <Button
            variant="circle"
            loading={pull.isPending}
            onClick={() => pull.mutate()}
            aria-label="Fetch from SumUp"
          >
            Fetch from SumUp
          </Button>
          <MicroLabel>Fetch from SumUp</MicroLabel>
        </div>
      ) : (
        <p className="mb-10 text-[13px] text-muted-foreground-2">
          The pull runs every hour, and an admin can run it on the spot.
        </p>
      )}

      {pulled ? (
        <p aria-live="polite" className="mb-8 text-[13px] text-muted-foreground-2">
          {pulled}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-8 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      {totals ? (
        <dl
          data-testid="sumup-totals"
          className="mb-12 grid grid-cols-2 gap-x-10 gap-y-8 min-[900px]:grid-cols-3"
        >
          <div className="flex flex-col gap-2">
            <dt>
              <MicroLabel>By SumUp</MicroLabel>
            </dt>
            <dd className="tnum m-0 text-[20px] leading-none font-medium text-foreground">
              {formatGBP(totals.sumup)}
            </dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt>
              <MicroLabel>By the Vault</MicroLabel>
            </dt>
            <dd className="tnum m-0 text-[20px] leading-none font-medium text-foreground">
              {formatGBP(totals.sales)}
            </dd>
          </div>
          <div className="flex flex-col gap-2">
            <dt>
              <MicroLabel>Difference</MicroLabel>
            </dt>
            <dd className="m-0">
              <span
                data-testid="sumup-difference"
                className="tnum block font-display text-[28px] leading-none text-foreground"
              >
                {formatGBP(totals.difference)}
              </span>
              <span className="mt-2 block text-[13px] text-muted-foreground-2">
                {differenceLine(totals.sumup, totals.sales)}
              </span>
            </dd>
          </div>
        </dl>
      ) : null}

      {day.isPending && configured ? (
        <p className="text-[15px] text-muted-foreground-2">Reading the day back.</p>
      ) : null}

      {day.data ? (
        <div className="flex flex-col gap-12">
          <section>
            <MicroLabel className="mb-4">Matched</MicroLabel>
            {matched.length === 0 ? (
              <p className="text-[15px] text-muted-foreground-2">
                Nothing has been matched for {formatDay(date)} yet.
              </p>
            ) : (
              <ul data-testid="sumup-matched">
                {matched.map((pair) => (
                  <Row
                    key={pair.transaction.id}
                    title={`${pair.transaction.transaction_code || pair.transaction.sumup_id} · ${pair.sale.number}`}
                    detail={`${time(pair.transaction.timestamp)} on SumUp, ${time(pair.sale.created)} on the till`}
                    amount={pair.transaction.amount}
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <MicroLabel className="mb-4">Not in the Vault</MicroLabel>
            {unmatchedTransactions.length === 0 ? (
              <p className="text-[15px] text-muted-foreground-2">
                Every transaction has a sale behind it.
              </p>
            ) : (
              <ul data-testid="sumup-unmatched-transactions">
                {unmatchedTransactions.map((transaction) => (
                  <Row
                    key={transaction.id}
                    title={transaction.transaction_code || transaction.sumup_id}
                    detail={`Taken at ${time(transaction.timestamp)}`}
                    amount={transaction.amount}
                    action={
                      <Button
                        variant="text"
                        onClick={() => setPending({ side: "transaction", transaction })}
                      >
                        Match
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <MicroLabel className="mb-4">Not on SumUp</MicroLabel>
            {unmatchedSales.length === 0 ? (
              <p className="text-[15px] text-muted-foreground-2">
                Every card sale reached SumUp.
              </p>
            ) : (
              <ul data-testid="sumup-unmatched-sales">
                {unmatchedSales.map((sale) => (
                  <Row
                    key={sale.id}
                    title={sale.number}
                    detail={
                      sale.payment === "mixed"
                        ? `Mixed, ${formatGBP(sale.card_share)} on card, rung at ${time(sale.created)}`
                        : `Rung at ${time(sale.created)}`
                    }
                    amount={sale.card_share}
                    action={
                      <Button
                        variant="text"
                        onClick={() => setPending({ side: "sale", sale })}
                      >
                        Match
                      </Button>
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      <MatchSheet
        key={
          pending
            ? pending.side === "transaction"
              ? pending.transaction.id
              : pending.sale.id
            : "none"
        }
        pending={pending}
        transactions={unmatchedTransactions}
        sales={unmatchedSales}
        saving={match.isPending}
        onClose={() => setPending(null)}
        onConfirm={(transaction, sale) => match.mutate({ transaction, sale })}
      />
    </div>
  )
}
