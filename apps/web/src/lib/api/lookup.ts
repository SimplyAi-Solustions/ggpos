/**
 * The catalogue lookup routes: `GET /api/vault/lookup`,
 * `GET /api/vault/lookup/:game/:set/:number` and `GET /api/vault/retro/lookup`
 * (docs/api-contract.md, "Phase 3: lookup, prices and FX").
 *
 * These are the only way a screen finds a card now. The Phase 1 `searchCards`
 * in `./index.ts` reads the `cards` collection directly and can therefore only
 * find what the shop has already seen; the lookup route asks the game's own
 * adapter and writes the answer through to `cards`, which is the point of it.
 * That older function keeps its name and its callers (the command palette
 * searches what is already in the database, which is the right thing for a
 * palette), so this module's `searchCards` is re-exported from `@/lib/api` as
 * `lookupCards`. Screens that want the route import from here directly.
 *
 * `stockForCard` sits here rather than with the other stock reads because the
 * price-check screen is its only caller: "what is this card worth, and how
 * many have we got" is one question at the counter.
 */
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { itemDetailLine, platformForItem } from "@/lib/api/item-shape"
import * as demo from "@/lib/api/demo/catalogue"
import { PLATFORMS, type PlatformKey } from "@/design/platforms"
import type {
  CardHit,
  CardLookupRow,
  GameRecord,
  ItemSummary,
  LookupGame,
  RetroHit,
  RetroTitleRow,
  StockItemRecord,
} from "@/lib/api/types"

/** The five games with a card catalogue behind them, in counter order. */
export const LOOKUP_GAMES: { key: LookupGame; label: string }[] = [
  { key: "pokemon", label: "Pokemon" },
  { key: "mtg", label: "Magic" },
  { key: "yugioh", label: "Yu-Gi-Oh!" },
  { key: "onepiece", label: "One Piece" },
  { key: "lorcana", label: "Lorcana" },
]

/** The platforms a retro line can be, by `platforms.key`. */
export const RETRO_PLATFORMS: { key: PlatformKey; label: string }[] = [
  "snes_pal_box",
  "n64_box",
  "megadrive_box",
  "gameboy_cart",
  "gameboy_box",
  "ps1_case",
  "ps2_case",
  "gamecube_case",
  "switch_case",
  "console",
].map((key) => ({
  key: key as PlatformKey,
  label: PLATFORMS[key as PlatformKey].label,
}))

const GAME_KEYS = new Set<string>(LOOKUP_GAMES.map((game) => game.key))

/** True for one of the five keys the lookup route accepts. */
export function isLookupGame(key: string | undefined): key is LookupGame {
  return Boolean(key && GAME_KEYS.has(key))
}

/**
 * A lookup row as the screens' `CardHit`. The route answers with the `games`
 * record id, so the key comes from the call that asked for it.
 */
export function toCardHit(row: CardLookupRow, gameKey: string): CardHit {
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    gameKey,
    gameId: row.game,
    setCode: row.set_code,
    setName: row.set_name,
    image: row.image_small || row.image_large || undefined,
    rarity: row.rarity || undefined,
    finishes: Array.isArray(row.finishes_available) ? row.finishes_available : [],
    // The price routes own market value now; nothing joins it onto a hit.
    marketPence: null,
  }
}

/**
 * Search one game's catalogue, or all five when no game is chosen.
 *
 * A name search always reaches the adapter (that is how a card the shop has
 * never handled gets into the database at all), so narrowing to a game is
 * five times less work for the server: the screens put the game chips right
 * above the field for exactly that reason.
 */
export async function searchCards(
  game: LookupGame | "" | undefined,
  q: string,
  limit = 8,
  signal?: AbortSignal
): Promise<CardHit[]> {
  const query = q.trim()
  if (query.length < 2) return []

  if (isDemo()) return demo.searchCards(game, query).slice(0, limit)

  if (!game) {
    const perGame = await Promise.all(
      LOOKUP_GAMES.map((entry) =>
        searchCards(entry.key, query, limit, signal).catch(() => [] as CardHit[])
      )
    )
    // Round robin rather than "all the Pokemon first", so a Magic card is
    // never pushed off the end of the list by a game nobody asked about.
    const merged: CardHit[] = []
    for (let index = 0; merged.length < limit; index += 1) {
      const row = perGame.map((hits) => hits[index]).filter(Boolean) as CardHit[]
      if (row.length === 0) break
      merged.push(...row)
    }
    return merged.slice(0, limit)
  }

  const response = await pb.send<{ cards: CardLookupRow[] }>("/api/vault/lookup", {
    method: "GET",
    query: { game, q: query },
    // TanStack aborts the signal the moment a newer keystroke takes over, and
    // a name search reaches the adapter, so five abandoned fan-outs are five
    // abandoned adapter calls unless this is passed through.
    signal,
  })
  return (response.cards ?? []).map((row) => toCardHit(row, game)).slice(0, limit)
}

/**
 * The exact card behind a set code and a collector number.
 *
 * A 404 carries the server's own sentence ("Card not found in Scarlet &
 * Violet 151. Check the number or add it manually."), which the search field
 * shows as it is rather than writing one of its own.
 */
export async function getCard(
  game: LookupGame,
  set: string,
  number: string,
  signal?: AbortSignal
): Promise<CardHit | null> {
  if (isDemo()) return demo.getCard(game, set, number)
  const response = await pb.send<{ cards: CardLookupRow[] }>(
    `/api/vault/lookup/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(number)}`,
    { method: "GET", signal }
  )
  const row = response.cards?.[0]
  return row ? toCardHit(row, game) : null
}

/**
 * The `platforms` table, keyed by id, read once per session.
 *
 * A retro row carries the platform's record id, not its key, and a search
 * that named no platform still resolves every row it wrote through: without
 * this every preview row would draw in the 3:4 "Other" frame and read
 * "Other" under its name.
 */
let platformsByIdCache: Promise<Map<string, string>> | null = null

function platformsById(): Promise<Map<string, string>> {
  if (!platformsByIdCache) {
    platformsByIdCache = pb
      .collection("platforms")
      .getFullList<{ id: string; key: string }>({ fields: "id,key" })
      .then((rows) => new Map(rows.map((row) => [row.id, row.key])))
      .catch(() => new Map<string, string>())
  }
  return platformsByIdCache
}

/** A retro row with its platform resolved to something `ProductImage` takes. */
function toRetroHit(
  row: RetroTitleRow,
  platformKey: string,
  byId?: Map<string, string>
): RetroHit {
  const resolved = (byId?.get(row.platform) || platformKey || "other") as PlatformKey
  const key = resolved in PLATFORMS ? resolved : ("other" as PlatformKey)
  return {
    id: row.id,
    name: row.name,
    platformId: row.platform,
    platformKey: key,
    platformName: PLATFORMS[key]?.label ?? "Retro",
    region: row.region ?? "",
    image:
      row.cover && row.id
        ? pb.files.getURL({ id: row.id, collectionName: "retro_titles" }, row.cover)
        : undefined,
  }
}

/**
 * Retro titles by name. Without a platform the route is preview-only: every
 * row comes back with an empty id because `retro_titles.platform` is
 * required, so nothing can be written through. A line needs a real id before
 * it can carry a price, which is why the platform chips come first.
 */
export async function searchRetro(
  q: string,
  platform?: string,
  signal?: AbortSignal
): Promise<RetroHit[]> {
  const query = q.trim()
  if (query.length < 2) return []
  if (isDemo()) return demo.searchRetro(query, platform)

  const response = await pb.send<{ titles: RetroTitleRow[] }>(
    "/api/vault/retro/lookup",
    {
      method: "GET",
      query: platform ? { q: query, platform } : { q: query },
      signal,
    }
  )
  const byId = await platformsById()
  return (response.titles ?? []).map((row) => toRetroHit(row, platform ?? "", byId))
}

/** True for the 404 the exact lookup makes when the adapter has nothing. */
export function isCardNotFound(error: unknown): boolean {
  return error instanceof ClientResponseError && error.status === 404
}

// ---------------------------------------------------------------------------
// What we are holding
// ---------------------------------------------------------------------------

type ExpandedItem = StockItemRecord & {
  expand?: { location?: { name?: string } }
}

/**
 * Every copy of one card still on the shelf, newest first. Price check shows
 * these under the valuation so staff can answer "have we got one" without
 * leaving the screen.
 */
export async function stockForCard(cardId: string): Promise<ItemSummary[]> {
  if (!cardId) return []
  if (isDemo()) return demo.stockForCard(cardId)

  const escaped = cardId.replace(/["\\]/g, "\\$&")
  const page = await pb.collection("items").getList<ExpandedItem>(1, 20, {
    filter: `card = "${escaped}" && (status = "in_stock" || status = "reserved" || status = "listed_ebay")`,
    expand: "location",
    sort: "-created",
  })
  return page.items.map((item) => ({
    id: item.id,
    sku: item.sku,
    kind: item.kind,
    title: item.title || "Untitled item",
    detail: itemDetailLine(item),
    condition: item.condition || "",
    price: item.price ?? 0,
    status: item.status ?? "in_stock",
    locationName: item.expand?.location?.name ?? "",
    image: undefined,
    platform: platformForItem(item),
    qty: item.qty ?? 1,
    game: item.game ?? null,
  }))
}

/** The `games` row a lookup hit belongs to, for the Add stock form. */
export function gameIdFor(games: GameRecord[], key: string): string {
  return games.find((game) => game.key === key)?.id ?? ""
}

// ---------------------------------------------------------------------------
// A card the catalogue has never heard of
// ---------------------------------------------------------------------------

export interface ManualCardInput {
  /** One of the five lookup keys, from the chips. */
  gameKey: string
  name: string
  setCode: string
  number: string
}

/**
 * "Not in catalogue" (docs/PLAN.md, "Card not found"): a `cards` row with
 * `source: "manual"`, and the `card_sets` row it needs if the set is new too.
 * An admin links it to a real printing later; until then it sells, labels and
 * prices like any other card, with no price snapshots behind it.
 */
export async function createManualCard(input: ManualCardInput): Promise<CardHit> {
  if (isDemo()) return demo.createManualCard(input)

  const quote = (value: string) => value.replace(/["\\]/g, "\\$&")
  const game = await pb
    .collection("games")
    .getFirstListItem<GameRecord>(`key = "${quote(input.gameKey)}"`)

  const code = input.setCode.trim()
  let set = await pb
    .collection("card_sets")
    .getFirstListItem<{ id: string; code: string; name: string }>(
      `game = "${game.id}" && code = "${quote(code)}"`
    )
    .catch(() => null)
  if (!set) {
    set = await pb
      .collection("card_sets")
      .create<{ id: string; code: string; name: string }>({
        game: game.id,
        code,
        // The adapter fills the real name in on the next sync; until then the
        // code is what staff typed and what the label will print.
        name: code.toUpperCase(),
      })
  }

  const card = await pb.collection("cards").create<{ id: string }>({
    game: game.id,
    set: set.id,
    number: input.number.trim(),
    name: input.name.trim(),
    source: "manual",
    search_text: `${input.name} ${code} ${input.number}`.toLowerCase(),
    // The exact lookup serves a row whose `last_synced` is under 30 days old
    // straight from the database. Without a stamp this row looks ancient, so
    // every lookup of a card only this shop knows about would ask the
    // adapter, get nothing, and answer 404 for a card that is right there.
    last_synced: new Date().toISOString(),
  })

  return {
    id: card.id,
    name: input.name.trim(),
    number: input.number.trim(),
    gameKey: input.gameKey,
    gameId: game.id,
    setCode: set.code,
    setName: set.name,
    finishes: [],
    marketPence: null,
  }
}
