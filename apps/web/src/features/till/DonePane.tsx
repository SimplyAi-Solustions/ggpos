/**
 * Done (DESIGN.md, section 10, "Paying"): the seal, the change as the
 * screen's Anton line when there is change (otherwise the sale number as the
 * outcome code), the points the sale earned, the four receipt choices and
 * "New sale". Choosing a receipt starts the next sale; a printer or mail
 * that would not take it is one line under the choices, never a blocker.
 */
import * as React from "react"
import { formatGBP } from "@gg/shared"
import { motion } from "motion/react"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Seal } from "@/components/ui/seal"
import { sealIn, useMotionVariants } from "@/design/motion"
import type { DoneSale } from "@/features/till/till-store"

export type ReceiptChoice = "print" | "email" | "gift" | "none"

export interface DonePaneProps {
  done: DoneSale
  /** The refund receipt of an exchange, printed on its own; a ticket of returns alone prints it as its receipt. */
  onPrintRefund?: () => void
  printingRefund?: boolean
  /** Which choice is on its way, while it is. */
  pending: ReceiptChoice | null
  /** One line under the choices: why a print or an email did not go. */
  problem: string | null
  /** Set once the route has said there is no address on file. */
  askEmail: boolean
  onChoose: (choice: ReceiptChoice, email?: string) => void
  onNewSale: () => void
}

export function DonePane({
  done,
  pending,
  problem,
  askEmail,
  onChoose,
  onNewSale,
  onPrintRefund,
  printingRefund = false,
}: DonePaneProps) {
  const seal = useMotionVariants(sealIn)
  const [email, setEmail] = React.useState("")
  const busy = pending !== null || printingRefund
  // A sale still in the offline queue has no record yet to print from.
  const waiting = done.queued
  // Returns and nothing new: there is no sale, only the refund's receipt.
  const refundOnly = done.refundOnly === true
  const payout = done.payout ?? 0
  const trade = done.tradeIn ?? null
  const refund = done.refund ?? null

  return (
    <section
      aria-label="Sale done"
      data-testid="till-done"
      className="flex min-h-full flex-col items-start px-5 py-8 sm:px-8"
    >
      <motion.div variants={seal} initial="hidden" animate="visible">
        <Seal />
      </motion.div>

      <div className="mt-8 flex flex-col gap-2" aria-live="polite">
        {done.change > 0 || payout > 0 ? (
          <>
            {/* The one figure read across the counter: change for cash
                handed over, or the cash the customer is given. */}
            <MicroLabel tone="ink">{done.change > 0 ? "Change" : "Cash to the customer"}</MicroLabel>
            <span
              data-testid={done.change > 0 ? "till-change" : "till-payout"}
              className="tnum font-display text-[32px] leading-none tracking-[0.01em] text-foreground min-[900px]:text-[40px]"
            >
              {formatGBP(done.change > 0 ? done.change : payout)}
            </span>
            <span className="tnum mt-1 font-mono text-[13px] text-muted-foreground-2">
              {done.number}
            </span>
          </>
        ) : (
          <>
            <MicroLabel>{refundOnly ? "Refunded" : "Sold"}</MicroLabel>
            <span
              data-testid="till-sale-number"
              className="tnum font-mono text-[20px] leading-[1.2] text-foreground"
            >
              {done.number}
            </span>
          </>
        )}
        {trade ? (
          <div data-testid="till-done-trade" className="mt-3 flex flex-col gap-1">
            <p className="text-[16px] leading-[1.5] text-foreground">
              Trade-in <span className="tnum font-mono text-[15px]">{trade.number}</span> paid{" "}
              <span className="tnum font-medium">{formatGBP(trade.applied)}</span>
            </p>
            {trade.payoutCredit > 0 ? (
              <p className="text-[15px] leading-[1.5] text-muted-foreground">
                Surplus <span className="tnum">{formatGBP(trade.payoutCredit)}</span> added as store
                credit
              </p>
            ) : trade.payoutCash > 0 ? (
              <p className="text-[15px] leading-[1.5] text-muted-foreground">
                Surplus paid in cash, <span className="tnum">{formatGBP(trade.payoutCash)}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        {refund ? (
          <div data-testid="till-done-refund" className="mt-3 flex flex-col gap-1">
            <p className="text-[16px] leading-[1.5] text-foreground">
              Refund <span className="tnum font-mono text-[15px]">{refund.ref}</span>,{" "}
              <span className="tnum font-medium">{formatGBP(refund.amount)}</span>
            </p>
            {refund.amount > refund.exchange ? (
              <p className="text-[15px] leading-[1.5] text-muted-foreground">
                <span className="tnum">{formatGBP(refund.amount - refund.exchange)}</span> back{" "}
                {refund.to}
              </p>
            ) : null}
          </div>
        ) : null}
        {done.pointsEarned > 0 ? (
          <p data-testid="till-points-earned" className="mt-2 text-[16px] text-foreground">
            Earned {done.pointsEarned.toLocaleString("en-GB")} points
          </p>
        ) : null}
        {waiting ? (
          <p className="mt-2 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
            Waiting to send. Its receipt can be printed or emailed once it has gone.
          </p>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="Receipt"
        className="mt-10 grid w-full max-w-[720px] grid-cols-2 gap-3 min-[1100px]:grid-cols-4"
      >
        <Button
          variant="key"
          size="till"
          loading={pending === "print"}
          disabled={busy || waiting}
          onClick={() => onChoose("print")}
        >
          Print
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "email"}
          disabled={busy || waiting || refundOnly}
          onClick={() => onChoose("email")}
        >
          Email
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "gift"}
          disabled={busy || waiting || refundOnly}
          onClick={() => onChoose("gift")}
        >
          Gift receipt
        </Button>
        <Button
          variant="key"
          size="till"
          loading={pending === "none"}
          disabled={busy}
          onClick={() => onChoose("none")}
        >
          No receipt
        </Button>
      </div>

      {askEmail ? (
        <div className="mt-8 flex w-full max-w-[560px] flex-col gap-4">
          <Field layout="stacked" label="Email the receipt to" htmlFor="till-receipt-email">
            <Input
              id="till-receipt-email"
              type="email"
              autoComplete="off"
              inputMode="email"
              value={email}
              containerClassName="min-h-14"
              placeholder="name@example.co.uk"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && email.trim()) onChoose("email", email)
              }}
            />
          </Field>
          <Button
            variant="text"
            className="min-h-14 self-start"
            disabled={busy || !email.trim()}
            onClick={() => onChoose("email", email)}
          >
            Send receipt
          </Button>
        </div>
      ) : null}

      {refund && !refundOnly && onPrintRefund ? (
        <Button
          variant="text"
          className="mt-6 min-h-14"
          loading={printingRefund}
          disabled={busy && !printingRefund}
          onClick={onPrintRefund}
        >
          Print refund receipt
        </Button>
      ) : null}

      <FieldError>{problem}</FieldError>

      <Button
        size="till"
        data-testid="till-new-sale"
        className="mt-10 w-full sm:w-auto sm:min-w-64"
        trailingArrow
        disabled={busy}
        onClick={onNewSale}
      >
        New sale
      </Button>
    </section>
  )
}
