/**
 * Every bit of data the Deals feature reads or writes goes through here, so
 * it can be rewired to the server in one place.
 *
 * What is live today (this branch's pb_hooks):
 *  - Card search: GET /api/vault/lookup?game=&q= (lookup.pb.js).
 *  - Prices: GET /api/vault/cards/{id}/prices?finish=&condition= (prices.pb.js).
 *
 * What is local, waiting on the backend (feat/vault-api,
 * docs/vault-rebuild-api.md "Deals"):
 *  - Drafts are kept in this browser's localStorage. `trade_ins` needs a
 *    customer and a number before it can be created, has no field for the
 *    sweep rates, per-line rates or the final override on this branch, and
 *    no JSON field to park them in.
 *    TODO(vault-api): once 1789821460_vault_deal.js lands, save a draft as a
 *    `trade_ins` row (trade_pct, cash_pct, override_kind/_total/_percent)
 *    with `trade_in_lines` (market_price, condition, qty, trade_pct and
 *    cash_pct as null or a percent), and read it back with
 *    GET /api/vault/deals/{id}.
 *  - Completion. TODO(vault-api): POST /api/vault/deals/{id}/complete with
 *    { cash_taken, credit_given, terms_accepted, id_check, signature }. That
 *    route enforces ID on file for any cash. Until it is wired, `completeDeal`
 *    refuses any payout with cash in it rather than skip the check.
 *  - Per-condition prices. TODO(vault-api): the prices route returns one
 *    chosen price and `condition_adjusted` (NM x the shop's condition
 *    multiplier). When it returns each condition's own comp, read
 *    `conditions` below and drop the five calls. Until then only NM is a comp
 *    and the other conditions are labelled "estimated" on screen.
 *  - The customer's live view. TODO(vault-api): needs a share token route
 *    (create, revoke, and a read-only fetch scoped to one deal). No public
 *    endpoint is invented here.
 */
import { pb } from "@/lib/pb"

import { CONDITIONS, type CardHit, type ConditionPrices, type DealDraft, type GameKey } from "./types"

// ---------------------------------------------------------------------
// Card search and prices (live)
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

export async function searchCards(game: GameKey, query: string, signal?: AbortSignal): Promise<CardHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const res = await pb.send<{ cards?: LookupRow[] }>("/api/vault/lookup", {
    method: "GET",
    query: { game, q },
    signal,
  })
  return (res.cards ?? [])
    .filter((row) => row.id)
    .map((row) => ({
      id: String(row.id),
      game: row.game || game,
      name: row.name ?? "Unnamed card",
      setName: row.set_name ?? "",
      setCode: row.set_code ?? "",
      number: row.number ?? "",
      rarity: row.rarity ?? "",
      image: row.image_small || row.image_large || "",
      finishes: Array.isArray(row.finishes_available) ? row.finishes_available.filter(Boolean) : [],
    }))
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
// Drafts (local until the backend lands)
// ---------------------------------------------------------------------

const STORE_KEY = "gg-vault-deals-v1"

function readStore(): Record<string, DealDraft> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, DealDraft>) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, DealDraft>) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store))
}

/** Every deal, most recently updated first. */
export async function listDeals(): Promise<DealDraft[]> {
  return Object.values(readStore()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getDeal(id: string): Promise<DealDraft | null> {
  return readStore()[id] ?? null
}

/** Saves a draft and returns it with its new `updatedAt`. */
export async function saveDeal(draft: DealDraft, now: Date = new Date()): Promise<DealDraft> {
  const store = readStore()
  const saved = { ...draft, updatedAt: now.toISOString() }
  store[draft.id] = saved
  writeStore(store)
  return saved
}

export async function deleteDeal(id: string): Promise<void> {
  const store = readStore()
  delete store[id]
  writeStore(store)
}

export class CompletionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompletionError"
  }
}

/**
 * Records a completed deal. Cash of any amount needs ID on file, which only
 * the server can check, so a payout with cash in it is refused here until
 * POST /api/vault/deals/{id}/complete is wired.
 */
export async function completeDeal(completed: DealDraft): Promise<DealDraft> {
  if (!completed.completed) throw new CompletionError("Price the deal before completing it.")
  if (completed.completed.payout.cash > 0) {
    throw new CompletionError(
      "Cash needs the seller's ID on file, checked by the server. Pay this one as trade credit, or complete it on the counter."
    )
  }
  return saveDeal(completed)
}

/** The live customer view. Not available until the server can share a deal safely. */
export const customerViewAvailable = false
