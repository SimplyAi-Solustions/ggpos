/**
 * The open ticket, held outside React so it survives everything the till
 * goes through in a day: the screen locking, another member of staff
 * unlocking it with their PIN, a walk to the cash-up screen and back, and a
 * reload (docs/EPOS-PLAN.md, "Switching user keeps the open ticket").
 *
 * Kept in `sessionStorage`, one entry per register, so the Mac and the
 * tablet each keep their own ticket and a closed tab leaves nothing behind.
 * A ticket is not a record: nothing is written to the server until the sale
 * completes, except a parked ticket, which is its own route.
 *
 * The client id is the sale's idempotency key on `sales/complete` and the
 * offline queue's key for the same sale. It is minted the first time the
 * ticket is paid for and kept until the sale is done, through a reload too,
 * so a reply lost on the way back is retried as the same sale rather than
 * ringing the ticket up twice.
 */
import * as React from "react"
import type { TillTender } from "@gg/shared"

import type { RefundMethod } from "@/features/till/returns"
import { emptyTicket, ticketReducer, type Ticket, type TicketAction } from "@/features/till/ticket"
import type { TakenTender } from "@/features/till/tenders"
import { newClientId } from "@/lib/offline/queue"
import { getTillDevice } from "@/lib/till-device"

export type TillPhase = "ticket" | "paying" | "done"

/** The tender step open under the tender keys. `trade` is the part-exchange's terms and signature. */
export type TenderStep = TillTender | "voucher" | "trade"

/** A completed sale, for the done view. */
export interface DoneSale {
  /**
   * The sale's id, or `queued:<client id>` while it waits to send. For a
   * ticket of returns alone, which makes no sale, the original sale's id,
   * which its refund receipt prints from.
   */
  saleId: string
  /** The sale number, or for a ticket of returns alone the refund reference. */
  number: string
  total: number
  change: number
  pointsEarned: number
  /** Cash went in or out of the drawer, so "No receipt" opens it. */
  cash: boolean
  /** Still in the offline queue: no receipt can be printed for it yet. */
  queued: boolean
  /** A part-exchange: its number, what it paid towards the sale and the surplus paid out. */
  tradeIn?: { number: string; applied: number; payoutCash: number; payoutCredit: number } | null
  /** A return on the ticket: its reference, its value and the part that paid for this sale. */
  refund?: {
    ref: string
    amount: number
    exchange: number
    /** The original sale, whose refund receipt this is. */
    saleId: string
    /** Where the rest went back: "in cash", "to the card ending 4242", "as store credit". */
    to: string
  } | null
  /** Cash handed to the customer: a cash surplus or a cash refund. */
  payout?: number
  /** Returns and no sale: only the refund's receipt exists. */
  refundOnly?: boolean
}

/**
 * How a part-exchange or a return is being settled while the ticket is paid
 * for. Cleared when the ticket goes back to being edited: a signature is
 * for the trade the customer saw.
 */
export interface TillSettlement {
  /** Where a trade's surplus goes. */
  surplus: "credit" | "cash" | null
  /** The cash keyed for a cash surplus, as pence digits; "" is the suggested figure. */
  surplusCash: string
  terms: boolean
  /** The pad's PNG data URL. */
  signature: string | null
  /** Where a return's difference goes back to, when it is worth more than the sale. */
  refundMethod: RefundMethod | null
  cardLast4: string
}

export function emptySettlement(): TillSettlement {
  return {
    surplus: null,
    surplusCash: "",
    terms: false,
    signature: null,
    refundMethod: null,
    cardLast4: "",
  }
}

export interface TillState {
  ticket: Ticket
  clientId: string | null
  tenders: TakenTender[]
  phase: TillPhase
  step: TenderStep | null
  done: DoneSale | null
  settlement: TillSettlement
}

export type TillAction =
  | TicketAction
  | { type: "pay" }
  | { type: "backToTicket" }
  | { type: "openStep"; step: TenderStep | null }
  | { type: "setTenders"; tenders: TakenTender[] }
  | { type: "removeTender"; id: string }
  | { type: "settlement"; patch: Partial<TillSettlement> }
  | { type: "completed"; done: DoneSale }
  | { type: "newSale" }
  | { type: "recall"; ticket: Ticket }

export function emptyTill(): TillState {
  return {
    ticket: emptyTicket(),
    clientId: null,
    tenders: [],
    phase: "ticket",
    step: null,
    done: null,
    settlement: emptySettlement(),
  }
}

const TICKET_ACTIONS = new Set<TicketAction["type"]>([
  "add",
  "setQty",
  "updateLine",
  "remove",
  "attachCustomer",
  "setDiscount",
  "applyVoucher",
  "load",
  "clear",
  "startTrade",
  "trade",
  "dropTrade",
  "rebaseTrade",
  "setReturns",
])

function isTicketAction(action: TillAction): action is TicketAction {
  return TICKET_ACTIONS.has(action.type as TicketAction["type"])
}

/**
 * The trade's own housekeeping: a draft's id arriving, saved lines adopting
 * their ids, a vanished draft being started again. None of it is somebody
 * changing the ticket, so none of it may start the next sale while the
 * last one is on the done view.
 */
function isTradeHousekeeping(action: TicketAction): boolean {
  if (action.type === "rebaseTrade") return true
  return (
    action.type === "trade" &&
    (action.action.type === "adopt-line-ids" || action.action.type === "set-draft")
  )
}

export function tillReducer(state: TillState, action: TillAction): TillState {
  if (isTicketAction(action)) {
    if (state.phase === "done" && isTradeHousekeeping(action)) return state
    // A finished sale is not edited: anything added now starts the next one.
    const base = state.phase === "done" ? emptyTill() : state
    const ticket = ticketReducer(base.ticket, action)
    if (action.type === "clear") return emptyTill()
    return ticket === base.ticket && base === state ? state : { ...base, ticket }
  }
  switch (action.type) {
    case "pay":
      if (state.phase !== "ticket") return state
      return { ...state, phase: "paying", step: null }
    case "backToTicket":
      if (state.phase !== "paying") return state
      return { ...state, phase: "ticket", step: null, settlement: emptySettlement() }
    case "openStep":
      return { ...state, step: action.step }
    case "setTenders":
      return { ...state, tenders: action.tenders }
    case "removeTender":
      return { ...state, tenders: state.tenders.filter((tender) => tender.id !== action.id) }
    case "settlement":
      if (state.phase !== "paying") return state
      return { ...state, settlement: { ...state.settlement, ...action.patch } }
    case "completed":
      return { ...state, phase: "done", step: null, done: action.done }
    case "newSale":
      return emptyTill()
    case "recall":
      return { ...emptyTill(), ticket: action.ticket }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const PREFIX = "gg.till.ticket"

/** A register's storage key; "default" when this browser is not a till. */
export function storageKey(register: string | undefined): string {
  return `${PREFIX}.${register || "default"}`
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage
  } catch {
    // Blocked site data: the ticket still lives for this page load.
    return null
  }
}

let storage: StorageLike | null = null
let key: string | null = null
let state: TillState | null = null
const listeners = new Set<() => void>()

/**
 * What was saved, if it still reads as a till state. A ticket from an older
 * build that does not is dropped rather than half-trusted.
 */
function read(): TillState {
  if (!key) return emptyTill()
  try {
    const raw = storage?.getItem(key)
    if (!raw) return emptyTill()
    const parsed = JSON.parse(raw) as Partial<TillState>
    if (!parsed.ticket || !Array.isArray(parsed.ticket.lines) || !Array.isArray(parsed.tenders)) {
      return emptyTill()
    }
    return {
      ...emptyTill(),
      ...parsed,
      ticket: { ...emptyTicket(), ...parsed.ticket },
      settlement: { ...emptySettlement(), ...parsed.settlement },
    } as TillState
  } catch {
    return emptyTill()
  }
}

function write(next: TillState) {
  if (!key) return
  try {
    storage?.setItem(key, JSON.stringify(next))
  } catch {
    // Full or blocked: the ticket is still on screen, just not kept.
  }
}

/** Which register's ticket this tab holds, and where it is kept. Tests pass their own storage. */
export function configureTillStore(options: {
  register?: string
  storage?: StorageLike | null
}): void {
  storage = options.storage === undefined ? sessionStore() : options.storage
  key = storageKey(options.register)
  state = read()
  emit()
}

/**
 * The first read decides whose ticket this tab holds: this browser's
 * register when it is registered as a till, "default" otherwise.
 */
function ensure(): TillState {
  if (state === null) {
    if (storage === null) storage = sessionStore()
    if (key === null) key = storageKey(getTillDevice()?.register)
    state = read()
  }
  return state
}

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTill(): TillState {
  return ensure()
}

export function dispatchTill(action: TillAction): void {
  const current = ensure()
  const next = tillReducer(current, action)
  if (next === current) return
  state = next
  write(next)
  emit()
}

/**
 * The sale's client id, minted on first use and kept with the ticket. The
 * same id goes on every attempt at the same sale, online, retried or queued.
 */
export function tillClientId(): string {
  const current = ensure()
  if (current.clientId) return current.clientId
  const id = newClientId()
  state = { ...current, clientId: id }
  write(state)
  return id
}

/** Re-renders whenever the till changes. */
export function useTill(): TillState {
  return React.useSyncExternalStore(subscribe, getTill, getTill)
}
