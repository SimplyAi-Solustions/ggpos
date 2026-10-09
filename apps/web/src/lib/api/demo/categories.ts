/**
 * The demo category tree (docs/api-contract-inventory.md, section 1),
 * answered from memory for the tab like every other demo store.
 *
 * The tree is the shared starter tree (`STARTER_TREE`) with stable demo ids
 * made from each branch's key ("cat_tcg_pokemon_singles"), so a test or a
 * screenshot can name a branch without looking it up. The demo stock is
 * filed the way the migration files real stock, by `fileItem` from its kind
 * and its game's key, the first time anything asks; two rows the rule
 * cannot place sit in Unsorted for the "File these" flow. The till's five
 * demo products are placed the way the migration places the seeded ones.
 *
 * Every route answers with the server's shapes and refuses with the
 * server's sentences, including the manager approval: writes need
 * `stock_manage`, checked against the demo permissions table and spent
 * from the `X-GG-Override` header as the live routes do.
 */
import { ClientResponseError } from "pocketbase"
import {
  UNSORTED_KEY,
  buildCategoryTree,
  buildCode,
  fileItem,
  flattenCategoryTree,
  isWithin,
  moveProblem,
  starterBranches,
  subtreeHeight,
  type CategoryBranch,
  type CategoryKind,
  type CategoryTaxScheme,
  type CategoryTree,
  type TillBranchChip,
} from "@gg/shared"

import { DEMO_GAMES } from "@/lib/api/fixtures"
import { demoRequire } from "@/lib/api/demo/overrides"
import { demoId, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type { StockItemRecord } from "@/lib/api/types"

/** One branch as the demo keeps it: the collection's own fields. */
interface DemoBranchRow {
  id: string
  name: string
  parent: string
  sort: number
  active: boolean
  key: string
  image_url: string
  default_kind: CategoryKind | ""
  default_game: string
  default_platform: string
  default_tax_scheme: CategoryTaxScheme | ""
}

/** The demo id of a seeded branch: "tcg.pokemon.singles" is cat_tcg_pokemon_singles. */
export function demoCategoryId(key: string): string {
  return `cat_${key.replace(/[^a-z0-9]+/gi, "_")}`
}

/** The `platforms` rows the demo answers with: the design table's keys. */
export function demoPlatformId(key: string): string {
  return `platform_${key}`
}

/** Where the migration puts the seeded till products, by their demo ids. */
const PRODUCT_STARTS: Record<string, string> = {
  product_single_card: "tcg",
  product_table_time: "services.tabletime",
  product_event_entry: "services.events",
  product_deposit: "services",
  product_guild_membership: "services.memberships",
}

/**
 * Two shelf rows the filing rule cannot place: a retro cart with no boxed
 * platform to go by, and a plush, which is neither a card nor sealed. The
 * migration would put both in Unsorted, so they wait there for staff.
 */
const UNFILED: StockItemRecord[] = [
  {
    id: "item_demo_unsorted_1",
    sku: buildCode("retro", "K7D2M").encoded,
    kind: "retro",
    game: "game_retro",
    title: "Sonic the Hedgehog 2",
    completeness: "loose",
    region: "PAL",
    qty: 1,
    cost: 450,
    price: 1299,
    tax_scheme: "margin",
    status: "in_stock",
    source: "trade_in",
  },
  {
    id: "item_demo_unsorted_2",
    sku: buildCode("other", "P3N8W").encoded,
    kind: "other",
    game: "game_pokemon",
    title: "Pikachu plush, 20 cm",
    qty: 3,
    cost: 700,
    price: 1499,
    tax_scheme: "standard",
    status: "in_stock",
    source: "supplier",
  },
]

let rows: DemoBranchRow[] | null = null
const productHomes = new Map<string, string>()

function seedRows(): DemoBranchRow[] {
  const games = new Map(DEMO_GAMES.map((game) => [game.key, game.id]))
  const sorts = new Map<string, number>()
  return starterBranches().map(({ branch, parent }) => {
    const position = (sorts.get(parent) ?? 0) + 1
    sorts.set(parent, position)
    const defaults = branch.defaults ?? {}
    return {
      id: demoCategoryId(branch.key),
      name: branch.name,
      parent: parent ? demoCategoryId(parent) : "",
      sort: position * 10,
      active: true,
      key: branch.key,
      image_url: "",
      default_kind: defaults.kind ?? "",
      default_game: defaults.game ? (games.get(defaults.game) ?? "") : "",
      default_platform: defaults.platform ? demoPlatformId(defaults.platform) : "",
      default_tax_scheme: defaults.tax_scheme ?? "",
    }
  })
}

/** The rows, seeded once, with the demo stock filed. */
function store(): DemoBranchRow[] {
  if (!rows) {
    rows = seedRows()
    for (const [product, key] of Object.entries(PRODUCT_STARTS)) {
      productHomes.set(product, demoCategoryId(key))
    }
    ensureSeeded()
    const items = itemStore()
    for (const row of UNFILED) {
      if (!items.some((item) => item.id === row.id)) items.push({ ...row })
    }
  }
  fileDemoItems(rows)
  return rows
}

const GAME_KEYS = new Map(DEMO_GAMES.map((game) => [game.id, game.key]))

/**
 * Every demo stock row with no branch, filed by `fileItem` as the migration
 * and the item-create hook file real ones. Run before every read, because
 * Add stock, the buy-in and the till all add rows to the same store.
 */
function fileDemoItems(list: DemoBranchRow[]): void {
  const byKey = new Map(list.filter((row) => row.key).map((row) => [row.key, row.id]))
  const unsorted = byKey.get(UNSORTED_KEY) ?? ""
  for (const item of itemStore()) {
    if (item.category && list.some((row) => row.id === item.category)) continue
    const key = fileItem({ kind: item.kind, game: GAME_KEYS.get(item.game) ?? "", platform: "" })
    item.category = byKey.get(key) ?? unsorted
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

function refuse(status: number, message: string): never {
  throw new ClientResponseError({ status, response: { code: status, message, data: {} } })
}

function rowById(id: string): DemoBranchRow | undefined {
  return store().find((row) => row.id === id)
}

function mustFind(id: string): DemoBranchRow {
  return rowById(id) ?? refuse(404, "That branch was not found.")
}

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : ""
  if (!name || name.length > 60) refuse(400, "Give the branch a name.")
  return name
}

function checkSiblingName(parent: string, name: string, self?: string): void {
  const clash = store().find(
    (row) =>
      row.parent === parent &&
      row.id !== self &&
      row.name.trim().toLowerCase() === name.toLowerCase()
  )
  if (clash) refuse(400, `There is already a branch called ${name} here.`)
}

// ---------------------------------------------------------------------------
// The tree as the route answers it
// ---------------------------------------------------------------------------

function onShelf(item: StockItemRecord): boolean {
  return (item.status ?? "in_stock") === "in_stock" && (item.qty ?? 1) > 0
}

/** `GET /api/vault/categories/tree`. */
export function demoCategoryTree(): CategoryTree {
  const list = store()
  const nodes = flattenCategoryTree(buildCategoryTree(list))
  const shelf = itemStore().filter(onShelf)
  const ownItems = new Map<string, number>()
  for (const item of shelf) {
    if (item.category) ownItems.set(item.category, (ownItems.get(item.category) ?? 0) + 1)
  }
  const ownProducts = new Map<string, number>()
  for (const home of productHomes.values()) ownProducts.set(home, (ownProducts.get(home) ?? 0) + 1)
  // Each branch's own count goes to every branch above it as well.
  const totals = new Map<string, number>()
  for (const node of nodes) {
    const own = ownItems.get(node.row.id) ?? 0
    if (!own) continue
    for (const id of node.lineage.split("|").filter(Boolean)) {
      totals.set(id, (totals.get(id) ?? 0) + own)
    }
  }
  const branches: CategoryBranch[] = nodes.map((node) => {
    const row = node.row
    return {
      id: row.id,
      name: row.name,
      parent: row.parent,
      path: node.path,
      lineage: node.lineage,
      depth: node.depth,
      sort: row.sort,
      active: row.active,
      visible: node.visible,
      key: row.key,
      image_url: row.image_url,
      defaults: {
        kind: row.default_kind,
        game: row.default_game,
        platform: row.default_platform,
        tax_scheme: row.default_tax_scheme,
      },
      counts: {
        children: node.children.length,
        products: ownProducts.get(row.id) ?? 0,
        items: ownItems.get(row.id) ?? 0,
        items_total: totals.get(row.id) ?? 0,
      },
    }
  })
  return { branches }
}

/** One branch of the answered tree, or undefined. */
export function demoBranch(id: string): CategoryBranch | undefined {
  return demoCategoryTree().branches.find((branch) => branch.id === id)
}

/** Every branch's path by id, worked out once for a page of item rows. */
export function demoCategoryPaths(): Map<string, string> {
  return new Map(
    flattenCategoryTree(buildCategoryTree(store())).map((node) => [node.row.id, node.path])
  )
}

/** Every branch the route counts as inside `id`, itself included. */
export function demoSubtreeIds(id: string): Set<string> {
  return new Set(
    demoCategoryTree()
      .branches.filter((branch) => isWithin(branch.lineage, id))
      .map((branch) => branch.id)
  )
}

/** As a chip or a folder tile: the subtree's shelf count. */
export function chipOf(branch: CategoryBranch): TillBranchChip {
  return {
    id: branch.id,
    name: branch.name,
    image_url: branch.image_url,
    items: branch.counts.items_total,
  }
}

/** `TillCatalogue.branches`: the visible top-level branches in order. */
export function demoTopBranches(): TillBranchChip[] {
  return demoCategoryTree()
    .branches.filter((branch) => branch.depth === 0 && branch.visible)
    .map(chipOf)
}

/** Where a demo till product lives. */
export function demoProductHome(productId: string): string {
  store()
  return productHomes.get(productId) ?? demoCategoryId(UNSORTED_KEY)
}

// ---------------------------------------------------------------------------
// The write routes
// ---------------------------------------------------------------------------

function renumber(parent: string, order: string[]): void {
  const list = store()
  order.forEach((id, index) => {
    const row = list.find((entry) => entry.id === id)
    if (row && row.parent === parent) row.sort = (index + 1) * 10
  })
}

function childIds(parent: string): string[] {
  return flattenCategoryTree(buildCategoryTree(store()))
    .filter((node) => node.row.parent === parent)
    .map((node) => node.row.id)
}

/** `POST /api/vault/categories/{id}/move`. */
export function demoMoveCategory(
  id: string,
  input: { parent: string; before?: string },
  headers: Record<string, string> = {}
): CategoryTree {
  demoRequire("stock_manage", headers)
  const row = mustFind(id)
  const parent = input.parent ?? ""
  const tree = demoCategoryTree().branches
  const into = parent ? tree.find((branch) => branch.id === parent) : null
  if (parent && !into) refuse(400, "That parent branch was not found.")
  const node = flattenCategoryTree(buildCategoryTree(store())).find((entry) => entry.row.id === id)
  const problem = moveProblem(
    id,
    into ? { lineage: into.lineage, depth: into.depth } : null,
    node ? subtreeHeight(node) : 0
  )
  if (problem) refuse(400, problem)
  const siblings = childIds(parent).filter((entry) => entry !== id)
  if (input.before && !siblings.includes(input.before)) {
    refuse(400, "That branch is not under the new parent.")
  }
  if (row.parent !== parent) checkSiblingName(parent, row.name, id)
  row.parent = parent
  const at = input.before ? siblings.indexOf(input.before) : siblings.length
  renumber(parent, [...siblings.slice(0, at), id, ...siblings.slice(at)])
  return demoCategoryTree()
}

/** `POST /api/vault/categories/reorder`. */
export function demoReorderCategories(
  input: { parent: string; order: string[] },
  headers: Record<string, string> = {}
): CategoryTree {
  demoRequire("stock_manage", headers)
  const parent = input.parent ?? ""
  const children = childIds(parent)
  const order = Array.isArray(input.order) ? input.order : []
  const exact =
    order.length === children.length &&
    new Set(order).size === order.length &&
    order.every((id) => children.includes(id))
  if (!exact) refuse(400, "That order does not match the branches here. Reload and try again.")
  renumber(parent, order)
  return demoCategoryTree()
}

/** `POST /api/vault/categories/assign`. */
export function demoAssignCategory(
  input: { category: string; items?: string[]; products?: string[] },
  headers: Record<string, string> = {}
): { items: number; products: number } {
  demoRequire("stock_manage", headers)
  const items = input.items ?? []
  const products = input.products ?? []
  if (items.length + products.length > 500) refuse(400, "File up to 500 at a time.")
  if (!rowById(input.category)) refuse(400, "That branch was not found.")
  const shelf = itemStore()
  const found = items.map((id) => shelf.find((row) => row.id === id))
  if (found.some((row) => !row) || products.some((id) => !productHomes.has(id))) {
    refuse(404, "One of those was not found. Reload and try again.")
  }
  for (const row of found) if (row) row.category = input.category
  for (const id of products) productHomes.set(id, input.category)
  return { items: items.length, products: products.length }
}

export interface DemoBranchInput {
  name?: string
  parent?: string
  active?: boolean
  default_kind?: CategoryKind | ""
  default_game?: string
  default_platform?: string
  default_tax_scheme?: CategoryTaxScheme | ""
  /** A data URL standing in for the uploaded file, or "" to take it off. */
  image_url?: string
}

/** A create through the collection API: name, parent, last among its siblings. */
export function demoCreateCategory(
  input: { name: string; parent: string },
  headers: Record<string, string> = {}
): CategoryBranch {
  demoRequire("stock_manage", headers)
  const name = cleanName(input.name)
  const parent = input.parent ?? ""
  if (parent && !rowById(parent)) refuse(400, "That parent branch was not found.")
  const into = parent ? demoBranch(parent) : null
  if (into && into.depth + 1 >= 8) {
    refuse(400, "Branches go 8 levels deep at most. Put this one higher up.")
  }
  checkSiblingName(parent, name)
  const siblings = store().filter((row) => row.parent === parent)
  const row: DemoBranchRow = {
    id: demoId("cat"),
    name,
    parent,
    sort: Math.max(0, ...siblings.map((entry) => entry.sort)) + 10,
    active: true,
    key: "",
    image_url: "",
    default_kind: "",
    default_game: "",
    default_platform: "",
    default_tax_scheme: "",
  }
  store().push(row)
  return demoBranch(row.id) as CategoryBranch
}

/** An update through the collection API. `key` and the derived fields cannot be set. */
export function demoUpdateCategory(
  id: string,
  input: DemoBranchInput,
  headers: Record<string, string> = {}
): CategoryBranch {
  demoRequire("stock_manage", headers)
  const row = mustFind(id)
  if (input.name !== undefined) {
    const name = cleanName(input.name)
    checkSiblingName(row.parent, name, id)
    row.name = name
  }
  if (input.active === false && row.key === UNSORTED_KEY) {
    refuse(409, "Unsorted is where stock with no branch goes, so it stays.")
  }
  if (input.active !== undefined) row.active = input.active
  if (input.default_kind !== undefined) row.default_kind = input.default_kind
  if (input.default_game !== undefined) row.default_game = input.default_game
  if (input.default_platform !== undefined) row.default_platform = input.default_platform
  if (input.default_tax_scheme !== undefined) row.default_tax_scheme = input.default_tax_scheme
  if (input.image_url !== undefined) row.image_url = input.image_url
  return demoBranch(id) as CategoryBranch
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "A, B and C", "A and B", "A". */
function listed(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** A delete through the collection API: only an empty branch goes. */
export function demoDeleteCategory(id: string, headers: Record<string, string> = {}): void {
  demoRequire("stock_manage", headers)
  const row = mustFind(id)
  if (row.key === UNSORTED_KEY) {
    refuse(409, "Unsorted is where stock with no branch goes, so it stays.")
  }
  const branches = store().filter((entry) => entry.parent === id).length
  const stock = itemStore().filter((item) => item.category === id).length
  const products = [...productHomes.values()].filter((home) => home === id).length
  const parts = [
    branches ? plural(branches, "branch", "branches") : "",
    stock ? plural(stock, "stock row", "stock rows") : "",
    products ? plural(products, "till product", "till products") : "",
  ].filter(Boolean)
  if (parts.length > 0) {
    refuse(
      409,
      `${row.name} still holds ${listed(parts)}. Move them out or switch the branch off.`
    )
  }
  const list = store()
  list.splice(list.indexOf(row), 1)
}

/** The starter tree's size, for the tests. */
export const DEMO_STARTER_SIZE = starterBranches().length

/** Tests only: back to the starter tree, everything filed again. */
export function resetDemoCategories(): void {
  rows = null
  productHomes.clear()
  for (const item of itemStore()) delete item.category
}
