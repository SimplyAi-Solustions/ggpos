/**
 * The demo till: its catalogue, its parked tickets, the receipt email and
 * the voids, answered from memory for the tab like every other demo store.
 *
 * The catalogue is the seed's (docs/api-contract-epos.md, section 4, "The
 * till catalogue"): the five till products on a "Quick" category, plus two
 * dynamic categories listing the stock lines the demo shop holds. Those
 * stock lines are added to the shared demo item store the first time the
 * till asks for its catalogue, so scanning, Stock and the till all see the
 * same shelf, and a screen that never opens the till never sees them.
 */
import { ClientResponseError } from "pocketbase"
import {
  buildCode,
  type TillCatalogue,
  type TillCatalogueItem,
  type TillCatalogueProduct,
  type TillCategory,
  type TillKey,
} from "@gg/shared"

import { DEMO_STAFF } from "@/lib/api/fixtures"
import { findDemoCustomer } from "@/lib/api/demo/customers"
import { demoId, demoSales, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import { PLATFORMS } from "@/design/platforms"
import { boxArt } from "@/kit/placeholder-art"
import type { StockItemRecord } from "@/lib/api/types"

// ---------------------------------------------------------------------------
// Till products
// ---------------------------------------------------------------------------

export interface DemoTillProduct extends TillCatalogueProduct {
  barcode: string
  vat_rate: number
  membership_tier: string
  membership_months: number
  active: boolean
}

/** The seed's five, at the seed's prices and schemes. */
export const DEMO_TILL_PRODUCTS: DemoTillProduct[] = [
  {
    id: "product_single_card",
    name: "Single card",
    kind: "open_price",
    price: 0,
    open_price: true,
    image_url: "",
    tax_scheme: "margin",
    barcode: "",
    vat_rate: 20,
    membership_tier: "",
    membership_months: 0,
    active: true,
  },
  {
    id: "product_table_time",
    name: "Table time, 1 hour",
    kind: "service",
    price: 500,
    open_price: false,
    image_url: "",
    tax_scheme: "standard",
    barcode: "",
    vat_rate: 20,
    membership_tier: "",
    membership_months: 0,
    active: true,
  },
  {
    id: "product_event_entry",
    name: "Event entry",
    kind: "open_price",
    price: 0,
    open_price: true,
    image_url: "",
    tax_scheme: "standard",
    barcode: "",
    vat_rate: 20,
    membership_tier: "",
    membership_months: 0,
    active: true,
  },
  {
    id: "product_deposit",
    name: "Deposit",
    kind: "deposit",
    price: 0,
    open_price: true,
    image_url: "",
    tax_scheme: "exempt",
    barcode: "",
    vat_rate: 0,
    membership_tier: "",
    membership_months: 0,
    active: true,
  },
  {
    id: "product_guild_membership",
    name: "Guild Membership, 12 months",
    kind: "membership",
    price: 2400,
    open_price: false,
    image_url: "",
    tax_scheme: "standard",
    barcode: "",
    vat_rate: 20,
    membership_tier: "tier_pass",
    membership_months: 12,
    active: true,
  },
]

export function demoProduct(id: string): DemoTillProduct | undefined {
  return DEMO_TILL_PRODUCTS.find((product) => product.id === id)
}

function toProduct(product: DemoTillProduct): TillCatalogueProduct {
  return {
    id: product.id,
    name: product.name,
    kind: product.kind,
    price: product.price,
    open_price: product.open_price,
    image_url: product.image_url,
    tax_scheme: product.tax_scheme,
  }
}

// ---------------------------------------------------------------------------
// The demo shelf's stock lines
// ---------------------------------------------------------------------------

const SEALED_ART = boxArt(PLATFORMS.etb.ratio)
const ACCESSORY_ART = boxArt(PLATFORMS.other.ratio)

/** Sealed product and accessories, one row per stock line with a quantity. */
const STOCK_LINES: StockItemRecord[] = [
  {
    id: "item_demo_line_1",
    sku: buildCode("sealed", "B8P2K").encoded,
    kind: "sealed",
    game: "game_pokemon",
    title: "Prismatic Evolutions Booster Pack",
    ean: "0820650859007",
    qty: 36,
    cost: 360,
    price: 549,
    tax_scheme: "standard",
    status: "in_stock",
    location: "loc_storeroom",
    source: "supplier",
  },
  {
    id: "item_demo_line_2",
    sku: buildCode("sealed", "C4N7R").encoded,
    kind: "sealed",
    game: "game_pokemon",
    title: "Stellar Crown Booster Bundle",
    ean: "0820650858253",
    qty: 4,
    cost: 1850,
    price: 2799,
    tax_scheme: "standard",
    status: "in_stock",
    location: "loc_storeroom",
    source: "supplier",
  },
  {
    id: "item_demo_line_3",
    sku: buildCode("sealed", "D6Q3V").encoded,
    kind: "sealed",
    game: "game_mtg",
    title: "Foundations Play Booster",
    ean: "0195166253250",
    qty: 24,
    cost: 330,
    price: 499,
    tax_scheme: "standard",
    status: "in_stock",
    location: "loc_storeroom",
    source: "supplier",
  },
  {
    id: "item_demo_line_4",
    sku: buildCode("accessory", "E2W9H").encoded,
    kind: "accessory",
    game: "game_pokemon",
    title: "Matte sleeves, black, 100",
    ean: "5706569110017",
    qty: 12,
    cost: 520,
    price: 999,
    tax_scheme: "standard",
    status: "in_stock",
    location: "loc_storeroom",
    source: "supplier",
  },
  {
    id: "item_demo_line_5",
    sku: buildCode("accessory", "F5J8T").encoded,
    kind: "accessory",
    game: "game_pokemon",
    title: "Nine-pocket binder",
    ean: "0074427159753",
    qty: 5,
    cost: 1100,
    price: 1999,
    tax_scheme: "standard",
    status: "in_stock",
    location: "loc_storeroom",
    source: "supplier",
  },
]

const ART: Record<string, string> = {
  item_demo_line_1: SEALED_ART,
  item_demo_line_2: SEALED_ART,
  item_demo_line_3: SEALED_ART,
  item_demo_line_4: ACCESSORY_ART,
  item_demo_line_5: ACCESSORY_ART,
}

let shelved = false

/** Puts the stock lines on the demo shelf, once. */
export function ensureTillStock(): void {
  ensureSeeded()
  if (shelved) return
  shelved = true
  const store = itemStore()
  for (const line of STOCK_LINES) {
    if (!store.some((row) => row.id === line.id)) store.push({ ...line })
  }
}

function toCatalogueItem(item: StockItemRecord): TillCatalogueItem {
  return {
    id: item.id,
    sku: item.sku,
    title: item.title ?? "",
    price: item.price ?? 0,
    qty: item.qty ?? 0,
    image_url: ART[item.id] ?? "",
    kind: item.kind,
    status: item.status ?? "in_stock",
  }
}

/** A stock line's picture, for the demo's own item lookups. */
export function demoStockLineImage(id: string): string | undefined {
  return ART[id]
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

interface DemoCategory {
  id: string
  name: string
  sort: number
  filter: { kinds?: string[] } | null
  keys: { product?: string; item?: string; label?: string }[]
}

const CATEGORIES: DemoCategory[] = [
  {
    id: "category_quick",
    name: "Quick",
    sort: 0,
    filter: null,
    keys: [
      { product: "product_single_card" },
      { product: "product_table_time" },
      { product: "product_event_entry" },
      { item: "item_demo_line_1", label: "Prismatic booster" },
      { item: "item_demo_line_4" },
      { item: "item_demo_sold_1" },
      { product: "product_guild_membership" },
      { product: "product_deposit" },
    ],
  },
  { id: "category_sealed", name: "Sealed", sort: 10, filter: { kinds: ["sealed"] }, keys: [] },
  {
    id: "category_accessories",
    name: "Accessories",
    sort: 20,
    filter: { kinds: ["accessory"] },
    keys: [],
  },
  {
    id: "category_services",
    name: "Services",
    sort: 30,
    filter: null,
    keys: [
      { product: "product_table_time" },
      { product: "product_event_entry" },
      { product: "product_deposit" },
      { product: "product_guild_membership" },
    ],
  },
]

export function demoCatalogue(): TillCatalogue {
  ensureTillStock()
  const store = itemStore()
  const categories: TillCategory[] = CATEGORIES.map((category) => ({
    id: category.id,
    name: category.name,
    sort: category.sort,
    dynamic: category.filter !== null,
    keys: category.keys.flatMap((key, index): TillKey[] => {
      const product = key.product ? demoProduct(key.product) : undefined
      const item = key.item ? store.find((row) => row.id === key.item) : undefined
      if (!product && !item) return []
      return [
        {
          id: `${category.id}_key_${index}`,
          position: index,
          label: key.label ?? "",
          ...(product ? { product: toProduct(product) } : {}),
          ...(item ? { item: toCatalogueItem(item) } : {}),
        },
      ]
    }),
  }))
  return { categories }
}

const PER_PAGE = 40

export function demoCategoryItems(
  categoryId: string,
  query: { q?: string; page?: number } = {}
): { items: TillCatalogueItem[]; page: number; total: number } {
  ensureTillStock()
  const category = CATEGORIES.find((row) => row.id === categoryId)
  const kinds = category?.filter?.kinds ?? []
  const needle = query.q?.trim().toLowerCase() ?? ""
  const matches = itemStore().filter(
    (item) =>
      kinds.includes(item.kind) &&
      item.status === "in_stock" &&
      (item.qty ?? 0) > 0 &&
      (!needle || (item.title ?? "").toLowerCase().includes(needle))
  )
  const page = Math.max(1, query.page ?? 1)
  return {
    items: matches.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(toCatalogueItem),
    page,
    total: matches.length,
  }
}

/** Till products whose name has these words in it. */
export function demoSearchProducts(query: string): TillCatalogueProduct[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return DEMO_TILL_PRODUCTS.filter(
    (product) => product.active && product.name.toLowerCase().includes(needle)
  ).map(toProduct)
}

export function demoProductByBarcode(code: string): TillCatalogueProduct | null {
  const product = DEMO_TILL_PRODUCTS.find((row) => row.active && row.barcode && row.barcode === code)
  return product ? toProduct(product) : null
}

// ---------------------------------------------------------------------------
// Parked tickets
// ---------------------------------------------------------------------------

export interface DemoParkedTicket {
  id: string
  register: string
  label: string
  customer: string
  staff: string
  payload: unknown
  total: number
  item_ids: string[]
  created: string
}

export const demoParkedTickets: DemoParkedTicket[] = []

export function demoListParked(register: string): DemoParkedTicket[] {
  return demoParkedTickets
    .filter((row) => row.register === register)
    .sort((a, b) => b.created.localeCompare(a.created))
}

export function demoPark(
  input: Omit<DemoParkedTicket, "id" | "created" | "staff">
): DemoParkedTicket {
  const label = input.label.trim()
  if (!label) throw new Error("Give the ticket a name so it can be found again.")
  const row: DemoParkedTicket = {
    ...input,
    label: label.slice(0, 60),
    id: demoId("parked"),
    staff: DEMO_STAFF.id,
    created: new Date().toISOString(),
  }
  demoParkedTickets.push(row)
  return row
}

export function demoDeleteParked(id: string): void {
  const index = demoParkedTickets.findIndex((row) => row.id === id)
  if (index < 0) throw new Error("That ticket has already been recalled on another till.")
  demoParkedTickets.splice(index, 1)
}

// ---------------------------------------------------------------------------
// Till events: voids from the sale route and from a cleared ticket
// ---------------------------------------------------------------------------

export interface DemoTillEvent {
  id: string
  kind: "void_line" | "void_ticket"
  amount: number
  detail: { title: string; qty: number; sale?: string }
  staff: string
  created: string
}

export const demoTillEvents: DemoTillEvent[] = []

export function demoRecordVoids(
  kind: DemoTillEvent["kind"],
  lines: { title: string; qty: number; amount: number }[],
  sale?: string
): void {
  for (const line of lines) {
    demoTillEvents.push({
      id: demoId("till_event"),
      kind,
      amount: line.amount,
      detail: { title: line.title, qty: line.qty, ...(sale ? { sale } : {}) },
      staff: DEMO_STAFF.id,
      created: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// The receipt email
// ---------------------------------------------------------------------------

/** "j***@example.co.uk": enough to say where it went, not enough to read it. */
export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@")
  return `${name.charAt(0)}***@${domain}`
}

export function demoEmailReceipt(saleId: string, email?: string): { sent_to: string } {
  ensureSeeded()
  const sale = demoSales.find((row) => row.id === saleId)
  if (!sale) {
    throw new ClientResponseError({
      status: 404,
      response: { code: 404, message: "That sale was not found." },
    })
  }
  const typed = email?.trim()
  if (typed) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) {
      throw new ClientResponseError({
        status: 400,
        response: { code: 400, message: "That email address does not look right. Check it." },
      })
    }
    return { sent_to: maskEmail(typed) }
  }
  const onFile = sale.customer ? findDemoCustomer(sale.customer)?.customer.email : undefined
  if (!onFile) {
    throw new ClientResponseError({
      status: 400,
      response: { code: 400, message: "There is no email address for this sale. Type one in." },
    })
  }
  return { sent_to: maskEmail(onFile) }
}
