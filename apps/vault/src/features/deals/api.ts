/**
 * Every bit of data the Deals feature reads or writes goes through here
 * (docs/vault-rebuild-api.md, sections 1, 2, 7 and 8).
 *
 *  - Card search: GET /api/vault/lookup. Prices: GET /api/vault/cards/{id}/prices.
 *  - A deal is a `trade_ins` row (status draft) with `trade_in_lines`, made
 *    and edited through the collection API. Ids are made on the client
 *    (`newId`), so autosave only has to diff the draft against what it last
 *    saved. `customer` is optional on a draft (1789821520_vault_deal_drafts.js)
 *    and required on completion.
 *  - GET /api/vault/deals/{id} is the server pricing the stored deal with the
 *    same maths; it is checked against the screen before completing.
 *  - POST /api/vault/deals/{id}/complete books the items in. It runs every
 *    cash check the counter route does, ID on file included.
 *  - Sellers are `customers` (+ `customer_private` for address and ID);
 *    the ID photo goes to POST /api/vault/customers/{id}/id-check.
 *
 * Still open on the server: per-condition comps (the prices route returns
 * NM and a multiplier, so the other conditions are labelled estimated), and
 * the customer's live view, which needs a share-token route.
 */
import { ClientResponseError } from "pocketbase"
import type { FinalOverride } from "@gg/shared/deal"

import { pb } from "@/lib/pb"

import { conditionPrice, lineMarket, newDraft } from "./state"
import {
  CONDITIONS,
  type CardHit,
  type CompletionResult,
  type Condition,
  type ConditionPrices,
  type CustomCategory,
  type DealDraft,
  type DraftLine,
  type GameKey,
  type Seller,
} from "./types"

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/** A server or network error as one plain sentence that says what to do. */
export function explain(error: unknown, fallback = "That did not work. Try again."): string {
  if (error instanceof ClientResponseError) {
    if (error.isAbort) return "That was cancelled. Try again."
    if (error.status === 0) return "Could not reach the server. Check the connection and try again."
    if (error.status === 401) return "Your session has ended. Sign in again, then retry."
    if (error.status === 403) return "Your account cannot do that. Ask a manager."
    const message = String(error.response?.message ?? "").trim()
    // PocketBase's own field errors are terse; the hooks' messages are written for staff.
    if (message && !/^(failed to|something went wrong|the request requires)/i.test(message)) return message
    if (error.status === 404) return "That record is not on the server any more. Reload and try again."
    if (error.status === 400) return "The server refused those details. Check them and try again."
    return fallback
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function isNotFound(error: unknown): boolean {
  return error instanceof ClientResponseError && error.status === 404
}

const q = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

// ---------------------------------------------------------------------
// Card search and prices
// ---------------------------------------------------------------------

interface LookupRow {
  id?: string
  game?: string
  set_code?: string
  set_name?: string
  number?: string
  name?: string
  rarity?: string
  image_small?: string
  image_large?: string
  finishes_available?: string[]
}

function toHit(row: LookupRow, game: string): CardHit {
  return {
    id: String(row.id),
    game: row.game || game,
    name: row.name ?? "Unnamed card",
    setName: row.set_name ?? "",
    setCode: row.set_code ?? "",
    number: row.number ?? "",
    rarity: row.rarity ?? "",
    image: row.image_small || row.image_large || "",
    finishes: Array.isArray(row.finishes_available) ? row.finishes_available.filter(Boolean) : [],
  }
}

export async function searchCards(game: GameKey, query: string, signal?: AbortSignal): Promise<CardHit[]> {
  const text = query.trim()
  if (text.length < 2) return []
  const res = await pb.send<{ cards?: LookupRow[] }>("/api/vault/lookup", {
    method: "GET",
    query: { game, q: text },
    signal,
  })
  return (res.cards ?? []).filter((row) => row.id).map((row) => toHit(row, game))
}

interface CardRecord {
  id: string
  game: string
  name: string
  number: string
  rarity?: string
  image_small?: string
  image_large?: string
  finishes_available?: string[] | null
  expand?: { set?: { name?: string; code?: string } }
}

/** One card by its `cards` id, for a card added from Scan (?add=). */
export async function getCard(id: string): Promise<CardHit | null> {
  try {
    const card = await pb.collection("cards").getOne<CardRecord>(id, { expand: "set" })
    return {
      id: card.id,
      game: card.game,
      name: card.name,
      setName: card.expand?.set?.name ?? "",
      setCode: card.expand?.set?.code ?? "",
      number: card.number,
      rarity: card.rarity ?? "",
      image: card.image_small || card.image_large || "",
      finishes: Array.isArray(card.finishes_available) ? card.finishes_available.filter(Boolean) : [],
    }
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

interface PriceRow {
  source?: string
  gbp_market?: number | null
}

interface PricesResponse {
  chosen?: PriceRow | null
  condition_adjusted?: number | null
  /** Not served yet: each condition's own comp, when the server has one. */
  conditions?: Partial<Record<string, { gbp_market?: number | null; source?: string } | null>>
}

function pence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

async function pricesFor(cardId: string, finish: string, condition: string): Promise<PricesResponse> {
  return pb.send<PricesResponse>(`/api/vault/cards/${encodeURIComponent(cardId)}/prices`, {
    method: "GET",
    query: { finish, condition },
  })
}

/** Each condition's market value per unit for a card and finish. */
export async function getConditionPrices(cardId: string, finish: string): Promise<ConditionPrices> {
  const nm = await pricesFor(cardId, finish, "NM")
  const out: ConditionPrices = {}

  if (nm.conditions) {
    for (const condition of CONDITIONS) {
      const row = nm.conditions[condition]
      const value = pence(row?.gbp_market)
      if (value !== null) out[condition] = { pence: value, basis: "comp", source: row?.source }
    }
    if (out.NM) return out
  }

  const nmPence = pence(nm.condition_adjusted) ?? pence(nm.chosen?.gbp_market)
  out.NM = { pence: nmPence, basis: "comp", source: nm.chosen?.source }
  if (nmPence === null) return out

  const rest = CONDITIONS.filter((c) => c !== "NM")
  const results = await Promise.allSettled(rest.map((c) => pricesFor(cardId, finish, c)))
  results.forEach((result, i) => {
    const condition = rest[i]!
    if (out[condition]) return
    const value = result.status === "fulfilled" ? pence(result.value.condition_adjusted) : null
    out[condition] = { pence: value, basis: "estimated", source: nm.chosen?.source }
  })
  return out
}

// ---------------------------------------------------------------------
// Games: line rows need a `games` record id
// ---------------------------------------------------------------------

let gameIds: Promise<Map<string, string>> | null = null

/** Game key to `games` id. `games` is public reference data, read once. */
export function loadGameIds(): Promise<Map<string, string>> {
  if (!gameIds) {
    gameIds = pb
      .collection("games")
      .getFullList<{ id: string; key: string }>({ fields: "id,key" })
      .then((rows) => new Map(rows.map((row) => [row.key, row.id])))
      .catch((error) => {
        gameIds = null
        throw error
      })
  }
  return gameIds
}

/** For tests. */
export function resetGameCache() {
  gameIds = null
}

async function gameId(game: string): Promise<string> {
  const ids = await loadGameIds()
  return ids.get(game) ?? game
}

async function gameKey(id: string): Promise<string> {
  const ids = await loadGameIds()
  for (const [key, value] of ids) if (value === id) return key
  return "other"
}

// ---------------------------------------------------------------------
// Deals: trade_ins + trade_in_lines
// ---------------------------------------------------------------------

type OverrideKind = "" | "amount" | "pct"

interface TradeInRow {
  id: string
  status: "draft" | "offered" | "accepted" | "completed" | "declined" | "cancelled"
  number?: string
  customer?: string
  deal_name?: string
  deal_note?: string
  trade_pct?: number
  cash_pct?: number
  trade_override_kind?: OverrideKind
  trade_override_pence?: number
  trade_override_pct?: number
  cash_override_kind?: OverrideKind
  cash_override_pence?: number
  cash_override_pct?: number
  payout_type?: "" | "cash" | "credit" | "mixed" | "part_exchange"
  payout_cash?: number
  payout_credit?: number
  calculated_trade?: number
  calculated_cash?: number
  deal_trade_total?: number
  deal_cash_total?: number
  total_market?: number
  completed_at?: string
  created: string
  updated: string
  expand?: { customer?: CustomerRow }
}

interface LineRow {
  id: string
  trade_in: string
  card?: string
  kind?: "single" | "graded" | "retro" | "sealed" | "accessory" | "other" | ""
  game?: string
  finish?: string
  condition?: Condition | ""
  qty?: number
  market_price?: number
  market_source?: string
  free_text_title?: string
  trade_pct?: number | null
  cash_pct?: number | null
  created: string
  expand?: { card?: CardRecord }
}

interface CustomerRow {
  id: string
  name?: string
  code?: string
  phone?: string
  email?: string
}

function overrideFields(side: "trade" | "cash", override: FinalOverride | null | undefined) {
  if (!override) return { [`${side}_override_kind`]: "", [`${side}_override_pence`]: 0, [`${side}_override_pct`]: 0 }
  if (override.kind === "amount") {
    return { [`${side}_override_kind`]: "amount", [`${side}_override_pence`]: override.pence, [`${side}_override_pct`]: 0 }
  }
  return { [`${side}_override_kind`]: "pct", [`${side}_override_pence`]: 0, [`${side}_override_pct`]: override.pct }
}

function overrideFrom(kind: OverrideKind | undefined, amount = 0, pct = 0): FinalOverride | null {
  if (kind === "amount") return { kind: "amount", pence: amount }
  if (kind === "pct") return { kind: "pct", pct }
  return null
}

/** The `trade_ins` fields a draft writes. */
export function dealBody(draft: DealDraft): Record<string, unknown> {
  return {
    deal_name: draft.name.trim() || "Untitled deal",
    deal_note: draft.note,
    customer: draft.seller?.id ?? "",
    trade_pct: draft.rates.tradePct,
    cash_pct: draft.rates.cashPct,
    ...overrideFields("trade", draft.overrides.trade),
    ...overrideFields("cash", draft.overrides.cash),
  }
}

const customKinds: Record<CustomCategory, "retro" | "sealed" | "other"> = {
  retro: "retro",
  sealed: "sealed",
  comic: "other",
  other: "other",
}

/** The `trade_in_lines` fields a line writes (game still as given; resolved on save). */
export function lineBody(line: DraftLine, dealId: string): Record<string, unknown> {
  const common = {
    trade_in: dealId,
    qty: line.qty,
    market_price: lineMarket(line),
    market_currency: "GBP",
    accepted: true,
    trade_pct: line.tradePct ?? null,
    cash_pct: line.cashPct ?? null,
  }
  if (line.kind === "card") {
    const fromComp = conditionPrice(line) !== null
    return {
      ...common,
      kind: "single",
      card: line.cardId,
      game: line.game,
      finish: line.variant,
      condition: line.condition,
      market_source: fromComp ? (line.prices[line.condition]?.source ?? "") : "staff_entered",
    }
  }
  return {
    ...common,
    kind: customKinds[line.category],
    game: line.game,
    free_text_title: line.name,
    market_source: "staff_entered",
  }
}

async function withGameId(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...body, game: await gameId(String(body.game ?? "")) }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Writes what changed between the last saved draft and this one: the deal
 * row, then each new, changed or removed line. `previous` null creates it.
 */
export async function saveDeal(previous: DealDraft | null, next: DealDraft): Promise<void> {
  const deals = pb.collection("trade_ins")
  const lines = pb.collection("trade_in_lines")
  const body = dealBody(next)

  if (!previous) {
    await deals.create({ id: next.id, status: "draft", channel: "counter", ...body })
  } else if (!same(dealBody(previous), body)) {
    await deals.update(next.id, body)
  }

  const before = new Map((previous?.lines ?? []).map((line) => [line.id, lineBody(line, next.id)]))
  // Oldest first, so the server's created order matches the screen's.
  for (const line of [...next.lines].reverse()) {
    const lineData = lineBody(line, next.id)
    const old = before.get(line.id)
    if (!old) await lines.create({ id: line.id, ...(await withGameId(lineData)) })
    else if (!same(old, lineData)) await lines.update(line.id, await withGameId(lineData))
    before.delete(line.id)
  }
  for (const id of before.keys()) {
    try {
      await lines.delete(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

/** A new draft on the server. */
export async function createDeal(): Promise<DealDraft> {
  const draft = newDraft()
  await saveDeal(null, draft)
  return draft
}

export async function deleteDeal(id: string): Promise<void> {
  try {
    await pb.collection("trade_ins").delete(id)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

function toSeller(row: CustomerRow | undefined): Seller | null {
  if (!row?.id) return null
  return { id: row.id, name: row.name ?? "", code: row.code ?? "", phone: row.phone ?? "", email: row.email ?? "" }
}

async function toLine(row: LineRow): Promise<DraftLine> {
  const own = {
    tradePct: typeof row.trade_pct === "number" ? row.trade_pct : undefined,
    cashPct: typeof row.cash_pct === "number" ? row.cash_pct : undefined,
  }
  const rates = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined))
  if (row.card) {
    const card = row.expand?.card
    return {
      id: row.id,
      kind: "card",
      cardId: row.card,
      game: row.game || card?.game || "",
      name: card?.name ?? row.free_text_title ?? "Card",
      setName: card?.expand?.set?.name ?? "",
      setCode: card?.expand?.set?.code ?? "",
      number: card?.number ?? "",
      image: card?.image_small || card?.image_large || "",
      variant: row.finish ?? "",
      condition: (row.condition || "NM") as Condition,
      prices: {},
      // Fresh prices load when the builder opens; the stored value holds until then.
      // A card stored at 0 was never priced, so it comes back unpriced, not "typed £0.00".
      priceStatus: "loading",
      manualMarket: row.market_price && row.market_price > 0 ? row.market_price : null,
      qty: Math.max(1, row.qty ?? 1),
      ...rates,
    }
  }
  const key = row.game ? await gameKey(row.game) : "other"
  const category: CustomCategory = row.kind === "retro" ? "retro" : row.kind === "sealed" ? "sealed" : "other"
  return {
    id: row.id,
    kind: "custom",
    name: row.free_text_title ?? "Item",
    category,
    game: key,
    manualMarket: row.market_price ?? 0,
    qty: Math.max(1, row.qty ?? 1),
    ...rates,
  }
}

function toDraft(row: TradeInRow, lines: DraftLine[]): DealDraft {
  const base = newDraft(row.id)
  const completed = row.status === "completed"
  return {
    ...base,
    name: row.deal_name || (row.number ? `Buy-in ${row.number}` : "Untitled deal"),
    status: completed ? "completed" : "open",
    createdAt: row.created,
    updatedAt: row.updated,
    rates: { tradePct: row.trade_pct || 80, cashPct: row.cash_pct || 70 },
    overrides: {
      trade: overrideFrom(row.trade_override_kind, row.trade_override_pence, row.trade_override_pct),
      cash: overrideFrom(row.cash_override_kind, row.cash_override_pence, row.cash_override_pct),
    },
    note: row.deal_note ?? "",
    seller: toSeller(row.expand?.customer),
    lines,
    completed: completed
      ? {
          at: row.completed_at || row.updated,
          number: row.number ?? "",
          payout: {
            type: row.payout_type === "cash" || row.payout_type === "mixed" ? row.payout_type : "credit",
            cash: row.payout_cash ?? 0,
            credit: row.payout_credit ?? 0,
          },
          market: row.total_market ?? 0,
          trade: row.deal_trade_total ?? 0,
          cash: row.deal_cash_total ?? 0,
          calculatedTrade: row.calculated_trade ?? 0,
          calculatedCash: row.calculated_cash ?? 0,
          tradeOverridden: Boolean(row.trade_override_kind),
          cashOverridden: Boolean(row.cash_override_kind),
        }
      : null,
  }
}

const LINE_FIELDS_EXPAND = "card,card.set"

export async function getDeal(id: string): Promise<DealDraft | null> {
  let row: TradeInRow
  try {
    row = await pb.collection("trade_ins").getOne<TradeInRow>(id, { expand: "customer" })
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  const lineRows = await pb.collection("trade_in_lines").getFullList<LineRow>({
    filter: `trade_in = "${q(id)}"`,
    sort: "-created",
    expand: LINE_FIELDS_EXPAND,
  })
  return toDraft(row, await Promise.all(lineRows.map(toLine)))
}

/** Vault deals (those with a name), newest change first, with their lines for the totals. */
export async function listDeals(): Promise<DealDraft[]> {
  const page = await pb.collection("trade_ins").getList<TradeInRow>(1, 60, {
    filter: `deal_name != ""`,
    sort: "-updated",
    expand: "customer",
  })
  if (page.items.length === 0) return []
  const filter = page.items.map((row) => `trade_in = "${q(row.id)}"`).join(" || ")
  const lineRows = await pb.collection("trade_in_lines").getFullList<LineRow>({ filter, sort: "-created" })
  const byDeal = new Map<string, LineRow[]>()
  for (const line of lineRows) byDeal.set(line.trade_in, [...(byDeal.get(line.trade_in) ?? []), line])
  return Promise.all(
    page.items.map(async (row) => toDraft(row, await Promise.all((byDeal.get(row.id) ?? []).map(toLine))))
  )
}

export interface ServerDeal {
  trade_total: number
  cash_total: number
  market_total: number
  lines: Array<{ id: string }>
}

/** The deal as the server prices it from what is stored. */
export async function getServerDeal(id: string): Promise<ServerDeal> {
  const res = await pb.send<{ deal: ServerDeal }>(`/api/vault/deals/${encodeURIComponent(id)}`, { method: "GET" })
  return res.deal
}

// ---------------------------------------------------------------------
// Sellers and the ID check
// ---------------------------------------------------------------------

export async function searchSellers(query: string, signal?: AbortSignal): Promise<Seller[]> {
  const raw = query.trim()
  if (raw.length < 2) return []
  const needle = q(raw)
  const digits = raw.replace(/[^\d]/g, "")
  const clauses = [`name ~ "${needle}"`, `email ~ "${needle}"`, `code ~ "${q(raw.toUpperCase())}"`]
  if (digits.length >= 4) clauses.push(`phone ~ "${q(digits)}"`)
  if (raw !== digits) clauses.push(`phone ~ "${needle}"`)
  const page = await pb.collection("customers").getList<CustomerRow>(1, 20, {
    filter: clauses.join(" || "),
    sort: "name",
    signal,
  })
  return page.items.map((row) => toSeller(row)!).filter(Boolean)
}

export interface NewSeller {
  name: string
  phone: string
  email: string
  address: string
}

interface PrivateRow {
  id: string
  address?: string
  dob?: string
  flags?: string[] | null
  id_status?: string
  id_expiry?: string
}

async function privateRow(customerId: string): Promise<PrivateRow | null> {
  try {
    return await pb
      .collection("customer_private")
      .getFirstListItem<PrivateRow>(`customer = "${q(customerId)}"`)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** A new customer. The server assigns the code and makes the private row; the address goes there. */
export async function createSeller(input: NewSeller): Promise<Seller> {
  const row = await pb.collection("customers").create<CustomerRow>({
    name: input.name.trim(),
    phone: input.phone.trim() || undefined,
    email: input.email.trim() || undefined,
    source: "counter",
  })
  const address = input.address.trim()
  if (address) {
    const priv = await privateRow(row.id)
    if (priv) await pb.collection("customer_private").update(priv.id, { address })
  }
  return toSeller(row)!
}

/** What decides whether cash can be paid to this seller today. */
export interface SellerFacts {
  idStatus: string
  idExpiry: string
  dob: string
  address: string
  flags: string[]
  /** An ID photo the retention cron has not purged. */
  hasPhoto: boolean
}

export async function getSellerFacts(customerId: string): Promise<SellerFacts> {
  const [priv, doc] = await Promise.all([
    privateRow(customerId),
    pb.send<{ document: { id: string } | null }>(
      `/api/vault/customers/${encodeURIComponent(customerId)}/id-document`,
      { method: "GET" }
    ),
  ])
  return {
    idStatus: priv?.id_status ?? "none",
    idExpiry: priv?.id_expiry ?? "",
    dob: priv?.dob ?? "",
    address: priv?.address ?? "",
    flags: Array.isArray(priv?.flags) ? priv.flags : [],
    hasPhoto: Boolean(doc.document),
  }
}

export interface IdCheckResult {
  id_document: string
  id_status: string
  id_expiry: string
}

/** Stores the ID photo and fields (multipart: photo, id_type, id_expiry, id_ref_last4, dob, address). */
export async function submitIdCheck(customerId: string, form: FormData): Promise<IdCheckResult> {
  return pb.send<IdCheckResult>(`/api/vault/customers/${encodeURIComponent(customerId)}/id-check`, {
    method: "POST",
    body: form,
  })
}

export interface IdCheckPayload {
  id_type?: string
  id_expiry?: string
  id_ref_last4?: string
  dob?: string
  address?: string
  id_document?: string | null
}

export interface CompleteBody {
  cash_taken: number
  credit_given: number
  terms_accepted: boolean
  signature?: string
  id_check?: IdCheckPayload | null
}

interface CompleteResponse {
  trade_in: {
    id: string
    number: string
    payout_type: "cash" | "credit" | "mixed"
    cash_taken: number
    credit_given: number
  }
  items?: Array<{ id: string; sku: string; title: string }>
  labels_queued?: number
}

export async function completeDeal(id: string, body: CompleteBody): Promise<CompletionResult> {
  const res = await pb.send<CompleteResponse>(`/api/vault/deals/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body,
  })
  return {
    tradeIn: {
      id: res.trade_in.id,
      number: res.trade_in.number,
      payoutType: res.trade_in.payout_type,
      cashTaken: res.trade_in.cash_taken,
      creditGiven: res.trade_in.credit_given,
    },
    items: res.items ?? [],
    labelsQueued: res.labels_queued ?? 0,
  }
}

/** The live customer view. Not available until the server can share a deal safely. */
export const customerViewAvailable = false

export interface EposCreditStatus {
  status: "none" | "pending" | "sending" | "done" | "failed" | "needs_check"
  synced: boolean
  amount: number
  message: string
}

/** Where a completed deal's trade credit is in the sync to Epos Now. */
export async function getEposCredit(id: string): Promise<EposCreditStatus> {
  const res = await pb.send<{ epos_credit: EposCreditStatus }>(
    `/api/vault/deals/${encodeURIComponent(id)}/epos-credit`,
    { method: "GET" },
  )
  return res.epos_credit
}
