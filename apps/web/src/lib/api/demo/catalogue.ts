/**
 * The demo counter's catalogue and price book.
 *
 * One card per game in scope plus one SNES title, each carrying a plausible
 * set of `price_snapshots` rows: some fresh, one stale, one source missing
 * altogether, native EUR and USD amounts beside their GBP conversions, and a
 * UK sold comp on the Yu-Gi-Oh! card. Everything is held in memory for the
 * tab, exactly like the other demo stores, so "Refresh" and "Add UK comp"
 * really do change what the source view then shows.
 *
 * Ages are relative to now, so the demo never rots: the stale rows are stale
 * because they were fetched two days ago, not because the fixture was written
 * in September.
 *
 * The four Pokemon and three Magic cards the Phase 1 fixtures already hold
 * keep their ids here, so an item added on Add stock, a buy-in line and a
 * price check all name the same card.
 */
import { convertMinorToGbpPence, roundHalfUp, type PriceSource } from "@gg/shared"

import { cardArt } from "@/kit/placeholder-art"
import { PLATFORMS } from "@/design/platforms"
import { DEMO_CARDS, DEMO_GAMES, DEMO_LOCATIONS } from "@/lib/api/fixtures"
import { itemDetailLine, platformForItem } from "@/lib/api/item-shape"
import { ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type {
  CardHit,
  FxRatesView,
  ItemSummary,
  LookupGame,
  PriceSourceRow,
  PriceView,
  RetroHit,
  UkCompInput,
} from "@/lib/api/types"

const CARD_ART = cardArt(PLATFORMS.tcg_card.ratio)
const BOX_ART = cardArt(PLATFORMS.snes_pal_box.ratio)

/** GBP per one unit of the foreign currency, the direction money.ts takes. */
export const DEMO_FX: FxRatesView = {
  base: "GBP",
  rates: { EUR: 0.8606, USD: 0.75 },
  // Four days old, so the source view's stale-rate line has something to say.
  fetched_at: hoursAgo(96),
  date: hoursAgo(96).slice(0, 10),
  stale: true,
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 36e5).toISOString()
}

// ---------------------------------------------------------------------------
// The cards the demo counter knows about
// ---------------------------------------------------------------------------

/** The three games the Phase 1 fixtures do not cover. */
const EXTRA_CARDS: CardHit[] = [
  {
    id: "card_ct13_en003",
    name: "Dark Magician",
    number: "CT13-EN003",
    gameKey: "yugioh",
    gameId: "game_yugioh",
    setCode: "ct13",
    setName: "2016 Mega-Tin Mega Pack",
    rarity: "Secret rare",
    finishes: ["normal", "holo"],
    image: CARD_ART,
    marketPence: null,
  },
  {
    id: "card_op01_001",
    name: "Roronoa Zoro",
    number: "OP01-001",
    gameKey: "onepiece",
    gameId: "game_onepiece",
    setCode: "op01",
    setName: "Romance Dawn",
    rarity: "Leader",
    finishes: ["normal", "holo"],
    image: CARD_ART,
    marketPence: null,
  },
  {
    id: "card_tfc_042",
    name: "Elsa, Spirit of Winter",
    number: "042",
    gameKey: "lorcana",
    gameId: "game_lorcana",
    setCode: "tfc",
    setName: "The First Chapter",
    rarity: "Legendary",
    finishes: ["normal", "foil"],
    image: CARD_ART,
    marketPence: null,
  },
]

/** Every card the demo lookup can find, Phase 1's fixtures included. */
export const DEMO_CATALOGUE: CardHit[] = [...DEMO_CARDS, ...EXTRA_CARDS]

/** The one retro title, so a retro buy-in line has something to price. */
export const DEMO_RETRO: RetroHit[] = [
  {
    id: "retro_smk",
    name: "Super Mario Kart",
    platformId: "platform_snes_pal_box",
    platformKey: "snes_pal_box",
    platformName: PLATFORMS.snes_pal_box.label,
    region: "PAL",
    image: BOX_ART,
  },
  {
    id: "retro_gt",
    name: "GoldenEye 007",
    platformId: "platform_n64_box",
    platformKey: "n64_box",
    platformName: PLATFORMS.n64_box.label,
    region: "PAL",
    image: BOX_ART,
  },
]

// ---------------------------------------------------------------------------
// The price book
// ---------------------------------------------------------------------------

interface SeedRow {
  /** A `cards` id or a `retro_titles` id. */
  subject: string
  /** A card finish, or a retro completeness. "" matches every query. */
  finish: string
  source: PriceSource
  currency: "GBP" | "EUR" | "USD"
  /** Minor units of `currency`: pence for GBP, cents for EUR and USD. */
  native: number
  /** How long ago it was fetched, in hours. */
  age: number
  evidence?: string
}

/**
 * Freshness, as docs/api-contract.md's Phase 3 section sets it: UK sold comp
 * 30 days, eBay asking 24 hours, everything else 3 days. The demo answers the
 * same way the route does rather than guessing, so a row that reads stale
 * here reads stale against a real server too.
 */
const MAX_AGE_HOURS: Record<PriceSource, number> = {
  uk_sold_manual: 30 * 24,
  ebay_uk_asking: 24,
  cardmarket: 72,
  tcgplayer: 72,
  pricecharting_pal: 72,
  pricecharting_ntsc: 72,
}

const SEED: SeedRow[] = [
  // Charizard ex: no UK comp yet, an eBay figure that has gone stale, a fresh
  // Cardmarket and a fresh TCGplayer. Cardmarket is what gets chosen.
  { subject: "card_sv151_199", finish: "holo", source: "ebay_uk_asking", currency: "GBP", native: 33915, age: 40 },
  { subject: "card_sv151_199", finish: "holo", source: "cardmarket", currency: "EUR", native: 36830, age: 4 },
  { subject: "card_sv151_199", finish: "holo", source: "tcgplayer", currency: "USD", native: 42100, age: 20 },
  { subject: "card_sv151_199", finish: "normal", source: "ebay_uk_asking", currency: "GBP", native: 27500, age: 40 },
  { subject: "card_sv151_199", finish: "normal", source: "cardmarket", currency: "EUR", native: 29400, age: 6 },
  { subject: "card_sv151_199", finish: "normal", source: "tcgplayer", currency: "USD", native: 34000, age: 20 },

  // Mew ex and Pikachu, so the rest of the demo set prices itself too.
  { subject: "card_sv151_205", finish: "holo", source: "cardmarket", currency: "EUR", native: 7250, age: 5 },
  { subject: "card_sv151_205", finish: "holo", source: "tcgplayer", currency: "USD", native: 8400, age: 26 },
  { subject: "card_sv151_025", finish: "reverse", source: "cardmarket", currency: "EUR", native: 180, age: 7 },
  { subject: "card_sv151_201", finish: "holo", source: "cardmarket", currency: "EUR", native: 11400, age: 9 },
  { subject: "card_sv8_113", finish: "holo", source: "cardmarket", currency: "EUR", native: 2450, age: 8 },

  // Mabel: eBay UK is fresh here, so a GBP source wins and nothing converts.
  { subject: "card_blb_223", finish: "foil", source: "ebay_uk_asking", currency: "GBP", native: 1275, age: 9 },
  { subject: "card_blb_223", finish: "foil", source: "cardmarket", currency: "EUR", native: 1580, age: 14 },
  { subject: "card_blb_223", finish: "normal", source: "cardmarket", currency: "EUR", native: 890, age: 14 },
  { subject: "card_blb_198", finish: "normal", source: "cardmarket", currency: "EUR", native: 640, age: 16 },
  { subject: "card_fdn_179", finish: "normal", source: "cardmarket", currency: "EUR", native: 120, age: 18 },

  // Dark Magician: a staff-entered UK sold comp, which outranks everything.
  {
    subject: "card_ct13_en003",
    finish: "holo",
    source: "uk_sold_manual",
    currency: "GBP",
    native: 4500,
    age: 8 * 24,
    evidence: "https://www.ebay.co.uk/itm/226119440823",
  },
  { subject: "card_ct13_en003", finish: "holo", source: "cardmarket", currency: "EUR", native: 5490, age: 11 },

  // Roronoa Zoro: One Piece prices arrive under "tcgplayer", and the
  // Cardmarket row has gone stale.
  { subject: "card_op01_001", finish: "normal", source: "tcgplayer", currency: "USD", native: 1899, age: 13 },
  { subject: "card_op01_001", finish: "normal", source: "cardmarket", currency: "EUR", native: 1720, age: 96 },

  // Elsa: one source and one only, so most of the view reads "No value".
  { subject: "card_tfc_042", finish: "foil", source: "tcgplayer", currency: "USD", native: 3250, age: 15 },

  // Super Mario Kart, complete in box: PriceCharting PAL leads, the NTSC
  // figure is there for comparison, and the eBay row is stale.
  { subject: "retro_smk", finish: "cib", source: "pricecharting_pal", currency: "USD", native: 9400, age: 10 },
  { subject: "retro_smk", finish: "cib", source: "ebay_uk_asking", currency: "GBP", native: 8250, age: 44 },
  { subject: "retro_smk", finish: "cib", source: "pricecharting_ntsc", currency: "USD", native: 7100, age: 10 },
  { subject: "retro_smk", finish: "loose", source: "pricecharting_pal", currency: "USD", native: 2400, age: 10 },
  { subject: "retro_gt", finish: "cib", source: "pricecharting_pal", currency: "USD", native: 5600, age: 12 },
]

interface Snapshot extends SeedRow {
  fetchedAt: string
}

const snapshots: Snapshot[] = SEED.map((row) => ({ ...row, fetchedAt: hoursAgo(row.age) }))

function rateFor(currency: "GBP" | "EUR" | "USD"): number | null {
  return currency === "GBP" ? null : (DEMO_FX.rates[currency] ?? null)
}

function toRow(snapshot: Snapshot, now: number): PriceSourceRow {
  const rate = rateFor(snapshot.currency)
  const gbp =
    snapshot.currency === "GBP"
      ? snapshot.native
      : convertMinorToGbpPence(snapshot.native, snapshot.currency, rate ?? 1)
  const ageHours = (now - new Date(snapshot.fetchedAt).getTime()) / 36e5
  return {
    source: snapshot.source,
    gbp_market: gbp,
    native_currency: snapshot.currency,
    native_market: snapshot.native,
    fx_rate: snapshot.currency === "GBP" ? 1 : rate,
    fx_date: snapshot.currency === "GBP" ? null : (DEMO_FX.date ?? null),
    fetched_at: snapshot.fetchedAt,
    stale: ageHours > MAX_AGE_HOURS[snapshot.source],
    evidence_url: snapshot.evidence ?? "",
  }
}

/**
 * The same choice the route makes: the first source in priority order that
 * has a fresh figure, with stale rows kept and flagged rather than hidden.
 */
function view(
  subject: string,
  finish: string,
  priority: PriceSource[],
  multiplier: number | null
): PriceView {
  const now = Date.now()
  // Exactly as the route's own filter reads it: `finish = {:finish}`, with an
  // empty finish matching the rows written without one rather than all of
  // them. A demo that matched loosely would price a card the counter could
  // not, and hide the bug this very rule exists to expose.
  const wanted = finish || ""
  const rows = snapshots
    .filter((row) => row.subject === subject && row.finish === wanted)
    .map((row) => toRow(row, now))

  const sources: PriceSourceRow[] = []
  let chosen: PriceSourceRow | null = null
  for (const source of priority) {
    const match = rows
      .filter((row) => row.source === source)
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0]
    if (!match) continue
    sources.push(match)
    if (!match.stale && !chosen) chosen = match
  }
  if (!chosen && sources.length > 0) {
    chosen = [...sources].sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0] ?? null
  }

  return {
    chosen,
    sources,
    condition_adjusted:
      chosen && multiplier !== null ? roundHalfUp(chosen.gbp_market * multiplier) : null,
  }
}

// ---------------------------------------------------------------------------
// The demo twins of the routes
// ---------------------------------------------------------------------------

function numberMatches(cardNumber: string, typed: string): boolean {
  const left = cardNumber.toLowerCase()
  const right = typed.toLowerCase()
  if (left === right) return true
  const bare = left.split("/")[0] ?? left
  return (
    bare === right ||
    bare === right.replace(/^0+/, "") ||
    bare.replace(/^0+/, "") === right
  )
}

/** The One Piece adapter only takes a card code, for example OP01-001. */
const ONE_PIECE_CODE = /\bop\d{2}-\d{3}\b/i

export function searchCards(game: LookupGame | "" | undefined, q: string): CardHit[] {
  const needle = q.trim().toLowerCase()
  const tokens = needle.split(/\s+/).filter(Boolean)
  // The same refusal the route makes, so the field shows the same sentence
  // with or without a server behind it.
  if (game === "onepiece" && !ONE_PIECE_CODE.test(needle)) {
    throw new Error("One Piece search needs a card code, for example OP01-001.")
  }
  return DEMO_CATALOGUE.filter((card) => {
    if (game && card.gameKey !== game) return false
    const haystack =
      `${card.name} ${card.setName} ${card.setCode} ${card.number} ${card.rarity ?? ""}`.toLowerCase()
    // "sv151 199" is two tokens that both have to land, "charizard" is one.
    return tokens.every(
      (token) =>
        haystack.includes(token) ||
        numberMatches(card.number, token) ||
        card.setCode.toLowerCase() === token
    )
  })
}

export function getCard(game: LookupGame, set: string, number: string): CardHit | null {
  return (
    DEMO_CATALOGUE.find(
      (card) =>
        card.gameKey === game &&
        card.setCode.toLowerCase() === set.toLowerCase() &&
        numberMatches(card.number, number)
    ) ?? null
  )
}

export function searchRetro(q: string, platform?: string): RetroHit[] {
  const needle = q.trim().toLowerCase()
  return DEMO_RETRO.filter(
    (title) =>
      title.name.toLowerCase().includes(needle) &&
      (!platform || title.platformKey === platform)
  )
}

export function getPrices(
  cardId: string,
  finish: string,
  priority: PriceSource[],
  multiplier: number
): PriceView {
  return view(cardId, finish, priority, multiplier)
}

export function getRetroPrices(
  id: string,
  completeness: string,
  priority: PriceSource[]
): PriceView {
  return view(id, completeness, priority, null)
}

/**
 * "Refresh" in demo mode: every source the shop has a figure for is fetched
 * again, which is what makes the stale eBay row on the Charizard the chosen
 * one afterwards, exactly as a real refresh would.
 */
export function refreshPrices(subject: string, finish: string) {
  const now = new Date().toISOString()
  for (const snapshot of snapshots) {
    if (snapshot.subject !== subject) continue
    if (finish && snapshot.finish !== finish) continue
    if (snapshot.source === "uk_sold_manual") continue
    snapshot.fetchedAt = now
  }
}

/** A staff-entered UK sold comp, which outranks every automated source. */
export function addUkComp(subject: string, input: UkCompInput) {
  snapshots.push({
    subject,
    // `price_snapshots.finish` carries a card's finish and a retro title's
    // completeness alike, which is the one column the routes file under.
    finish: input.completeness ?? input.finish ?? "",
    source: "uk_sold_manual",
    currency: "GBP",
    native: input.price,
    age: 0,
    evidence: input.url,
    fetchedAt: new Date(`${input.sold_at}T00:00:00.000Z`).toISOString(),
  })
}

export function getFx(): FxRatesView {
  return { ...DEMO_FX, rates: { ...DEMO_FX.rates } }
}

/** Every copy of one card still on the shelf. */
export function stockForCard(cardId: string): ItemSummary[] {
  ensureSeeded()
  return itemStore()
    .filter(
      (item) =>
        item.card === cardId &&
        (item.status ?? "in_stock") !== "sold" &&
        (item.status ?? "in_stock") !== "written_off"
    )
    .map((item) => ({
      id: item.id,
      sku: item.sku,
      kind: item.kind,
      title: item.title || "Untitled item",
      detail: itemDetailLine(item),
      condition: item.condition || "",
      price: item.price ?? 0,
      status: item.status ?? "in_stock",
      locationName: DEMO_LOCATIONS.find((place) => place.id === item.location)?.name ?? "",
      image: DEMO_CATALOGUE.find((card) => card.id === item.card)?.image,
      platform: platformForItem(item),
      qty: item.qty ?? 1,
      game: item.game ?? null,
    }))
}

/** The `games` id for a lookup key, so a demo hit carries the right one. */
export function demoGameId(key: string): string {
  return DEMO_GAMES.find((game) => game.key === key)?.id ?? ""
}

/** "Not in catalogue" in demo mode: the card joins the in-memory catalogue. */
export function createManualCard(input: {
  gameKey: string
  name: string
  setCode: string
  number: string
}): CardHit {
  const card: CardHit = {
    id: `card_manual_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name,
    number: input.number,
    gameKey: input.gameKey,
    gameId: demoGameId(input.gameKey),
    setCode: input.setCode,
    setName: input.setCode.toUpperCase(),
    image: CARD_ART,
    finishes: [],
    marketPence: null,
  }
  DEMO_CATALOGUE.push(card)
  return card
}
