/**
 * Every call the Stock feature makes. Screens use the hooks at the bottom,
 * never `pb` directly. Money is integer pence in and out.
 *
 * Routes (pb/pb_hooks/vault_stock.pb.js):
 *   GET  /api/vault/stock/inventory
 *   POST /api/vault/stock/reprice
 *   POST /api/vault/stock/proposals/decide
 *   GET  /api/vault/stock/items/{id}/epos      (pb_hooks/epos_products.pb.js)
 *   GET  /api/vault/stock/epos, POST /api/vault/stock/epos/settings,
 *   POST /api/vault/stock/epos/resolve
 * Plus the existing GET /api/vault/cards/{id}/prices and
 * POST /api/vault/imports/card-uploader, and the collection API for items,
 * locations, games, categories, stock_print_list, sell_price_rules,
 * price_proposals and item_price_changes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"

import type { SellRule } from "./pricing/rules"
import type { CategoryOption, InventoryItem, ItemKind, NamedRecord } from "./types"

export const STOCK_KEY = ["stock"] as const
const INVENTORY_KEY = [...STOCK_KEY, "inventory"] as const

function quote(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

/** The server's own sentence when it sent one, else `fallback`. */
export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ClientResponseError) {
    const message = (error.response as { message?: string } | undefined)?.message
    if (message && error.status < 500 && !/^Something went wrong/i.test(message)) return message
  }
  if (error instanceof Error && error.name === "LabelPrinterError") return error.message
  return fallback
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchInventory(): Promise<InventoryItem[]> {
  const res = await pb.send<{ items: InventoryItem[] }>("/api/vault/stock/inventory", { method: "GET" })
  return res.items
}

export function useInventory() {
  return useQuery({ queryKey: INVENTORY_KEY, queryFn: fetchInventory })
}

export function useLookups() {
  return useQuery({
    queryKey: [...STOCK_KEY, "lookups"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [locations, games, categories] = await Promise.all([
        pb.collection("locations").getFullList<NamedRecord & { sort?: number }>({ sort: "sort,name", fields: "id,name,sort" }),
        pb.collection("games").getFullList<NamedRecord>({ sort: "name", fields: "id,name" }),
        pb
          .collection("categories")
          .getFullList<CategoryOption & { depth?: number }>({ sort: "path", fields: "id,name,path,depth" })
          .catch(() => [] as CategoryOption[]),
      ])
      return { locations, games, categories }
    },
  })
}

export interface PriceChange {
  id: string
  old_price: number
  new_price: number
  source: "manual" | "rule" | "import" | "bulk"
  created: string
  expand?: { staff?: { name?: string } }
}

export function usePriceHistory(itemId: string | undefined) {
  return useQuery({
    queryKey: [...STOCK_KEY, "history", itemId],
    enabled: Boolean(itemId),
    queryFn: () =>
      pb.collection("item_price_changes").getFullList<PriceChange>({
        filter: `item = "${quote(itemId ?? "")}"`,
        sort: "-created",
        expand: "staff",
      }),
  })
}

/**
 * What the inventory feed leaves out: where the item came from (the deal
 * line it was bought on, through items.trade_in_line), the value captured
 * at intake, and the Epos Now product id if the sync has stamped one.
 */
export interface ItemOrigin {
  source: "" | "trade_in" | "supplier" | "opening_stock"
  supplier_ref: string
  market_at_intake: number
  acquired_at: string
  /** The Epos Now product the sync made for this item, "" when none. */
  epos_product_id: string
  deal: null | {
    id: string
    number: string
    completed_at: string
    created: string
    payout_type: string
    /** What the line was bought at, all units, pence. */
    line_offer: number
    line_qty: number
  }
}

interface ItemOriginRecord {
  source?: ItemOrigin["source"]
  supplier_ref?: string
  market_at_intake?: number
  acquired_at?: string
  epos_product_id?: number | string
  expand?: {
    trade_in_line?: {
      offer_price?: number
      qty?: number
      expand?: {
        trade_in?: { id: string; number?: string; completed_at?: string; created?: string; payout_type?: string }
      }
    }
  }
}

export function toItemOrigin(record: ItemOriginRecord): ItemOrigin {
  const line = record.expand?.trade_in_line
  const deal = line?.expand?.trade_in
  return {
    source: record.source ?? "",
    supplier_ref: record.supplier_ref ?? "",
    market_at_intake: record.market_at_intake ?? 0,
    acquired_at: record.acquired_at ?? "",
    epos_product_id: record.epos_product_id ? String(record.epos_product_id) : "",
    deal: deal
      ? {
          id: deal.id,
          number: deal.number ?? "",
          completed_at: deal.completed_at ?? "",
          created: deal.created ?? "",
          payout_type: deal.payout_type ?? "",
          line_offer: line?.offer_price ?? 0,
          line_qty: line?.qty ?? 1,
        }
      : null,
  }
}

export function useItemOrigin(itemId: string | undefined) {
  return useQuery({
    queryKey: [...STOCK_KEY, "origin", itemId],
    enabled: Boolean(itemId),
    queryFn: async () =>
      toItemOrigin(
        await pb.collection("items").getOne<ItemOriginRecord>(itemId ?? "", { expand: "trade_in_line.trade_in" })
      ),
  })
}

/** A card from the catalogue, for Add stock's ?card=. */
export interface CatalogueCard {
  id: string
  name: string
  number: string
  game: string
  image: string
  setCode: string
  setName: string
  /** NM, UK-first, condition adjusted, pence. Null when nothing is on file. */
  nmPrice: number | null
}

interface CardRecord {
  id: string
  name: string
  number: string
  game: string
  image_small?: string
  image_large?: string
  image_file?: string
  expand?: { set?: { code?: string; name?: string } }
}

function cardImage(card: CardRecord): string {
  if (card.image_file) return pb.files.getURL(card as never, card.image_file)
  return card.image_small || card.image_large || ""
}

export async function conditionPrice(cardId: string, condition: string, finish = ""): Promise<number | null> {
  try {
    const res = await pb.send<{ chosen: { gbp_market?: number } | null; condition_adjusted: number | null }>(
      `/api/vault/cards/${encodeURIComponent(cardId)}/prices`,
      { method: "GET", query: { condition, finish } }
    )
    return res.condition_adjusted ?? res.chosen?.gbp_market ?? null
  } catch {
    return null
  }
}

export async function fetchCard(cardId: string): Promise<CatalogueCard> {
  const card = await pb.collection("cards").getOne<CardRecord>(cardId, { expand: "set" })
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    game: card.game,
    image: cardImage(card),
    setCode: card.expand?.set?.code ?? "",
    setName: card.expand?.set?.name ?? "",
    nmPrice: await conditionPrice(card.id, "NM"),
  }
}

export function useCard(cardId: string | undefined) {
  return useQuery({
    queryKey: [...STOCK_KEY, "card", cardId],
    enabled: Boolean(cardId),
    queryFn: () => fetchCard(cardId ?? ""),
  })
}

export async function searchCards(q: string): Promise<CatalogueCard[]> {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)
  if (words.length === 0) return []
  const filter = words.map((w) => `(name ~ "${quote(w)}" || number = "${quote(w)}" || search_text ~ "${quote(w)}")`).join(" && ")
  const res = await pb.collection("cards").getList<CardRecord>(1, 12, { filter, expand: "set", sort: "name" })
  return res.items.map((card) => ({
    id: card.id,
    name: card.name,
    number: card.number,
    game: card.game,
    image: cardImage(card),
    setCode: card.expand?.set?.code ?? "",
    setName: card.expand?.set?.name ?? "",
    nmPrice: null,
  }))
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewItemInput {
  kind: ItemKind
  game: string
  card?: string
  title?: string
  set_code?: string
  number?: string
  condition?: string
  qty: number
  cost: number
  price: number
  location?: string
  market_at_intake?: number | null
  ean?: string
}

export async function createItem(input: NewItemInput): Promise<{ id: string; sku: string }> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    game: input.game,
    qty: Math.max(1, Math.floor(input.qty)),
    cost: input.cost,
    price: input.price,
    status: "in_stock",
    acquired_at: new Date().toISOString(),
  }
  if (input.card) body.card = input.card
  if (input.title) body.title = input.title
  if (input.set_code) body.set_code = input.set_code
  if (input.number) body.number = input.number
  if (input.condition) body.condition = input.condition
  if (input.location) body.location = input.location
  if (input.ean) body.ean = input.ean
  if (input.market_at_intake) body.market_at_intake = input.market_at_intake
  const record = await pb.collection("items").create<{ id: string; sku: string }>(body)
  return { id: record.id, sku: record.sku }
}

export interface ItemPatch {
  title?: string
  condition?: string
  qty?: number
  cost?: number
  location?: string
  notes?: string
  /** Only the soft removal: the row stays, with its history, off the shelf. */
  status?: "written_off"
}

export async function updateItem(id: string, patch: ItemPatch): Promise<void> {
  await pb.collection("items").update(id, patch)
}

export async function reprice(
  changes: { item: string; price: number }[],
  source: "manual" | "bulk" | "import" = "manual"
): Promise<{ changed: number; unchanged: number }> {
  return pb.send("/api/vault/stock/reprice", { method: "POST", body: { changes, source } })
}

export async function moveItems(ids: readonly string[], location: string): Promise<void> {
  for (const id of ids) await pb.collection("items").update(id, { location })
}

// ---------------------------------------------------------------------------
// The print list
// ---------------------------------------------------------------------------

export type PrintStatus = "to_print" | "printed" | "needs_reprint"

export interface PrintEntry {
  id: string
  item: string
  status: PrintStatus
  copies: number
  printed_at: string
  updated: string
}

export function usePrintList() {
  return useQuery({
    queryKey: [...STOCK_KEY, "print-list"],
    queryFn: () => pb.collection("stock_print_list").getFullList<PrintEntry>({ sort: "-updated" }),
  })
}

/** Adds items to To print, or puts them back there if already listed. */
export async function addToPrintList(items: readonly Pick<InventoryItem, "id" | "qty">[]): Promise<number> {
  const existing = await pb.collection("stock_print_list").getFullList<PrintEntry>({ fields: "id,item" })
  const byItem = new Map(existing.map((entry) => [entry.item, entry.id]))
  for (const item of items) {
    const copies = Math.min(160, Math.max(1, item.qty))
    const id = byItem.get(item.id)
    if (id) await pb.collection("stock_print_list").update(id, { status: "to_print", copies })
    else await pb.collection("stock_print_list").create({ item: item.id, status: "to_print", copies, added_by: pb.authStore.record?.id })
  }
  return items.length
}

export async function markPrinted(entries: readonly PrintEntry[]): Promise<void> {
  const at = new Date().toISOString()
  for (const entry of entries) {
    await pb.collection("stock_print_list").update(entry.id, { status: "printed", printed_at: at })
    await pb.collection("items").update(entry.item, { label_printed_at: at }).catch(() => undefined)
  }
}

export async function setPrintStatus(entries: readonly PrintEntry[], status: PrintStatus): Promise<void> {
  for (const entry of entries) await pb.collection("stock_print_list").update(entry.id, { status })
}

export async function removeFromPrintList(entries: readonly PrintEntry[]): Promise<void> {
  for (const entry of entries) await pb.collection("stock_print_list").delete(entry.id)
}

/** After a single item's label is printed outside the list. */
export async function stampLabelPrinted(itemId: string): Promise<void> {
  const at = new Date().toISOString()
  await pb.collection("items").update(itemId, { label_printed_at: at })
  const entry = await pb
    .collection("stock_print_list")
    .getFirstListItem<PrintEntry>(`item = "${quote(itemId)}"`)
    .catch(() => null)
  if (entry) await pb.collection("stock_print_list").update(entry.id, { status: "printed", printed_at: at })
}

// ---------------------------------------------------------------------------
// Pricing rules and the approval queue
// ---------------------------------------------------------------------------

export type StoredRule = SellRule & { id: string; updated: string }

export function useRules() {
  return useQuery({
    queryKey: [...STOCK_KEY, "rules"],
    queryFn: () => pb.collection("sell_price_rules").getFullList<StoredRule>({ sort: "name" }),
  })
}

export async function saveRule(rule: SellRule): Promise<StoredRule> {
  const { id, ...body } = rule
  if (id) return pb.collection("sell_price_rules").update<StoredRule>(id, body)
  return pb.collection("sell_price_rules").create<StoredRule>({ ...body, created_by: pb.authStore.record?.id })
}

export async function deleteRule(id: string): Promise<void> {
  await pb.collection("sell_price_rules").delete(id)
}

export interface Proposal {
  id: string
  rule: string
  item: string
  old_price: number
  new_price: number
  reason: string
  status: "pending" | "approved" | "rejected"
  created: string
  expand?: { rule?: { name?: string } }
}

export function useProposals() {
  return useQuery({
    queryKey: [...STOCK_KEY, "proposals"],
    queryFn: () =>
      pb.collection("price_proposals").getFullList<Proposal>({ filter: 'status = "pending"', sort: "-created", expand: "rule" }),
  })
}

export async function createProposals(
  ruleId: string | undefined,
  rows: readonly { item: string; old_price: number; new_price: number; reason: string }[]
): Promise<string[]> {
  // An item already waiting is replaced by the newer proposal.
  const pending = await pb.collection("price_proposals").getFullList<Proposal>({ filter: 'status = "pending"', fields: "id,item" })
  const waiting = new Map(pending.map((p) => [p.item, p.id]))
  const ids: string[] = []
  for (const row of rows) {
    const old = waiting.get(row.item)
    if (old) await pb.send("/api/vault/stock/proposals/decide", { method: "POST", body: { ids: [old], decision: "reject" } }).catch(() => undefined)
    const created = await pb.collection("price_proposals").create<Proposal>({
      ...row,
      rule: ruleId || null,
      status: "pending",
      created_by: pb.authStore.record?.id,
    })
    ids.push(created.id)
  }
  return ids
}

export async function decideProposals(
  ids: readonly string[],
  decision: "approve" | "reject"
): Promise<{ approved: number; rejected: number; skipped: number }> {
  return pb.send("/api/vault/stock/proposals/decide", { method: "POST", body: { ids, decision } })
}

// ---------------------------------------------------------------------------
// CSV import (the existing Card Uploader importer)
// ---------------------------------------------------------------------------

export interface ImportResult {
  matched: number
  review: number
  import: { id: string; rows_total: number; rows_ok: number; errors: unknown[] }
}

export async function importCardUploader(file: File): Promise<ImportResult> {
  const form = new FormData()
  form.append("file", file)
  form.append("type", "card_uploader")
  return pb.send<ImportResult>("/api/vault/imports/card-uploader", { method: "POST", body: form })
}

// ---------------------------------------------------------------------------
// Epos Now (the shop Mac worker does the Epos calls; these read its state)
// ---------------------------------------------------------------------------

export type EposItemStatus = "synced" | "waiting" | "needs_check" | "archived" | "none"

export interface EposItem {
  status: EposItemStatus
  message: string
  epos_product_id: number | null
  synced_at: string | null
  last_error?: string | null
  sold_on_till: null | { transaction_id: string; sale_price: number; sold_at: string | null }
}

export function useEposItem(itemId: string | undefined) {
  return useQuery({
    queryKey: [...STOCK_KEY, "epos", itemId],
    enabled: Boolean(itemId),
    queryFn: async () =>
      (await pb.send<{ epos: EposItem }>(`/api/vault/stock/items/${encodeURIComponent(itemId ?? "")}/epos`, { method: "GET" })).epos,
  })
}

export interface EposCategoryMap {
  default: number
  game: Record<string, number>
  kind: Record<string, number>
}

export interface EposCheck {
  kind: "product" | "sale"
  id: string
  item: string | null
  sku: string
  title: string
  message: string
  at: string
  epos_product_id: number | null
  action?: "upsert" | "archive"
  status?: string
  transaction_id?: string
  refund?: boolean
  qty?: number
  unit_price?: number
  /** What the line took after discounts, pence. */
  sale_price?: number
}

export interface EposSettingsView {
  settings: { tax_group_id: number; category_map: EposCategoryMap }
  kinds: string[]
  games: { key: string; name: string }[]
  categories: { id: number; name: string; parent_id: number | null }[]
  categories_refreshed_at: string | null
  sales_polled_at: string | null
  waiting: number
  checks: EposCheck[]
}

export function useEposSettings(enabled = true) {
  return useQuery({
    queryKey: [...STOCK_KEY, "epos-settings"],
    enabled,
    queryFn: () => pb.send<EposSettingsView>("/api/vault/stock/epos", { method: "GET" }),
  })
}

export async function saveEposSettings(body: { tax_group_id: number; category_map: EposCategoryMap }): Promise<{ requeued: number }> {
  return pb.send("/api/vault/stock/epos/settings", { method: "POST", body })
}

export async function resolveEposCheck(check: Pick<EposCheck, "kind" | "id">): Promise<void> {
  await pb.send("/api/vault/stock/epos/resolve", { method: "POST", body: { kind: check.kind, id: check.id } })
}

// ---------------------------------------------------------------------------
// Mutations that refresh the stock views
// ---------------------------------------------------------------------------

export function useStockMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => client.invalidateQueries({ queryKey: STOCK_KEY }),
  })
}
