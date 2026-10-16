/**
 * Paying for a ticket: the tenders taken so far, what is left, the change,
 * and the refusals the server would make, said first.
 *
 * The till's own copy of the tender rules (docs/api-contract-epos.md,
 * section 4, "Rules"): the payments sum exactly to the total, at most one
 * cash tender, cash handed over at least covers its part and only cash
 * gives change, a Tide card carries its last four digits when the shop asks
 * for them, store credit and points need a customer and the balance. The
 * sentences are the contract's. `packages/shared/src/tenders.ts` is being
 * written alongside this by the server package; when it lands, the checks
 * below are swapped for it and nothing else here changes.
 *
 * Pure: integer pence in, integer pence out.
 */
import {
  TENDER_LABELS,
  checkPointsRedemption,
  formatGBP,
  penceToPoints,
  type LoyaltyProgramme,
  type Tender,
  type TenderInput,
  type TillTender,
} from "@gg/shared"

import type { SaleCustomer } from "@/lib/api/types"

/**
 * A tender as the till holds it until the sale completes. Cash keeps what
 * was handed over and works its share out from the ticket, so a ticket
 * edited after the cash went in still gives the right change.
 */
export type TakenTender =
  | { id: string; method: "cash"; tendered: number }
  | { id: string; method: "card_tide"; amount: number; card_last4: string }
  | { id: string; method: "store_credit"; amount: number }
  | { id: string; method: "points"; amount: number }

/** A tender with its share of the ticket worked out. */
export interface ResolvedTender {
  id: string
  method: TillTender
  amount: number
  /** Cash only. */
  tendered: number
  change: number
  card_last4: string
}

export interface TenderState {
  tenders: ResolvedTender[]
  /** Everything the tenders cover. */
  covered: number
  /** What is still to pay. Never below zero. */
  left: number
  /** Cash handed over beyond the cash share. */
  change: number
  /**
   * Card, credit and points put against more than the total: the ticket
   * came down after they were taken. One of them has to come off.
   */
  over: number
}

function cashShare(tendered: number, nonCash: number, total: number): number {
  return Math.max(0, Math.min(tendered, total - nonCash))
}

/** Where the paying has got to, for a ticket total and the tenders taken. */
export function resolveTenders(total: number, taken: TakenTender[]): TenderState {
  const nonCash = taken.reduce((sum, tender) => sum + (tender.method === "cash" ? 0 : tender.amount), 0)
  const tenders: ResolvedTender[] = taken.map((tender) => {
    if (tender.method === "cash") {
      const amount = cashShare(tender.tendered, nonCash, total)
      return {
        id: tender.id,
        method: "cash",
        amount,
        tendered: tender.tendered,
        change: tender.tendered - amount,
        card_last4: "",
      }
    }
    return {
      id: tender.id,
      method: tender.method,
      amount: tender.amount,
      tendered: 0,
      change: 0,
      card_last4: tender.method === "card_tide" ? tender.card_last4 : "",
    }
  })
  const covered = tenders.reduce((sum, tender) => sum + tender.amount, 0)
  return {
    tenders,
    covered,
    left: Math.max(0, total - covered),
    change: tenders.reduce((sum, tender) => sum + tender.change, 0),
    over: Math.max(0, nonCash - total),
  }
}

/** "Cash", "Card ending 4242", "Store credit", "Points". */
export function tenderLabel(tender: Pick<ResolvedTender, "method" | "card_last4">): string {
  if (tender.method === "card_tide" && tender.card_last4) {
    return `Card ending ${tender.card_last4}`
  }
  return TENDER_LABELS[tender.method]
}

/** A stored tender row as the receipt and the lookup name it. */
export function storedTenderLabel(tender: Pick<Tender, "method" | "label" | "card_last4">): string {
  if ((tender.method === "card_tide" || tender.method === "card_other") && tender.card_last4) {
    return `Card ending ${tender.card_last4}`
  }
  return tender.label || TENDER_LABELS[tender.method] || "Payment"
}

/** The tenders as the sale route takes them. Cash carries what was handed over. */
export function tenderInputs(state: TenderState): TenderInput[] {
  return state.tenders
    .filter((tender) => tender.amount > 0)
    .map((tender) => {
      if (tender.method === "cash") {
        return { method: "cash", amount: tender.amount, tendered: tender.tendered }
      }
      if (tender.method === "card_tide") {
        return {
          method: "card_tide",
          amount: tender.amount,
          ...(tender.card_last4 ? { card_last4: tender.card_last4 } : {}),
        }
      }
      return { method: tender.method, amount: tender.amount }
    })
}

/**
 * The quick note keys: the shop's notes that are more than what is left,
 * smallest first. "Exact" sits in front of them on the screen.
 */
export function quickNotes(left: number, notes: number[]): number[] {
  return [...notes]
    .filter((note) => Number.isInteger(note) && note > left)
    .sort((a, b) => a - b)
    .slice(0, 4)
}

// ---------------------------------------------------------------------------
// The checks, one per tender step
// ---------------------------------------------------------------------------

export type TenderCheck<T> = { ok: true; value: T } | { ok: false; message: string }

function refuse<T>(message: string): TenderCheck<T> {
  return { ok: false, message }
}

let minted = 0

/** A local id for a tender row: only ever used to remove that row again. */
export function tenderId(): string {
  minted += 1
  return `tender_${Date.now().toString(36)}_${minted}`
}

/**
 * Cash handed over. One cash tender per sale, so a second handful goes on
 * the first. `cashCap` is `settings.cash_cap`: zero switches cash off.
 */
export function takeCash(
  taken: TakenTender[],
  total: number,
  handed: number,
  cashCap?: number
): TenderCheck<TakenTender[]> {
  if (!Number.isInteger(handed) || handed <= 0) {
    return refuse("Key the cash handed over, or press Exact.")
  }
  const existing = taken.find((tender) => tender.method === "cash")
  const tendered = (existing?.method === "cash" ? existing.tendered : 0) + handed
  const nonCash = taken.reduce(
    (sum, tender) => sum + (tender.method === "cash" ? 0 : tender.amount),
    0
  )
  const share = cashShare(tendered, nonCash, total)
  if (cashCap !== undefined) {
    if (cashCap <= 0) return refuse("Cash sales are switched off in settings.")
    if (share > cashCap) {
      return refuse(`Cash is capped at ${formatGBP(cashCap)} a sale. Take the rest by card.`)
    }
  }
  if (existing) {
    return {
      ok: true,
      value: taken.map((tender) =>
        tender.id === existing.id ? { id: tender.id, method: "cash", tendered } : tender
      ),
    }
  }
  return { ok: true, value: [...taken, { id: tenderId(), method: "cash", tendered }] }
}

/** The card part, approved on the Tide reader: always what is left. */
export function takeCard(
  taken: TakenTender[],
  left: number,
  last4: string,
  requireLast4: boolean
): TenderCheck<TakenTender[]> {
  if (left <= 0) return refuse("Nothing is left to pay.")
  const digits = last4.trim()
  if (digits && !/^\d{4}$/.test(digits)) return refuse("Key the last four digits of the card.")
  if (requireLast4 && !digits) return refuse("Key the last four digits of the card.")
  return {
    ok: true,
    value: [...taken, { id: tenderId(), method: "card_tide", amount: left, card_last4: digits }],
  }
}

function alreadyTaken(taken: TakenTender[], method: "store_credit" | "points"): number {
  return taken.reduce(
    (sum, tender) => sum + (tender.method === method ? tender.amount : 0),
    0
  )
}

function merge(
  taken: TakenTender[],
  method: "store_credit" | "points",
  amount: number
): TakenTender[] {
  const existing = taken.find((tender) => tender.method === method)
  if (!existing || existing.method === "cash" || existing.method === "card_tide") {
    return [...taken, { id: tenderId(), method, amount }]
  }
  return taken.map((tender) =>
    tender.id === existing.id ? { ...existing, amount: existing.amount + amount } : tender
  )
}

/** The most store credit that can go on this ticket now. */
export function maxStoreCredit(
  taken: TakenTender[],
  left: number,
  customer: SaleCustomer | null
): number {
  if (!customer) return 0
  return Math.max(0, Math.min(left, customer.creditBalance - alreadyTaken(taken, "store_credit")))
}

export function takeStoreCredit(
  taken: TakenTender[],
  left: number,
  amount: number,
  customer: SaleCustomer | null
): TenderCheck<TakenTender[]> {
  if (!customer) return refuse("Attach the customer to pay with store credit.")
  if (!Number.isInteger(amount) || amount <= 0) return refuse("Key an amount of store credit.")
  if (amount > left) return refuse(`That is more than the ${formatGBP(left)} left to pay.`)
  const balance = customer.creditBalance - alreadyTaken(taken, "store_credit")
  if (amount > balance) {
    return refuse(
      `This customer has ${formatGBP(Math.max(0, balance))} in store credit. Lower the amount.`
    )
  }
  return { ok: true, value: merge(taken, "store_credit", amount) }
}

/**
 * The most the customer's points can pay for on this ticket, in pence: the
 * programme's share of the sale, their balance, and what is left, whichever
 * is least.
 */
export function maxPoints(
  taken: TakenTender[],
  left: number,
  total: number,
  customer: SaleCustomer | null,
  programme: LoyaltyProgramme | undefined
): number {
  if (!customer || !programme || !programme.enabled) return 0
  const check = checkPointsRedemption(programme, customer.pointsBalance, 0, total)
  const share = Math.floor((check.maxPointsForSale * 100) / programme.pointsPerPoundRedemption)
  return Math.max(0, Math.min(left, share - alreadyTaken(taken, "points")))
}

export function takePoints(
  taken: TakenTender[],
  left: number,
  total: number,
  amount: number,
  customer: SaleCustomer | null,
  programme: LoyaltyProgramme | undefined
): TenderCheck<TakenTender[]> {
  if (!customer || !programme) return refuse("Attach the customer to pay with points.")
  if (!Number.isInteger(amount) || amount <= 0) return refuse("Key an amount to pay in points.")
  if (amount > left) return refuse(`That is more than the ${formatGBP(left)} left to pay.`)
  const pence = alreadyTaken(taken, "points") + amount
  const points = penceToPoints(pence, programme)
  const check = checkPointsRedemption(programme, customer.pointsBalance, points, total)
  if (!check.ok) {
    switch (check.reason) {
      case "disabled":
        return refuse("The GG Guild is switched off, so points cannot be used.")
      case "below_minimum":
        return refuse(
          `Points start at ${programme.minRedeemPoints.toLocaleString("en-GB")} points. Take this one another way.`
        )
      case "insufficient":
        return refuse(
          `This customer has ${customer.pointsBalance.toLocaleString("en-GB")} points. Lower the amount.`
        )
      default:
        return refuse(
          `Points can cover at most ${formatGBP(
            Math.floor((check.maxPointsForSale * 100) / programme.pointsPerPoundRedemption)
          )} of this sale.`
        )
    }
  }
  return { ok: true, value: merge(taken, "points", amount) }
}

/**
 * The last check before the sale goes: the contract's own sentence when the
 * tenders and the total disagree, or null when they match.
 */
export function tendersProblem(total: number, state: TenderState): string | null {
  if (state.over > 0) {
    return `The payments come to ${formatGBP(state.covered)} but the total is ${formatGBP(total)}. Remove a payment.`
  }
  if (state.covered !== total) {
    return `The payments come to ${formatGBP(state.covered)} but the total is ${formatGBP(total)}.`
  }
  return null
}
