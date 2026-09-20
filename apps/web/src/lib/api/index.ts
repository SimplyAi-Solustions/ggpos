/**
 * Every read and write in GG Vault goes through this module, so a screen never
 * imports the PocketBase client directly and demo mode is one branch per call
 * rather than a fork of the app.
 *
 * The record shapes come from `./types`, which is a hand-written mirror of
 * pb/pb_migrations/. Swap those interfaces for the generated
 * `packages/shared/src/pb-types.ts` once `pnpm typegen` has run against a
 * built database; the call signatures here do not change.
 */
import { ClientResponseError } from "pocketbase"
import { generateCode } from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import {
  DEMO_CARDS,
  DEMO_GAMES,
  DEMO_ITEMS,
  DEMO_LOCATIONS,
  DEMO_STAFF,
} from "@/lib/api/fixtures"
import { cardMatches, parseCardQuery, numberMatches } from "@/lib/api/query"
import type {
  CardHit,
  CardRecord,
  CardSetRecord,
  GameRecord,
  ItemRecord,
  LabelJobRecord,
  LocationRecord,
  NewItemInput,
  StaffRecord,
} from "@/lib/api/types"

export * from "@/lib/api/types"
export { isDemo, isServerUnreachable, resolveDataMode, setDataMode } from "@/lib/api/mode"
export { parseCardQuery } from "@/lib/api/query"
export { DEMO_STAFF, DEMO_SCAN_SKU } from "@/lib/api/fixtures"

/** Items created during a demo session, newest first. Never persisted. */
const demoItems: ItemRecord[] = [...DEMO_ITEMS]

function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

type ExpandedCard = CardRecord & {
  expand?: { set?: CardSetRecord; game?: GameRecord }
}

function toHit(record: ExpandedCard, games: GameRecord[]): CardHit {
  const set = record.expand?.set
  const game = record.expand?.game ?? games.find((g) => g.id === record.game)
  return {
    id: record.id,
    name: record.name,
    number: record.number,
    gameKey: game?.key ?? "",
    gameId: record.game,
    setCode: set?.code ?? "",
    setName: set?.name ?? "",
    image: record.image_small || record.image_large || undefined,
    rarity: record.rarity,
    finishes: Array.isArray(record.finishes_available)
      ? record.finishes_available
      : [],
    // Phase 2 joins price_snapshots and fills this in.
    marketPence: null,
  }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export async function listGames(): Promise<GameRecord[]> {
  if (isDemo()) return DEMO_GAMES.filter((game) => game.enabled)
  return pb
    .collection("games")
    .getFullList<GameRecord>({ filter: "enabled = true", sort: "name" })
}

export async function listLocations(): Promise<LocationRecord[]> {
  if (isDemo()) return DEMO_LOCATIONS
  return pb.collection("locations").getFullList<LocationRecord>({ sort: "sort,name" })
}

export interface SearchCardsOptions {
  /** Narrow to one game by its `key`, for example "pokemon". */
  gameKey?: string
  limit?: number
}

/**
 * One search box for "sv151 199", "charizard" or "199". Returns at most
 * `limit` hits, ordered by name so the list does not jump about as it filters.
 */
export async function searchCards(
  raw: string,
  options: SearchCardsOptions = {}
): Promise<CardHit[]> {
  const limit = options.limit ?? 8
  const query = parseCardQuery(raw)
  if (!query.setCode && !query.number && !query.text) return []

  if (isDemo()) {
    return DEMO_CARDS.filter((card) => cardMatches(card, query, options.gameKey)).slice(
      0,
      limit
    )
  }

  const clauses: string[] = []
  if (query.setCode) clauses.push(`set.code ~ "${escapeFilter(query.setCode)}"`)
  if (query.number) clauses.push(`number ~ "${escapeFilter(query.number)}"`)
  if (query.text) {
    const text = escapeFilter(query.text)
    clauses.push(`(name ~ "${text}" || search_text ~ "${text}")`)
  }
  if (options.gameKey) clauses.push(`game.key = "${escapeFilter(options.gameKey)}"`)

  const page = await pb.collection("cards").getList<ExpandedCard>(1, limit, {
    filter: clauses.join(" && "),
    expand: "set,game",
    sort: "name",
  })
  const games = await listGames()
  return page.items.map((item) => toHit(item, games))
}

/** The exact card behind a set code and a collector number, or null. */
export async function getCardBySetNumber(
  setCode: string,
  number: string
): Promise<CardHit | null> {
  if (isDemo()) {
    return (
      DEMO_CARDS.find(
        (card) =>
          card.setCode.toLowerCase() === setCode.toLowerCase() &&
          numberMatches(card.number, number)
      ) ?? null
    )
  }
  try {
    const record = await pb
      .collection("cards")
      .getFirstListItem<ExpandedCard>(
        `set.code = "${escapeFilter(setCode)}" && number = "${escapeFilter(number)}"`,
        { expand: "set,game" }
      )
    const games = await listGames()
    return toHit(record, games)
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) return null
    throw error
  }
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** The server assigns the SKU in `pb_hooks/items.pb.js`; we never send one. */
export async function createItem(input: NewItemInput): Promise<ItemRecord> {
  const body = {
    kind: input.kind,
    game: input.gameId,
    card: input.cardId || undefined,
    title: input.title || undefined,
    set_code: input.setCode || undefined,
    number: input.number || undefined,
    finish: input.finish || undefined,
    condition: input.condition || undefined,
    completeness: input.completeness || undefined,
    qty: input.qty,
    cost: input.cost,
    price: input.price,
    location: input.locationId || undefined,
    ean: input.ean || undefined,
    notes: input.notes || undefined,
    status: "in_stock" as const,
    source: "supplier" as const,
    tax_scheme: "standard" as const,
  }

  if (isDemo()) {
    const item: ItemRecord = {
      id: `item_${Math.random().toString(36).slice(2, 10)}`,
      sku: generateCode(input.kind).encoded,
      created: new Date().toISOString(),
      ...body,
    }
    demoItems.unshift(item)
    return item
  }

  return pb.collection("items").create<ItemRecord>(body)
}

export async function getItemBySku(sku: string): Promise<ItemRecord | null> {
  if (isDemo()) return demoItems.find((item) => item.sku === sku) ?? null
  try {
    return await pb
      .collection("items")
      .getFirstListItem<ItemRecord>(`sku = "${escapeFilter(sku)}"`)
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) return null
    throw error
  }
}

/**
 * `label_jobs.template` is required by the migration, so the caller does not
 * have to know which template: the first active one for the item's shape wins,
 * and Phase 5's label screen makes it a choice.
 */
export async function queueLabel(
  itemId: string,
  copies = 1
): Promise<LabelJobRecord> {
  if (isDemo()) {
    return {
      id: `label_${Math.random().toString(36).slice(2, 10)}`,
      item: itemId,
      template: "toploader_40x20",
      copies,
      status: "queued",
    }
  }

  const template = await pb
    .collection("label_templates")
    .getFirstListItem<{ id: string }>('active = true && key = "toploader_40x20"')
    .catch(() => pb.collection("label_templates").getFirstListItem<{ id: string }>("active = true"))

  return pb.collection("label_jobs").create<LabelJobRecord>({
    item: itemId,
    template: template.id,
    copies,
    status: "queued",
    requested_by: pb.authStore.record?.id,
  })
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export class SignInError extends Error {}

/** Signs a staff member in and leaves the token in the SDK's auth store. */
export async function login(email: string, password: string): Promise<StaffRecord> {
  if (isDemo()) {
    const clean = email.trim().toLowerCase()
    if (clean !== DEMO_STAFF.email || password !== DEMO_STAFF.password) {
      throw new SignInError("That email and password do not match a staff account.")
    }
    const { password: _password, ...staff } = DEMO_STAFF
    void _password
    return staff
  }

  try {
    const result = await pb
      .collection("staff")
      .authWithPassword<StaffRecord>(email.trim(), password)
    return result.record
  } catch (error) {
    if (error instanceof ClientResponseError) {
      const serverMessage = error.message?.trim()
      // A plain wrong email or password is PocketBase's own generic 400,
      // with nothing specific to say; anything else, including the 403 the
      // server now sends for a deactivated account, is a deliberate refusal
      // worth showing exactly as sent rather than guessing at it here.
      const isGenericMismatch = error.status === 400 && !/inactive/i.test(serverMessage ?? "")
      throw new SignInError(
        isGenericMismatch || !serverMessage
          ? "That email and password do not match a staff account."
          : serverMessage
      )
    }
    throw error
  }
}

/** Confirms a password without disturbing the current session. Used by the lock. */
export async function verifyPassword(
  email: string,
  password: string
): Promise<boolean> {
  if (isDemo()) {
    return email.trim().toLowerCase() === DEMO_STAFF.email && password === DEMO_STAFF.password
  }
  try {
    await login(email, password)
    return true
  } catch (error) {
    if (error instanceof SignInError) return false
    throw error
  }
}

// ---------------------------------------------------------------------------
// Customers and trade
//
// The customers area and the buy-in wizard call through these; the record
// shapes they use are already re-exported from `./types` at the top of this
// file. Both modules branch on `isDemo()` themselves, exactly as the calls
// above do.
// ---------------------------------------------------------------------------

export {
  createCustomer,
  eraseCustomer,
  findCustomerByScan,
  getCreditLedger,
  getCustomer,
  mergeCustomers,
  qrTokenFrom,
  searchCustomers,
  updateCustomer,
} from "@/lib/api/customers"

export {
  completeTradeIn,
  createDraftTradeIn,
  emailReceipt,
  fetchIdPhoto,
  getCustomerTradeIns,
  getLoyaltyProgramme,
  getOfferSettings,
  getPricingRules,
  getReceipt,
  getVaultConfig,
  loyaltyRulesFrom,
  offerSettingsFrom,
  programmeFrom,
  rulesFrom,
  getTradeIn,
  getTradeInLines,
  latestIdDocument,
  listTradeIns,
  saveTradeInLines,
  submitIdCheck,
} from "@/lib/api/tradeins"

export { isNotFound, refusalMessage, refusalOrFallback } from "@/lib/api/refusal"

// ---------------------------------------------------------------------------
// Selling, cash, labels and the item page (Phase 2)
//
// The demo item store is exported so the Sell, Stock, Home and label screens
// read the very array `createItem` above appends to: an item added on Add
// stock is sellable on the next screen without a server. Nothing outside
// `lib/api/demo/` should touch it.
// ---------------------------------------------------------------------------
export { demoItems as demoItemStore }
export * from "@/lib/api/config"
export * from "@/lib/api/item-shape"
export * from "@/lib/api/items"
export * from "@/lib/api/sales"
export * from "@/lib/api/cash"
export * from "@/lib/api/labels"
