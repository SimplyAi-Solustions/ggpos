/**
 * The customer display follows the till (docs/api-contract-epos.md,
 * section 4, "Customer display"): the ticket as it is built, then "Pay
 * £40.00 on the card reader" or the cash still to hand over, then the
 * change and "Thank you" with the points the sale earned.
 *
 * Choosing a receipt starts the next sale at once, so the thank-you is held
 * on the display for a few seconds after the ticket empties, unless the
 * next customer's first item lands first.
 *
 * A part-exchange or a return shows there the way it shows on the ticket
 * (docs/api-contract-epos.md, section 7): its lines after the basket's at
 * negative figures, and the total as what is left to pay once they are set
 * against the sale, in every stage.
 */
import * as React from "react"

import { salePayload, type SaleStage, type TillDisplayPayload } from "@/features/display/payload"
import { useDisplayPublish } from "@/features/display/publish"
import type { TicketSettlement, TicketTradeLine } from "@/features/till/exchange"
import { discountLabel, ticketIsEmpty, type Ticket, type TicketTotals } from "@/features/till/ticket"
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
  /** The trade's accepted lines at their credit offers, when there is a trade. */
  trade?: TicketTradeLine[]
  /** What is left to pay once a trade or a return is set against the sale. */
  settlement?: TicketSettlement
}): TillDisplayPayload | null {
  const { ticket, totals, phase, step, done } = input
  if (ticketIsEmpty(ticket)) return null
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
  // What the trade or the return takes off, as lines the customer can add
  // up: the display carries a title, a detail and a price per line, so a
  // trade line is "Trade-in: Charizard ex" at minus its credit offer.
  const credits = [
    ...(input.trade ?? []).map((line) => ({
      title: `Trade-in: ${line.title}`,
      detail: line.detail,
      qty: 1,
      unitPrice: -line.credit,
    })),
    ...(ticket.returns?.lines ?? []).map((line) => ({
      title: `Returned: ${line.title}`,
      detail: ticket.returns?.reason ?? "",
      qty: 1,
      unitPrice: -line.amount,
    })),
  ]
  return salePayload({
    lines: [
      ...ticket.lines.map((line) => ({
        title: line.title,
        detail: line.detail,
        qty: line.qty,
        unitPrice: line.unitPrice,
        image: line.image,
      })),
      ...credits,
    ],
    subtotal: totals.gross,
    discount: off,
    discountLabel: totals.lineDiscounts > 0 ? "Discount" : discountLabel(ticket, totals),
    total: input.settlement ? input.settlement.toPay : totals.total,
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
