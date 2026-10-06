/**
 * Epos Now, read and written as plain data.
 *
 * The shop's till has been Epos Now since October 2026. GG Vault links its
 * own customers to Epos Now customers (the card number on the Epos Now side
 * is the customer's GGC code, so scanning the My Vault barcode at the till
 * attaches them) and activates a GG Guild membership when the till sells the
 * Guild product to a linked customer.
 *
 * Everything here is pure, so the hooks (through the CommonJS copy in
 * `pb/pb_hooks/lib/shared/`) and the Vitest suite read a transaction the same
 * way. Nothing here talks to the network.
 *
 * Two shapes reach us: the v4 REST API answers in camelCase (`customerId`,
 * `transactionItems`, `productId`), and a webhook may carry the older
 * PascalCase names (`CustomerID`, `TransactionItems`, `ProductID`). Every
 * key is therefore read case-insensitively and without underscores, so
 * either spelling lands in the same field.
 *
 * Amounts arrive as decimal pounds and leave as integer pence, through
 * `decimalPoundsToPence`. Timestamps carry no zone and are read as UTC.
 */
import { decimalPoundsToPence } from "./money"

/** Epos Now's status for a completed sale (`TransactionStatus` 1). */
export const EPOS_STATUS_COMPLETE = 1

/** Epos Now's own field limits for a customer (v4 `CustomerCreateRequest`). */
const NAME_MAX = 50
const EMAIL_MAX = 50
const CARD_MAX = 50

export interface EposLine {
  productId: string
  quantity: number
  /** Integer GBP pence, per unit. */
  unitPence: number
  /** Integer GBP pence taken off the whole line, 0 when none. */
  discountPence: number
  /** `unitPence * quantity - discountPence`, never below 0. */
  amountPence: number
}

export interface EposTransaction {
  id: string
  /** The Epos Now customer id, or "" when nobody was attached at the till. */
  customerId: string
  /** ISO 8601 in UTC, or null when the payload carried no readable time. */
  soldAt: string | null
  /** null when the payload did not say (a webhook for a completed sale). */
  statusId: number | null
  lines: EposLine[]
}

type Dict = Record<string, unknown>

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function squash(key: string): string {
  return key.replace(/_/g, "").toLowerCase()
}

/** The first of `names` present on `obj`, matched without case or underscores. */
function pick(obj: unknown, ...names: string[]): unknown {
  if (!isDict(obj)) return undefined
  const wanted = names.map(squash)
  for (const key of Object.keys(obj)) {
    if (wanted.includes(squash(key))) {
      const value = obj[key]
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** An id as a string: Epos Now ids are integers, ours are compared as text. */
function idText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value))
  if (typeof value === "string") return value.trim()
  return ""
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n)) return null
  return Math.trunc(n)
}

/**
 * An Epos Now timestamp as ISO 8601 UTC. Epos Now writes them without a
 * zone (`2026-10-06T14:30:00` or with a space); those are read as UTC, as
 * agreed for this integration. One that does carry a zone keeps it.
 */
export function eposTimestampToIso(value: unknown): string | null {
  if (typeof value !== "string") return null
  let text = value.trim()
  if (!text) return null
  text = text.replace(" ", "T")
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text)
  if (!hasZone && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text)) {
    text = text.includes("T") ? `${text}Z` : `${text}T00:00:00Z`
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString()
}

function readLine(raw: unknown): EposLine | null {
  if (!isDict(raw)) return null
  const productId = idText(pick(raw, "productId", "product_id"))
  if (!productId) return null
  const quantity = wholeNumber(pick(raw, "quantity", "qty")) ?? 1
  const unitPence = decimalPoundsToPence(pick(raw, "unitPrice", "price")) ?? 0
  const discountPence = decimalPoundsToPence(pick(raw, "discountAmount", "discount")) ?? 0
  const amountPence = Math.max(0, unitPence * quantity - Math.max(0, discountPence))
  return { productId, quantity, unitPence, discountPence, amountPence }
}

/**
 * One transaction in either spelling, or null when it has no id (nothing
 * idempotent can be done with a sale that cannot be named).
 */
export function readEposTransaction(raw: unknown): EposTransaction | null {
  if (!isDict(raw)) return null
  const id = idText(pick(raw, "id", "transactionId"))
  if (!id) return null
  const itemsRaw = pick(raw, "transactionItems", "items")
  const lines: EposLine[] = []
  if (Array.isArray(itemsRaw)) {
    for (const item of itemsRaw) {
      const line = readLine(item)
      if (line) lines.push(line)
    }
  }
  const customerRaw = idText(pick(raw, "customerId"))
  return {
    id,
    // 0 is what some Epos Now payloads send for "no customer".
    customerId: customerRaw === "0" ? "" : customerRaw,
    soldAt: eposTimestampToIso(pick(raw, "dateTime", "date", "transactionDate")),
    statusId: wholeNumber(pick(raw, "statusId", "status")),
    lines,
  }
}

/**
 * Every transaction in a payload: a bare array (the v4 list routes), a
 * single transaction (a webhook), or either of those inside a wrapper
 * object (`{ Data: ... }`, `{ Transaction: ... }`, `{ Transactions: [...] }`).
 */
export function eposTransactionsFrom(payload: unknown): EposTransaction[] {
  if (Array.isArray(payload)) {
    const out: EposTransaction[] = []
    for (const entry of payload) {
      const tx = readEposTransaction(entry)
      if (tx) out.push(tx)
    }
    return out
  }
  if (!isDict(payload)) return []
  const direct = readEposTransaction(payload)
  if (direct && (direct.lines.length > 0 || pick(payload, "transactionItems") !== undefined)) {
    return [direct]
  }
  const wrapped = pick(payload, "data", "transaction", "transactions", "payload", "object")
  if (wrapped !== undefined) return eposTransactionsFrom(wrapped)
  return direct ? [direct] : []
}

/** Product ids as the strings `EposLine.productId` carries. */
export function normaliseProductIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  for (const id of ids) {
    const text = idText(id)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * `settings.eposnow.guild_products`, `{ "<Epos Now product id>": "<loyalty_tiers id>" }`,
 * with blank keys and values dropped. The product decides the tier: a
 * customer who asked for one plan online and paid at the till for another
 * gets the one they paid for.
 */
export function normaliseProductTiers(map: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isDict(map)) return out
  for (const key of Object.keys(map)) {
    const product = idText(key)
    const tier = typeof map[key] === "string" ? (map[key] as string).trim() : ""
    if (product && tier) out[product] = tier
  }
  return out
}

/** The most Guild memberships one sale may start; above it a person checks. */
export const MAX_GUILD_QUANTITY = 2

export type GuildSaleKind =
  /** A plain sale: one tier, a positive price, 1 or 2 units. */
  | "sale"
  /** A Guild line with a negative quantity or amount: a refund at the till. */
  | "refund"
  /** A Guild line at no price, or of no quantity: nothing to activate. */
  | "unpriced"
  /** Lines for more than one paid plan in one sale. */
  | "mixed"
  /** More than `MAX_GUILD_QUANTITY` units. */
  | "too_many"

export interface GuildSaleResult {
  kind: GuildSaleKind
  /** The tier the product maps to (the first one seen, for `mixed`). */
  tierId: string
  quantity: number
  /** What the Guild lines came to, integer GBP pence (never below 0). */
  amountPence: number
}

/**
 * What a transaction's Guild product lines amount to, or null when it has
 * none. Only `kind: "sale"` may ever start or extend a membership; every
 * other kind is for a person to look at.
 */
export function guildSaleIn(tx: EposTransaction, productTiers: unknown): GuildSaleResult | null {
  const map = normaliseProductTiers(productTiers)
  const lines = tx.lines.filter((line) => map[line.productId] !== undefined)
  if (lines.length === 0) return null

  const tiers: string[] = []
  let quantity = 0
  let amountPence = 0
  let refund = false
  let unpriced = false
  for (const line of lines) {
    const tierId = map[line.productId] as string
    if (!tiers.includes(tierId)) tiers.push(tierId)
    if (line.quantity < 0 || line.unitPence < 0) {
      refund = true
      continue
    }
    if (line.quantity === 0 || line.unitPence === 0) {
      unpriced = true
      continue
    }
    quantity += line.quantity
    amountPence += line.amountPence
  }
  const tierId = tiers[0] ?? ""
  let kind: GuildSaleKind = "sale"
  if (refund) kind = "refund"
  else if (unpriced || quantity === 0) kind = "unpriced"
  else if (tiers.length > 1) kind = "mixed"
  else if (quantity > MAX_GUILD_QUANTITY) kind = "too_many"
  return { kind, tierId, quantity, amountPence }
}

/**
 * A completed sale, and nothing else. Fails closed: a transaction whose
 * status is missing or not one Epos Now uses for "complete" (`statusId` 1 on
 * `GET v4/Transaction/{id}` and the `GetByDate` list) is never acted on.
 */
export function isCompletedSale(tx: EposTransaction): boolean {
  return tx.statusId === EPOS_STATUS_COMPLETE
}

/** "Sam de la Cruz" as `{ forename: "Sam", surname: "de la Cruz" }`, within Epos Now's limits. */
export function splitName(name: string): { forename: string; surname: string } {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean)
  const forename = (parts.shift() || "Customer").slice(0, NAME_MAX)
  const surname = parts.join(" ").slice(0, NAME_MAX)
  return { forename, surname }
}

export interface EposCustomerInput {
  name: string
  email: string
  /** The bare GGC code, `GGC7F3K2Q`: what the till reads off the barcode. */
  code: string
  marketingConsent: boolean
  locationId?: number | null
  /** ISO 8601. */
  signUpDate?: string
}

/**
 * The body for `POST v4/Customer`, which takes an array. Only the fields
 * GG Vault means to share: the name, the email address, the card number
 * (the customer code) and the email marketing choice. No phone number,
 * address or date of birth leaves GG Vault.
 */
export function eposCustomerBody(input: EposCustomerInput): Dict[] {
  const { forename, surname } = splitName(input.name)
  const email = String(input.email || "").trim()
  const body: Dict = {
    forename,
    cardNumber: String(input.code || "").slice(0, CARD_MAX),
    marketingConsent: { email: Boolean(input.marketingConsent), text: false, phone: false, mail: false },
  }
  if (surname) body.surname = surname
  if (email && email.length <= EMAIL_MAX) body.emailAddress = email
  if (input.locationId) body.signUpLocationId = input.locationId
  if (input.signUpDate) body.signUpDate = input.signUpDate
  return [body]
}

/** The Epos Now customer id out of a create or lookup answer, or "". */
export function eposCustomerIdFrom(payload: unknown): string {
  const first = Array.isArray(payload) ? payload[0] : payload
  return idText(pick(first, "id", "customerId"))
}

/** The card number on an Epos Now customer record, or "". */
export function eposCardNumberOf(payload: unknown): string {
  const first = Array.isArray(payload) ? payload[0] : payload
  const value = pick(first, "cardNumber")
  return typeof value === "string" ? value.trim() : ""
}
