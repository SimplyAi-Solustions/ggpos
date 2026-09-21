import { buildCode } from "@gg/shared"

import { cardArt } from "@/kit/placeholder-art"
import { PLATFORMS } from "@/design/platforms"
import type {
  CardHit,
  GameRecord,
  ItemRecord,
  LocationRecord,
  StaffRecord,
} from "@/lib/api/types"

/**
 * The demo counter: one shop's worth of plausible data, no server needed.
 *
 * Art is the kit's placeholder card, not real scans: GG Vault never ships
 * third-party card images it has not fetched itself.
 */

const CARD_ART = cardArt(PLATFORMS.tcg_card.ratio)

/** The demo sign-in, shown on the login screen when demo mode is on. */
export const DEMO_STAFF: StaffRecord & { password: string } = {
  id: "staff_demo",
  email: "demo@ggentertainment.co.uk",
  password: "ggvault-demo",
  name: "Demo Counter",
  role: "admin",
  active: true,
}

/**
 * A second demo account, in the state a real first admin is in before they
 * have set a password of their own: signing in with it shows the "Set a new
 * password" screen and nothing else. The demo sign-in above is deliberately
 * not in that state, so exploring the demo never starts with a form.
 */
export const DEMO_LOCKED_STAFF: StaffRecord & { password: string } = {
  id: "staff_demo_new",
  email: "new@ggentertainment.co.uk",
  password: "ggvault-temporary",
  name: "New Starter",
  role: "admin",
  active: true,
  must_change_password: true,
}

export const DEMO_GAMES: GameRecord[] = [
  { id: "game_pokemon", key: "pokemon", name: "Pokemon", enabled: true },
  { id: "game_mtg", key: "mtg", name: "Magic: The Gathering", enabled: true },
  { id: "game_yugioh", key: "yugioh", name: "Yu-Gi-Oh!", enabled: true },
  { id: "game_onepiece", key: "onepiece", name: "One Piece", enabled: true },
  { id: "game_lorcana", key: "lorcana", name: "Disney Lorcana", enabled: true },
  {
    id: "game_retro",
    key: "retro",
    name: "Retro games and consoles",
    enabled: true,
  },
]

export const DEMO_LOCATIONS: LocationRecord[] = [
  { id: "loc_showcase", name: "Showcase", type: "display", sort: 10 },
  { id: "loc_binder_a", name: "Binder A", type: "binder", sort: 20 },
  { id: "loc_binder_b", name: "Binder B", type: "binder", sort: 30 },
  { id: "loc_bin_1", name: "Bin 1", type: "bin", sort: 40 },
  { id: "loc_storeroom", name: "Storeroom", type: "storeroom", sort: 50 },
]

type SeedCard = Omit<CardHit, "image" | "gameId"> & { gameId: string }

const SEED_CARDS: SeedCard[] = [
  {
    id: "card_sv151_199",
    name: "Charizard ex",
    number: "199/165",
    gameKey: "pokemon",
    gameId: "game_pokemon",
    setCode: "sv151",
    setName: "Scarlet & Violet 151",
    rarity: "Special illustration rare",
    finishes: ["normal", "holo"],
    marketPence: null,
  },
  {
    id: "card_sv151_201",
    name: "Alakazam ex",
    number: "201/165",
    gameKey: "pokemon",
    gameId: "game_pokemon",
    setCode: "sv151",
    setName: "Scarlet & Violet 151",
    rarity: "Special illustration rare",
    finishes: ["normal", "holo"],
    marketPence: null,
  },
  {
    id: "card_sv151_205",
    name: "Mew ex",
    number: "205/165",
    gameKey: "pokemon",
    gameId: "game_pokemon",
    setCode: "sv151",
    setName: "Scarlet & Violet 151",
    rarity: "Gold rare",
    finishes: ["normal", "holo"],
    marketPence: null,
  },
  {
    id: "card_sv151_025",
    name: "Pikachu",
    number: "025/165",
    gameKey: "pokemon",
    gameId: "game_pokemon",
    setCode: "sv151",
    setName: "Scarlet & Violet 151",
    rarity: "Common",
    finishes: ["normal", "reverse"],
    marketPence: null,
  },
  {
    id: "card_sv8_113",
    name: "Pidgeot ex",
    number: "113/191",
    gameKey: "pokemon",
    gameId: "game_pokemon",
    setCode: "sv8",
    setName: "Surging Sparks",
    rarity: "Double rare",
    finishes: ["normal", "holo", "reverse"],
    marketPence: null,
  },
  {
    id: "card_blb_223",
    name: "Mabel, Heir to Cragflame",
    number: "0223",
    gameKey: "mtg",
    gameId: "game_mtg",
    setCode: "blb",
    setName: "Bloomburrow",
    rarity: "Mythic",
    finishes: ["normal", "foil"],
    marketPence: null,
  },
  {
    id: "card_blb_198",
    name: "Valley Questcaller",
    number: "0198",
    gameKey: "mtg",
    gameId: "game_mtg",
    setCode: "blb",
    setName: "Bloomburrow",
    rarity: "Rare",
    finishes: ["normal", "foil", "etched"],
    marketPence: null,
  },
  {
    id: "card_fdn_179",
    name: "Llanowar Elves",
    number: "0179",
    gameKey: "mtg",
    gameId: "game_mtg",
    setCode: "fdn",
    setName: "Foundations",
    rarity: "Common",
    finishes: ["normal", "foil"],
    marketPence: null,
  },
]

export const DEMO_CARDS: CardHit[] = SEED_CARDS.map((card) => ({
  ...card,
  image: CARD_ART,
}))

/**
 * Two items already on the shelf, so a demo scan of a real SKU lands on a
 * real item page. The codes are built through the shared SKU helper, which
 * means they carry a valid check character and `isValidCode` passes.
 */
export const DEMO_ITEMS: ItemRecord[] = [
  {
    id: "item_demo_1",
    sku: buildCode("single", "7F3K2").encoded,
    kind: "single",
    game: "game_pokemon",
    card: "card_sv151_199",
    title: "Charizard ex",
    set_code: "sv151",
    number: "199/165",
    finish: "holo",
    condition: "NM",
    qty: 1,
    cost: 18000,
    price: 32499,
    status: "in_stock",
    location: "loc_showcase",
  },
  {
    id: "item_demo_2",
    sku: buildCode("single", "T4M9P").encoded,
    kind: "single",
    game: "game_mtg",
    card: "card_blb_223",
    title: "Mabel, Heir to Cragflame",
    set_code: "blb",
    number: "0223",
    finish: "foil",
    condition: "LP",
    qty: 1,
    cost: 650,
    price: 1249,
    status: "in_stock",
    location: "loc_binder_a",
  },
]

/** The SKU the e2e suite types into the scan field. */
export const DEMO_SCAN_SKU = DEMO_ITEMS[0]!.sku
