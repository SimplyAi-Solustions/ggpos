/**
 * The demo shop's Games Workshop rack (docs/api-contract-reorder.md,
 * section 4.1): twelve products on thirteen stock rows, each with a shelf
 * target, the supplier's code and a barcode, filed under the minis branches
 * with game Warhammer.
 *
 * A leaf module with no demo imports, because the item store is built from
 * it before anything else in demo mode runs. Every row sits in the
 * Storeroom or Bin 1, never the Showcase or the binders, so a demo stock
 * count of those finds what it always found. The rows carry their branch,
 * so the Unsorted list stays the two rows it was.
 *
 * One product, Combat Patrol: Space Marines, was restocked: the first row
 * sold out and a second came in two days ago, which is the case the report
 * counts as one line.
 *
 * Worked by hand (and asserted in `demo/reorder.test.ts` and
 * `e2e/reorder.spec.ts`), over the default last seven days: 20 units in
 * stock, 25 sold, 3 products out of stock, 24 units to order across 7
 * products.
 */
import { buildCode } from "@gg/shared"

import type { StockItemRecord } from "@/lib/api/types"

const DAY_MS = 86_400_000

/**
 * A moment some whole UTC days before this tab opened, at a fixed hour.
 * UTC because the report's days are UTC days (`todayIso`), so a sale
 * "six days ago" is inside the last seven days on any machine.
 */
export function demoDaysAgo(days: number, hour = 11): string {
  const at = new Date(Date.now() - days * DAY_MS)
  at.setUTCHours(hour, 0, 0, 0)
  // Never in the future, whatever the hour is now.
  return (at.getTime() > Date.now() ? new Date() : at).toISOString()
}

const GW = "supplier_gw"
const W40K = "cat_minis_warhammer40000"
const AOS = "cat_minis_ageofsigmar"
const PAINTS = "cat_minis_paints"
const TOOLS = "cat_minis_toolsandhobby"

interface Row {
  id: string
  body: string
  title: string
  code: string
  ean: string
  category: string
  price: number
  cost: number
  target: number
  qty: number
  /** The row sold out: nothing on hand. */
  soldOut?: boolean
  location: string
  createdDaysAgo: number
  updatedDaysAgo: number
}

const ROWS: Row[] = [
  {
    id: "item_gw_cp_sm_1",
    body: "GW001",
    title: "Combat Patrol: Space Marines",
    code: "48-75",
    ean: "5011921171484",
    category: W40K,
    price: 9500,
    cost: 5700,
    target: 4,
    qty: 0,
    soldOut: true,
    location: "loc_storeroom",
    createdDaysAgo: 40,
    updatedDaysAgo: 4,
  },
  {
    id: "item_gw_cp_sm_2",
    body: "GW002",
    title: "Combat Patrol: Space Marines",
    code: "48-75",
    ean: "5011921171484",
    category: W40K,
    price: 9500,
    cost: 5700,
    target: 4,
    qty: 1,
    location: "loc_storeroom",
    createdDaysAgo: 2,
    updatedDaysAgo: 1,
  },
  {
    id: "item_gw_cp_necrons",
    body: "GW003",
    title: "Combat Patrol: Necrons",
    code: "49-41",
    ean: "5011921181209",
    category: W40K,
    price: 9500,
    cost: 5700,
    target: 3,
    qty: 0,
    soldOut: true,
    location: "loc_storeroom",
    createdDaysAgo: 30,
    updatedDaysAgo: 1,
  },
  {
    id: "item_gw_core_book",
    body: "GW004",
    title: "Warhammer 40,000 Core Book",
    code: "40-01",
    ean: "5011921192014",
    category: W40K,
    price: 6000,
    cost: 3600,
    target: 2,
    qty: 2,
    location: "loc_storeroom",
    createdDaysAgo: 60,
    updatedDaysAgo: 2,
  },
  {
    id: "item_gw_kt_starter",
    body: "GW005",
    title: "Kill Team: Starter Set",
    code: "103-01",
    ean: "5011921205011",
    category: W40K,
    price: 8500,
    cost: 5100,
    target: 0,
    qty: 1,
    location: "loc_storeroom",
    createdDaysAgo: 45,
    updatedDaysAgo: 45,
  },
  {
    id: "item_gw_spearhead_sce",
    body: "GW006",
    title: "Spearhead: Stormcast Eternals",
    code: "70-19",
    ean: "5011921213023",
    category: AOS,
    price: 7500,
    cost: 4500,
    target: 2,
    qty: 1,
    location: "loc_storeroom",
    createdDaysAgo: 25,
    updatedDaysAgo: 5,
  },
  {
    id: "item_gw_vindictors",
    body: "GW007",
    title: "Stormcast Eternals: Vindictors",
    code: "96-50",
    ean: "5011921221035",
    category: AOS,
    price: 3500,
    cost: 2100,
    target: 0,
    qty: 2,
    location: "loc_storeroom",
    createdDaysAgo: 50,
    updatedDaysAgo: 50,
  },
  {
    id: "item_gw_abaddon",
    body: "GW008",
    title: "Citadel Base: Abaddon Black",
    code: "21-25",
    ean: "5011921230044",
    category: PAINTS,
    price: 470,
    cost: 280,
    target: 6,
    qty: 2,
    location: "loc_bin_1",
    createdDaysAgo: 35,
    updatedDaysAgo: 2,
  },
  {
    id: "item_gw_nuln_oil",
    body: "GW009",
    title: "Citadel Shade: Nuln Oil",
    code: "24-14",
    ean: "5011921248056",
    category: PAINTS,
    price: 470,
    cost: 280,
    target: 8,
    qty: 3,
    location: "loc_bin_1",
    createdDaysAgo: 35,
    updatedDaysAgo: 1,
  },
  {
    id: "item_gw_black_templar",
    body: "GW00A",
    title: "Citadel Contrast: Black Templar",
    code: "29-38",
    ean: "5011921257065",
    category: PAINTS,
    price: 600,
    cost: 360,
    target: 6,
    qty: 0,
    soldOut: true,
    location: "loc_bin_1",
    createdDaysAgo: 35,
    updatedDaysAgo: 3,
  },
  {
    id: "item_gw_chaos_black",
    body: "GW00B",
    title: "Citadel Spray: Chaos Black",
    code: "62-02",
    ean: "5011921266074",
    category: PAINTS,
    price: 1500,
    cost: 900,
    target: 3,
    qty: 3,
    location: "loc_storeroom",
    createdDaysAgo: 35,
    updatedDaysAgo: 35,
  },
  {
    id: "item_gw_plastic_glue",
    body: "GW00C",
    title: "Citadel Tools: Plastic Glue",
    code: "66-53",
    ean: "5011921275083",
    category: TOOLS,
    price: 600,
    cost: 360,
    target: 4,
    qty: 5,
    location: "loc_bin_1",
    createdDaysAgo: 35,
    updatedDaysAgo: 0,
  },
  {
    id: "item_gw_base_brush",
    body: "GW00D",
    title: "Citadel Large Base Brush",
    code: "63-05",
    ean: "5011921284092",
    category: TOOLS,
    price: 750,
    cost: 450,
    target: 2,
    qty: 0,
    soldOut: true,
    location: "loc_bin_1",
    createdDaysAgo: 35,
    updatedDaysAgo: 4,
  },
]

/** The rows as `items` holds them. */
export const DEMO_SUPPLIER_STOCK: StockItemRecord[] = ROWS.map((row) => ({
  id: row.id,
  sku: buildCode("other", row.body).encoded,
  kind: "other",
  game: "game_warhammer",
  title: row.title,
  ean: row.ean,
  qty: row.qty,
  cost: row.cost,
  market_at_intake: row.price,
  price: row.price,
  tax_scheme: "standard",
  status: row.soldOut ? "sold" : "in_stock",
  location: row.location,
  source: "supplier",
  category: row.category,
  supplier: GW,
  shelf_target: row.target,
  supplier_code: row.code,
  created: demoDaysAgo(row.createdDaysAgo, 9),
  acquired_at: demoDaysAgo(row.createdDaysAgo, 9),
  updated: demoDaysAgo(row.updatedDaysAgo, 10),
}))

/**
 * Units kept of each row in the last seven days, and one sale outside them.
 * Day 0 is today. The Necrons line of two had one refunded.
 */
export const DEMO_SUPPLIER_SALES: {
  itemId: string
  qty: number
  refunded: number
  daysAgo: number
}[] = [
  { itemId: "item_gw_cp_sm_1", qty: 1, refunded: 0, daysAgo: 10 },
  { itemId: "item_gw_cp_sm_1", qty: 1, refunded: 0, daysAgo: 6 },
  { itemId: "item_gw_cp_sm_1", qty: 1, refunded: 0, daysAgo: 4 },
  { itemId: "item_gw_cp_sm_2", qty: 1, refunded: 0, daysAgo: 1 },
  { itemId: "item_gw_cp_necrons", qty: 2, refunded: 1, daysAgo: 3 },
  { itemId: "item_gw_cp_necrons", qty: 1, refunded: 0, daysAgo: 1 },
  { itemId: "item_gw_core_book", qty: 1, refunded: 0, daysAgo: 2 },
  { itemId: "item_gw_spearhead_sce", qty: 1, refunded: 0, daysAgo: 5 },
  { itemId: "item_gw_abaddon", qty: 2, refunded: 0, daysAgo: 5 },
  { itemId: "item_gw_abaddon", qty: 3, refunded: 0, daysAgo: 2 },
  { itemId: "item_gw_nuln_oil", qty: 2, refunded: 0, daysAgo: 4 },
  { itemId: "item_gw_nuln_oil", qty: 4, refunded: 0, daysAgo: 1 },
  { itemId: "item_gw_black_templar", qty: 2, refunded: 0, daysAgo: 6 },
  { itemId: "item_gw_black_templar", qty: 2, refunded: 0, daysAgo: 3 },
  { itemId: "item_gw_plastic_glue", qty: 2, refunded: 0, daysAgo: 0 },
  { itemId: "item_gw_base_brush", qty: 1, refunded: 0, daysAgo: 4 },
]
