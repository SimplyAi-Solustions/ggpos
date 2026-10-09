/**
 * The customer display follows the till (docs/api-contract-epos.md,
 * section 4, "Customer display"): the ticket as it is built, then "Pay
 * £40.00 on the card reader" or the cash still to hand over, then the
 * change and "Thank you" with the points the sale earned.
 *
 * Choosing a receipt starts the next sale at once, so the thank-you is held
 * on the display for a few seconds after the ticket empties, unless the
 * next customer's first item lands first.
 */
import * as React from "react"

import { salePayload, type SaleStage, type TillDisplayPayload } from "@/features/display/payload"
import { useDisplayPublish } from "@/features/display/publish"
import { discountLabel, type Ticket, type TicketTotals } from "@/features/till/ticket"
import type { DoneSale, TenderStep, TillPhase } from "@/features/till/till-store"

/** How long "Thank you" stays up once the till has moved on. */
export const THANKS_MS = 8000

export function tillDisplayPayload(input: {
  ticket: Ticket
  totals: TicketTotals
  points: number
  phase: TillPhase
  step: TenderStep | null
  left: number
  done: DoneSale | null
}): TillDisplayPayload | null {
  const { ticket, totals, phase, step, done } = input
  if (ticket.lines.length === 0) return null
  const stage: SaleStage =
    phase === "done"
      ? "done"
      : phase === "paying" && step === "card_tide"
        ? "card"
        : phase === "paying" && step === "cash"
          ? "cash"
          : "basket"
  // The lines at their own prices, and everything that came off them, a
  // line's own discount included, as the one discount line: the customer
  // can add it up and get the total.
  const off = totals.lineDiscounts + totals.discount
  return salePayload({
    lines: ticket.lines.map((line) => ({
      title: line.title,
      detail: line.detail,
      qty: line.qty,
      unitPrice: line.unitPrice,
      image: line.image,
    })),
    subtotal: totals.gross,
    discount: off,
    discountLabel: totals.lineDiscounts > 0 ? "Discount" : discountLabel(ticket, totals),
    total: totals.total,
    pointsToEarn: input.points,
    customerName: ticket.customer?.name,
    stage,
    amountDue: input.left,
    change: done?.change ?? 0,
    pointsEarned: done?.pointsEarned ?? 0,
  })
}

export function useTillDisplay(enabled: boolean, payload: TillDisplayPayload | null): void {
  const [thanks, setThanks] = React.useState<TillDisplayPayload | null>(null)
  const last = React.useRef<TillDisplayPayload | null>(null)
  // The payload as text, so the hold reacts to a change of content rather
  // than to every new object a render makes.
  const key = payload === null ? "" : JSON.stringify(payload)

  React.useEffect(() => {
    const next = key ? (JSON.parse(key) as TillDisplayPayload) : null
    const previous = last.current
    last.current = next
    if (next === null && previous?.stage === "done") {
      setThanks(previous)
      const timer = window.setTimeout(() => setThanks(null), THANKS_MS)
      return () => window.clearTimeout(timer)
    }
    if (next !== null) setThanks(null)
    return undefined
  }, [key])

  useDisplayPublish(enabled, "sale", payload ?? thanks)
}
