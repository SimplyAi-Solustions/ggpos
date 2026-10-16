/**
 * A return's arithmetic: what the chosen lines and quantities come to, and
 * how that amount goes back (docs/api-contract-epos.md, section 4, the
 * refund route).
 *
 * The amount is the shared sale-line helper's, from the lookup's as-sold
 * figures, so the figure on the returns sheet is the figure the route moves:
 * every unit of every line is paid back once and no more, whatever has gone
 * back already. Pure.
 */
import {
  displayCode,
  formatGBP,
  refundAmount,
  type LineBreakdown,
  type SaleLookup,
  type SaleLookupLine,
} from "@gg/shared"

import type { TicketReturn } from "@/features/till/ticket"
import type { TillRefundTender } from "@/lib/api/sales"

export type RefundMethod = TillRefundTender["method"]

export const REFUND_METHODS: { method: RefundMethod; label: string }[] = [
  { method: "card_tide", label: "Card" },
  { method: "cash", label: "Cash" },
  { method: "store_credit", label: "Store credit" },
]

/** A lookup line as the shared helper reads it. */
export function asBreakdown(line: SaleLookupLine): LineBreakdown {
  const gross = line.unit_price * Math.max(1, line.qty) - line.discount
  return {
    id: line.id,
    qty: Math.max(1, line.qty),
    gross,
    allocation: gross - line.net,
    net: line.net,
    refundedQty: line.refunded_qty,
  }
}

/** What refunding these quantities comes to, in pence. */
export function refundTotal(sale: SaleLookup, chosen: Record<string, number>): number {
  return sale.lines.reduce((sum, line) => {
    const qty = Math.min(chosen[line.id] ?? 0, line.refundable_qty)
    return qty > 0 ? sum + refundAmount(asBreakdown(line), qty) : sum
  }, 0)
}

/**
 * The quantities ticked to start with: everything left on a sale of one
 * line, and nothing on a sale of several, where staff say which came back.
 */
export function initialChoice(sale: SaleLookup): Record<string, number> {
  const open = sale.lines.filter((line) => line.refundable_qty > 0)
  const chosen: Record<string, number> = {}
  for (const line of sale.lines) chosen[line.id] = 0
  if (open.length === 1 && open[0]) chosen[open[0].id] = open[0].refundable_qty
  return chosen
}

/** How the sale was mostly paid, which is where its refund goes by default. */
export function defaultRefundMethod(sale: SaleLookup): RefundMethod {
  const paid = sale.tenders
    .filter((tender) => tender.amount > 0)
    .sort((a, b) => b.amount - a.amount)[0]
  switch (paid?.method) {
    case "cash":
      return "cash"
    case "store_credit":
    case "points":
      return sale.customer ? "store_credit" : "cash"
    case undefined:
      return "cash"
    default:
      return "card_tide"
  }
}

/** The last four digits of the card it was paid on, to refund back to. */
export function originalCardLast4(sale: SaleLookup): string {
  return (
    sale.tenders.find(
      (tender) =>
        tender.amount > 0 &&
        (tender.method === "card_tide" || tender.method === "card_other") &&
        tender.card_last4
    )?.card_last4 ?? ""
  )
}

/**
 * The chosen lines as a return on the ticket ("Exchange in this ticket"),
 * each at what the shared breakdown says those units come back at, or the
 * sentence that says what is missing.
 */
export function ticketReturnFrom(
  sale: SaleLookup,
  chosen: Record<string, number>,
  reason: string,
  restock: boolean
): { ok: true; returns: TicketReturn } | { ok: false; message: string } {
  const lines = sale.lines.flatMap((line) => {
    const qty = Math.min(chosen[line.id] ?? 0, line.refundable_qty)
    if (qty <= 0) return []
    return [
      {
        saleLine: line.id,
        title: line.title,
        detail: line.sku ? displayCode(line.sku) : "Till product",
        qty,
        amount: refundAmount(asBreakdown(line), qty),
      },
    ]
  })
  if (lines.length === 0) return { ok: false, message: "Choose what is coming back." }
  if (!reason.trim()) return { ok: false, message: "Say why it is coming back." }
  return {
    ok: true,
    returns: {
      saleId: sale.id,
      saleNumber: sale.number,
      customer: sale.customer,
      lines,
      reason: reason.trim(),
      restock,
      refundMethod: defaultRefundMethod(sale),
      cardLast4: originalCardLast4(sale),
    },
  }
}

/**
 * The refund tenders: one method takes the whole amount; several take the
 * amounts keyed against them, which have to add up to it exactly.
 */
export function refundTenders(
  methods: RefundMethod[],
  amounts: Partial<Record<RefundMethod, number | null>>,
  total: number,
  last4: string,
  hasCustomer: boolean
): { ok: true; tenders: TillRefundTender[] } | { ok: false; message: string } {
  if (total <= 0) return { ok: false, message: "Choose what is coming back." }
  if (methods.length === 0) return { ok: false, message: "Choose where the money goes back." }
  if (methods.includes("store_credit") && !hasCustomer) {
    return { ok: false, message: "Store credit needs the customer on the sale. Refund it another way." }
  }
  const card = last4.trim()
  if (card && !/^\d{4}$/.test(card)) {
    return { ok: false, message: "Key the last four digits of the card." }
  }

  const tenders: TillRefundTender[] =
    methods.length === 1
      ? [{ method: methods[0] as RefundMethod, amount: total }]
      : methods.map((method) => ({ method, amount: amounts[method] ?? 0 }))

  if (tenders.some((tender) => !Number.isInteger(tender.amount) || tender.amount <= 0)) {
    return { ok: false, message: "Key an amount for each way the money goes back." }
  }
  const sum = tenders.reduce((acc, tender) => acc + tender.amount, 0)
  if (sum !== total) {
    return {
      ok: false,
      message: `Those come to ${formatGBP(sum)} but the refund is ${formatGBP(total)}. Make them match.`,
    }
  }
  return {
    ok: true,
    tenders: tenders.map((tender) =>
      tender.method === "card_tide" && card ? { ...tender, card_last4: card } : tender
    ),
  }
}
