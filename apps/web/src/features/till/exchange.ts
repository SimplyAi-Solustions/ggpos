/**
 * A trade-in and a return on the ticket: what they take off the sale, what
 * is left to pay, the surplus, and what goes to the server
 * (docs/api-contract-epos.md, section 7).
 *
 * The contract's letters, kept here so the screen, the tests and the demo
 * all read the same arithmetic:
 *
 *  - S, the sale: the ticket after discounts, perks and rewards.
 *  - V, a trade's value: its accepted lines at their credit offers.
 *    A = min(V, S) is what the trade pays towards the sale (the
 *    `part_exchange` tender) and U = V - A is the surplus, paid as store
 *    credit or, at the cash rate, in cash.
 *  - R, a return's value: the refund the shared breakdown gives for the
 *    lines coming back. The trade applies first, so E = min(R, S - A)
 *    pays towards the sale (the `exchange` tender) and R - E goes back as
 *    a refund through the return's own tenders.
 *
 * The other tenders cover S - A - E, and may be none at all. Pure: integer
 * pence in, integer pence out.
 */
import {
  formatGBP,
  roundHalfUp,
  type TenderInput,
  type TicketReturnsInput,
  type TradeSettlementInput,
} from "@gg/shared"
import type { ConditionMultipliers, OfferSettings, PricingRule } from "@gg/shared/pricing"

import { idCaptureProblem, type IdCaptureValues } from "@/features/tradein/id-capture"
import {
  PENDING_SOURCE,
  cashBlock,
  lineOffer,
  totals as tradeTotals,
  type IdGate,
  type TradeLine,
  type WizardCustomer,
} from "@/features/tradein/machine"
import type { RefundMethod } from "@/features/till/returns"
import type { TicketReturn, TicketTrade } from "@/features/till/ticket"
import type { IdCheckPayload } from "@/lib/api/types"

/** How a ticket is finished: tenders against what is left, a surplus to settle, or a refund. */
export type SettleMode = "pay" | "settle" | "refund"

export interface TicketSettlement {
  /** S: the ticket after discounts, perks and rewards. */
  sale: number
  /** V, or null with no trade-in on the ticket. */
  trade: number | null
  /** R, or null with no return on the ticket. */
  returns: number | null
  kind: "none" | "trade" | "return" | "both"
  /** A = min(V, S): what the trade pays towards the sale. */
  applied: number
  /** E = min(R, S - A): what the return pays towards the sale. */
  exchange: number
  /** What the other tenders have to cover: S - A - E. */
  toPay: number
  /** U = V - A: the trade's surplus, paid as credit or cash. */
  surplus: number
  /** R - E: the part of the return that goes back to the customer. */
  refund: number
  mode: SettleMode
}

/**
 * Where a ticket stands once its trade and its return are set against it.
 *
 * Anything left to pay is paid as usual. When nothing is left, a ticket
 * with a trade-in is settled: its surplus (possibly none) is paid out, any
 * return's difference goes back, and the customer signs. A ticket with only
 * a return is a refund of the difference, and a ticket of returns alone is
 * simply a refund.
 */
export function settleTicket(
  sale: number,
  credits: { trade?: number | null; returns?: number | null } = {}
): TicketSettlement {
  const s = Math.max(0, sale)
  const trade = credits.trade === null || credits.trade === undefined ? null : Math.max(0, credits.trade)
  const returns =
    credits.returns === null || credits.returns === undefined ? null : Math.max(0, credits.returns)
  const kind =
    trade !== null && returns !== null
      ? "both"
      : trade !== null
        ? "trade"
        : returns !== null
          ? "return"
          : "none"
  // The trade applies first, then the return against what it left.
  const applied = Math.min(trade ?? 0, s)
  const exchange = Math.min(returns ?? 0, s - applied)
  const toPay = s - applied - exchange
  const mode: SettleMode =
    kind === "none" || toPay > 0 ? "pay" : trade !== null ? "settle" : "refund"
  return {
    sale: s,
    trade,
    returns,
    kind,
    applied,
    exchange,
    toPay,
    surplus: (trade ?? 0) - applied,
    refund: (returns ?? 0) - exchange,
    mode,
  }
}

// ---------------------------------------------------------------------------
// The trade
// ---------------------------------------------------------------------------

export interface TradeFigures {
  /** V: the accepted lines at their credit offers. */
  credit: number
  /** The same lines at their cash offers, for the cash-rate surplus. */
  cash: number
  /** Accepted lines. */
  lines: number
  /** An accepted line whose price routes have not answered yet. */
  pending: boolean
}

export interface PricingContext {
  rules: PricingRule[]
  settings: OfferSettings
  multipliers: ConditionMultipliers
}

/** The trade's figures through the wizard's own offer machine. */
export function tradeFigures(lines: TradeLine[], pricing: PricingContext): TradeFigures {
  const sums = tradeTotals(lines, pricing.rules, pricing.settings, pricing.multipliers)
  return {
    credit: sums.credit,
    cash: sums.cash,
    lines: sums.lines,
    pending: lines.some((line) => line.accepted && line.marketSource === PENDING_SOURCE),
  }
}

/** A trade line as the ticket shows it: what it is, and the credit it takes off. */
export interface TicketTradeLine {
  key: string
  title: string
  /** The condition, set and number: one short grey line. */
  detail: string
  /** The line's credit offer, quantity included. Shown negative. */
  credit: number
}

/** The accepted lines as the ticket's trade group lists them. */
export function ticketTradeLines(lines: TradeLine[], pricing: PricingContext): TicketTradeLine[] {
  return lines
    .filter((line) => line.accepted)
    .map((line) => {
      const offer = lineOffer(line, pricing.rules, pricing.settings, pricing.multipliers)
      const count = line.kind === "bulk" || line.qty <= 1 ? "" : `${line.qty} of them`
      return {
        key: line.key,
        title: line.title,
        detail: [line.condition, line.setName, line.number, count].filter(Boolean).join(" · "),
        credit: offer.creditTotal,
      }
    })
}

/**
 * Why the trade cannot be paid with yet, or null. Said before Pay rather
 * than left to the server: a line still being priced would change the
 * offer the customer is about to sign for.
 */
export function tradeProblem(
  trade: TicketTrade,
  figures: TradeFigures,
  saleLines: number
): string | null {
  if (!trade.tradeInId) return "The trade-in is still being saved. Give it a moment."
  if (figures.lines === 0) return "Add at least one item to the trade-in, or take it off."
  if (figures.pending) return "One trade-in line is still being priced. Give it a moment."
  if (figures.credit <= 0) {
    return "Every trade-in line is at nothing. Enter a market price, or override the offer."
  }
  // The server's own sentence for a trade with nothing to pay for.
  if (saleLines === 0) {
    return "There is nothing on the ticket for the trade-in to pay for. Add an item, or complete it as a buy-in."
  }
  return null
}

/**
 * The surplus at the cash rate: the part of the trade the sale did not use,
 * valued the way the lines' cash offers value the whole trade. Staff can key
 * it lower; the server takes anything from 1p to the credit surplus.
 */
export function cashRateSurplus(surplus: number, figures: Pick<TradeFigures, "credit" | "cash">): number {
  if (surplus <= 0 || figures.credit <= 0 || figures.cash <= 0) return 0
  return Math.min(surplus, roundHalfUp((surplus * figures.cash) / figures.credit))
}

/**
 * The cash a surplus pays out: what staff keyed (pence digits, as the money
 * pad builds them), or the cash-rate figure while nothing is keyed.
 */
export function surplusCash(
  cashDigits: string,
  settlement: Pick<TicketSettlement, "surplus">,
  figures: Pick<TradeFigures, "credit" | "cash">
): number {
  if (!cashDigits) return cashRateSurplus(settlement.surplus, figures)
  const keyed = Number.parseInt(cashDigits, 10)
  return Number.isFinite(keyed) ? keyed : 0
}

/** Why a keyed cash surplus will not do, in the server's words, or null. */
export function surplusCashProblem(cash: number, surplus: number): string | null {
  if (!Number.isInteger(cash) || cash < 1 || cash > surplus) {
    return `Pay between £0.01 and ${formatGBP(surplus)} in cash, or pay the surplus as credit.`
  }
  return null
}

/** What choosing cash costs the customer, in words, so both figures are on screen before Complete. */
export function surplusDifference(cash: number, surplus: number): string {
  if (cash >= surplus) return `Paying the whole ${formatGBP(surplus)} in cash.`
  return `Paying ${formatGBP(cash)} in cash instead of ${formatGBP(surplus)} in store credit. The ${formatGBP(
    surplus - cash
  )} difference stays with the shop.`
}

export type SurplusChoice = "credit" | "cash"

export interface AgreementInput {
  settlement: TicketSettlement
  choice: SurplusChoice | null
  /** The cash keyed for the surplus, in pence. */
  cash: number
  terms: boolean
  signature: string | null
  customer: WizardCustomer | null
  cashCap: number
  /** What a cash surplus still needs from the ID step, from `idGate`. */
  gate: IdGate
  capture: IdCaptureValues
}

/**
 * The buy-in's rules at the till, first refusal first: the surplus has a
 * home, cash is allowed for this customer and under the cap, the ID step has
 * what it needs, and the customer has heard the terms and signed. Null when
 * the trade can go.
 */
export function agreementProblem(input: AgreementInput, now: Date = new Date()): string | null {
  const { settlement } = input
  if (settlement.trade === null) return null
  if (settlement.surplus > 0) {
    if (!input.choice) return "Pay the surplus as credit or cash."
    if (input.choice === "cash") {
      const amount = surplusCashProblem(input.cash, settlement.surplus)
      if (amount) return amount
      if (!input.customer) return "The customer's details are still loading. Give it a moment."
      const block = cashBlock(input.customer.facts, input.cash, input.cashCap, now)
      if (block.kind !== "none") return block.message
      const id = idCaptureProblem(input.capture, input.gate)
      if (id) return id
    }
  }
  if (!input.terms) return "Read the terms to the customer and tick the box."
  if (!input.signature) return "Ask the customer to sign before you continue."
  return null
}

/** Whether the cash surplus needs the ID step at all. */
export function needsIdStep(settlement: TicketSettlement, choice: SurplusChoice | null): boolean {
  return settlement.trade !== null && settlement.surplus > 0 && choice === "cash"
}

/** `trade_settlement` as the sale route takes it. */
export function tradeSettlementInput(input: {
  settlement: TicketSettlement
  choice: SurplusChoice | null
  cash: number
  terms: boolean
  signature: string | null
  idCheck: IdCheckPayload | null
}): TradeSettlementInput {
  const surplus = input.settlement.surplus > 0 && input.choice
  return {
    ...(surplus ? { surplus: input.choice as SurplusChoice } : {}),
    ...(surplus && input.choice === "cash" ? { surplus_cash: input.cash } : {}),
    terms_accepted: input.terms,
    ...(input.signature ? { signature: input.signature } : {}),
    ...(surplus && input.choice === "cash" && input.idCheck ? { id_check: input.idCheck } : {}),
  }
}

// ---------------------------------------------------------------------------
// The return
// ---------------------------------------------------------------------------

/** R: what the lines coming back are worth. */
export function returnsValue(returns: TicketReturn | null): number {
  if (!returns) return 0
  return returns.lines.reduce((sum, line) => sum + line.amount, 0)
}

/** Why the difference cannot go back this way, or null. */
export function refundProblem(
  method: RefundMethod | null,
  returns: TicketReturn,
  last4: string
): string | null {
  if (!method) return "Choose where the money goes back."
  if (method === "store_credit" && !returns.customer) {
    return "Store credit needs the customer on the sale. Refund it another way."
  }
  const card = last4.trim()
  if (method === "card_tide" && card && !/^\d{4}$/.test(card)) {
    return "Key the last four digits of the card."
  }
  return null
}

/** Where a refund went, as the end of a sentence: "in cash", "to the card ending 4242". */
export function refundDestination(method: RefundMethod, last4: string): string {
  if (method === "cash") return "in cash"
  if (method === "store_credit") return "as store credit"
  const card = last4.trim()
  return card ? `to the card ending ${card}` : "to the card"
}

/** The refund tender for the part of a return the sale did not use. */
export function refundTender(method: RefundMethod, amount: number, last4: string): TenderInput {
  const card = last4.trim()
  return {
    method,
    amount,
    ...(method === "card_tide" && card ? { card_last4: card } : {}),
  }
}

/** `returns` as the sale route takes it, with the refund tender when there is one. */
export function returnsInput(
  returns: TicketReturn,
  refund: TenderInput | null
): TicketReturnsInput {
  return {
    sale: returns.saleId,
    lines: returns.lines.map((line) => ({
      sale_line: line.saleLine,
      qty: line.qty,
      restock: returns.restock,
    })),
    reason: returns.reason,
    ...(refund && refund.amount > 0 ? { tenders: [refund] } : {}),
  }
}

/**
 * What the ticket's one block says: Pay what is left, Settle a trade that
 * covers the ticket, Refund a return's difference, or Exchange when a
 * return covers the ticket exactly.
 */
export function payLabel(settlement: TicketSettlement): "Pay" | "Settle" | "Refund" | "Exchange" {
  if (settlement.mode === "settle") return "Settle"
  if (settlement.mode === "refund") return settlement.refund > 0 ? "Refund" : "Exchange"
  return "Pay"
}

/** What the ticket says when the trade or the return is worth more than it, else null. */
export function surplusSentence(settlement: TicketSettlement, saleLines: number): string | null {
  const said: string[] = []
  if (settlement.surplus > 0) {
    said.push(`The trade-in is worth ${formatGBP(settlement.surplus)} more than the ticket.`)
  }
  if (settlement.refund > 0) {
    said.push(
      saleLines === 0
        ? `Nothing new is on the ticket, so this is a refund of ${formatGBP(settlement.refund)}.`
        : settlement.exchange === 0
          ? `The return, ${formatGBP(settlement.refund)}, goes back to the customer.`
          : `The return is worth ${formatGBP(settlement.refund)} more than the ticket.`
    )
  }
  return said.length > 0 ? said.join(" ") : null
}

/** The Settle pane's sentence: what the trade and the return each do to the ticket. */
export function settleSentence(settlement: TicketSettlement): string {
  const { sale, applied, exchange, surplus, refund } = settlement
  const parts: string[] = []
  if (applied >= sale) {
    parts.push(
      surplus > 0
        ? `The trade-in pays the whole ${formatGBP(sale)} ticket and is worth ${formatGBP(surplus)} more.`
        : `The trade-in pays the whole ${formatGBP(sale)} ticket, exactly.`
    )
  } else {
    parts.push(
      `The trade-in pays ${formatGBP(applied)} of the ${formatGBP(sale)} ticket and the return the other ${formatGBP(exchange)}.`
    )
  }
  if (refund > 0) parts.push(`${formatGBP(refund)} of the return goes back to the customer.`)
  return parts.join(" ")
}

/** The contract's sentence when the tenders and what is left disagree, or null when they match. */
export function leftProblem(
  settlement: TicketSettlement,
  covered: number,
  over: number
): string | null {
  const left = settlement.toPay
  if (covered === left && over === 0) return null
  // The server's words for each (docs/api-contract-epos.md, section 7).
  const after =
    settlement.kind === "both"
      ? `${formatGBP(left)} is left after the trade-in and the exchange`
      : settlement.kind === "trade"
        ? `${formatGBP(left)} is left after the trade-in`
        : settlement.kind === "return"
          ? `${formatGBP(left)} is left after the exchange`
          : `the total is ${formatGBP(left)}`
  return `The payments come to ${formatGBP(covered)} but ${after}.${over > 0 ? " Remove a payment." : ""}`
}
