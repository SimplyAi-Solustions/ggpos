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
  DEMO_LOCATIONS,
} from "@/lib/api/fixtures"
import { demoItems } from "@/lib/api/demo/items-store"
import {
  demoChangePassword,
  demoPasswordMatches,
  demoSignIn,
} from "@/lib/api/demo/staff"
import { cardMatches, parseCardQuery, numberMatches } from "@/lib/api/query"
import { refusalMessage } from "@/lib/api/refusal"
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
export { DEMO_LOCKED_STAFF, DEMO_STAFF, DEMO_SCAN_SKU } from "@/lib/api/fixtures"


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
    market_at_intake: input.marketAtIntake,
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

/** A password change the server, or the screen's own rules, refused. */
export class PasswordChangeError extends Error {}

/** Signs a staff member in and leaves the token in the SDK's auth store. */
export async function login(email: string, password: string): Promise<StaffRecord> {
  if (isDemo()) {
    const staff = demoSignIn(email, password)
    if (!staff) {
      throw new SignInError("That email and password do not match a staff account.")
    }
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
    return demoPasswordMatches(email, password)
  }
  try {
    await login(email, password)
    return true
  } catch (error) {
    if (error instanceof SignInError) return false
    throw error
  }
}

/**
 * Sets a new password on the signed-in staff member's own account, then
 * signs in again with it.
 *
 * PocketBase takes the change through the ordinary record update
 * (`oldPassword`, `password`, `passwordConfirm`) and rotates the account's
 * token key as it saves, so the token this call started with is dead the
 * moment it succeeds. Signing straight back in is therefore part of the
 * change, not an extra step, and the record it returns is the unlocked one
 * the counter then runs on. `pb/pb_hooks/staff.pb.js` is what clears
 * `must_change_password` and audits the change; nothing here sends, stores
 * or logs either password anywhere else.
 *
 * The update goes through `pb.send` rather than `RecordService.update`
 * deliberately. `update` re-saves the auth store with the record from the
 * response and the token the call was made with, which by then is dead:
 * the gate in `features/auth/gate.ts` would see an unlocked staff member,
 * swap `LockedShell` for the whole counter around a half-finished form and
 * unmount the screen mid-change. `pb.send` attaches the current token and
 * leaves the store alone, so the store changes exactly once, at the
 * re-authentication below, and the counter appears when the counter is
 * really there.
 */
export async function changeOwnPassword(
  email: string,
  current: string,
  next: string
): Promise<StaffRecord> {
  if (isDemo()) {
    const staff = demoChangePassword(email, current, next)
    if (!staff) {
      throw new PasswordChangeError("That password is not right. Try again.")
    }
    return staff
  }

  const signedIn = pb.authStore.record
  if (!signedIn || signedIn.collectionName !== "staff") {
    throw new PasswordChangeError("Sign in again, then set your new password.")
  }

  try {
    await pb.send(`/api/collections/staff/records/${encodeURIComponent(signedIn.id)}`, {
      method: "PATCH",
      body: {
        oldPassword: current,
        password: next,
        passwordConfirm: next,
      },
    })
  } catch (error) {
    throw new PasswordChangeError(passwordChangeMessage(error))
  }

  try {
    const result = await pb.collection("staff").authWithPassword<StaffRecord>(email, next)
    return result.record
  } catch {
    // The password really did change, so the token this ran under is dead
    // whatever happened next. Dropping it is the honest state to be in: the
    // screen sends them to sign-in, where the new password works.
    pb.authStore.clear()
    throw new PasswordChangeError(
      "Your password was changed. Sign in again with the new one."
    )
  }
}

/** Turns PocketBase's refusal into one sentence a counter can act on. */
function passwordChangeMessage(error: unknown): string {
  if (!(error instanceof ClientResponseError)) {
    return "The counter could not reach the server. Check the connection and try again."
  }
  const fields = (error.response?.data ?? {}) as Record<string, unknown>
  if (fields.oldPassword) {
    // PocketBase's own wording here is "Missing or invalid old password",
    // which says nothing to do about it. This is the sentence the idle lock
    // and the step-up route already use for the same mistake.
    return "That password is not right. Try again."
  }
  if (error.status === 403 || error.status === 404) {
    // staff.updateRule is admin-only, so an ordinary staff member's own
    // record is not theirs to write. Nothing they type can change that.
    return "This account cannot set its own password. Ask an admin to set a new one for you."
  }
  // Everything else the server wrote for staff to read (the 12-character
  // rule, a reused password) is shown exactly as sent.
  return (
    refusalMessage(error) ?? "The password could not be changed. Check it and try again."
  )
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
  searchCustomerPage,
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
// The demo item store lives in `lib/api/demo/items-store.ts`, which every
// demo module imports directly; it is re-exported here for the screens that
// already ask this barrel for it. Nothing outside `lib/api/` should touch it.
// ---------------------------------------------------------------------------
export { demoItems as demoItemStore }
export * from "@/lib/api/config"
export * from "@/lib/api/item-shape"
export * from "@/lib/api/items"
export * from "@/lib/api/sales"
export * from "@/lib/api/cash"
export * from "@/lib/api/labels"

// ---------------------------------------------------------------------------
// Settings, stock counts and the offline queue (Phase 3)
//
// `completeSale` and `queueLabels` are deliberately re-exported from
// `./offline` rather than from `./sales` and `./labels`: an explicit export
// wins over an `export *` of the same name, so every screen that already
// imports them from `@/lib/api` gets the offline-aware call without changing
// a line. Online the wrappers are the same request; offline the sale goes in
// the IndexedDB queue and the strip under the nav says how many are waiting.
// docs/PLAN.md, "Core flows and rules > Offline". A buy-in is never queued.
// ---------------------------------------------------------------------------
export * from "@/lib/api/settings"
export * from "@/lib/api/stockcounts"
export * from "@/lib/api/offline"
export {
  completeSaleQueued as completeSale,
  getSaleQueued as getSale,
  queueLabelsQueued as queueLabels,
} from "@/lib/api/offline"

// ---------------------------------------------------------------------------
// Lookup, prices and FX (Phase 3)
//
// `searchCards` above reads the `cards` collection directly, which is what the
// command palette wants: it searches what the shop already holds. The lookup
// route asks the game's own adapter and writes new cards through, so it is a
// different question with the same name; it is exported here as `lookupCards`
// and the screens that want it import `@/lib/api/lookup` directly.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Reports, exports, imports and SumUp (Phase 4)
//
// Deliberately NOT re-exported here. This barrel is imported by the counter
// shell, so it travels in the entry chunk, and everything it re-exports
// travels with it. The Phase 4 modules belong to three routes and nothing
// else, so those screens import `@/lib/api/reports`, `@/lib/api/exports`,
// `@/lib/api/imports`, `@/lib/api/sumup` and `@/lib/api/csv-parse`
// directly - the same reasoning that already keeps `lib/api/lookup` out of
// this file's `export *` list.
// ---------------------------------------------------------------------------

export {
  createManualCard,
  getCard as lookupCard,
  isCardNotFound,
  isLookupGame,
  LOOKUP_GAMES,
  RETRO_PLATFORMS,
  searchCards as lookupCards,
  searchRetro,
  stockForCard,
  toCardHit,
} from "@/lib/api/lookup"
import { escapeFilter } from "@/lib/api/filter"
export * from "@/lib/api/prices"
