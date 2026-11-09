/**
 * Epos Now stock sync: the testable part.
 *
 * Two jobs, both run by deploy/mac/epos-stock-sync.mjs:
 *
 * 1. Products. Drain `epos_product_queue`: make each Vault item that is on
 *    the shelf an Epos Now product (Barcode = the Vault SKU as printed on the
 *    label, Sku = "GGV-" + the Vault SKU), keep it up to date, and archive it
 *    (IsArchived true; Epos Now products are never deleted) when the item
 *    leaves the shelf.
 *
 * 2. Sales. Pull today's (and, until it is settled, yesterday's) completed
 *    till transactions, pick out the lines whose ProductId belongs to a Vault
 *    item, and hand each to POST /api/vault/epos/sales/apply, which logs it in
 *    epos_sales_log and applies it once (a unique index on transaction and
 *    line). Refunds are logged and flagged, never applied.
 *
 * The ownership rule, because hundreds of Epos Now products belong to the
 * shop's other processes: the worker only ever changes a product whose id is
 * recorded on a Vault item (or on its queue row) AND whose Sku is exactly
 * "GGV-" + that item's SKU, checked against Epos Now right before the change.
 * Anything else is refused and left for a person.
 *
 * The duplicate rule, because a create cannot be undone: before any create
 * the worker lists Epos Now products and adopts one that already carries the
 * Sku; a row is set to `sending` and that write confirmed BEFORE the create;
 * a create whose outcome is unknown (5xx, timeout, dropped connection) goes
 * to needs_check and is never sent again by the worker. An update or an
 * archive sets absolute values, so repeating one is harmless: an unknown
 * outcome there is `failed` and retried.
 *
 * Money: pence to Epos Now pounds through the shared penceToDecimal, pounds
 * back to pence through poundsToPence (the shared parse helper). No float
 * maths.
 */
import { createRequire } from "node:module"

import { classify, poundsToPence, redact } from "./epos-credit.mjs"

const require = createRequire(import.meta.url)
const money = require("../../../pb/pb_hooks/lib/shared/money.js")

export const MAX_ATTEMPTS = 5
export const SKU_PREFIX = "GGV-"
export const DEFAULT_TAX_GROUP = 26457
export const PRODUCT_PAGE_SIZE = 200
export const NAME_MAX = 100
const MAX_PAGES = 100
const SELLABLE = new Set(["in_stock", ""])

// --- small helpers -------------------------------------------------------

/** A field off an Epos record, which may come back PascalCase or camelCase. */
export function field(rec, name) {
  if (!rec || typeof rec !== "object") return undefined
  if (name in rec) return rec[name]
  const camel = name[0].toLowerCase() + name.slice(1)
  return rec[camel]
}

function first(json) {
  if (Array.isArray(json)) return json.length > 0 ? json[0] : null
  return json && typeof json === "object" ? json : null
}

function idOf(rec) {
  const n = Number(field(rec, "Id"))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The Sku the Vault gives its own products. */
export function ownedSku(vaultSku) {
  const sku = String(vaultSku || "").trim()
  if (!sku) throw new Error("The item has no SKU")
  return SKU_PREFIX + sku
}

/**
 * The ownership guard. True only when the Epos product carries exactly the
 * Sku the Vault would have given this item.
 */
export function isOwned(product, vaultSku) {
  if (!product || !vaultSku) return false
  return String(field(product, "Sku") ?? "") === ownedSku(vaultSku)
}

const DEC = "__GGDEC__"

/** Pence as an Epos pounds amount, placed as a bare JSON number by bodyJson. */
export function pounds(pence) {
  if (!Number.isSafeInteger(pence) || pence < 0) throw new Error(`Not whole pence: ${pence}`)
  return DEC + money.penceToDecimal(pence)
}

/** JSON text with every pounds() value written as a bare decimal, never a float. */
export function bodyJson(value) {
  return JSON.stringify(value).replace(new RegExp(`"${DEC}(\\d+\\.\\d{2})"`, "g"), "$1")
}

/** What the till shows: the title, plus the grade for a slab. */
export function productName(item) {
  let name = String(item.title || "").trim() || "Vault item"
  if (item.kind === "graded") {
    const grade = [item.grade_company, item.grade].filter(Boolean).join(" ").trim()
    if (grade && !name.toLowerCase().includes(grade.toLowerCase())) name = `${name} ${grade}`
  }
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX).trim() : name
}

/** settings.epos_category_map and epos_tax_group_id, cleaned. */
export function readSettings(row) {
  const raw = (row && row.epos_category_map) || {}
  const map = { default: 0, game: {}, kind: {} }
  const int = (v) => {
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0 ? n : 0
  }
  map.default = int(raw.default)
  for (const part of ["game", "kind"]) {
    for (const [k, v] of Object.entries(raw[part] || {})) if (int(v)) map[part][k] = int(v)
  }
  const tax = int(row && row.epos_tax_group_id)
  return { taxGroupId: tax || DEFAULT_TAX_GROUP, map }
}

/** The Epos CategoryId for an item: its kind, else its game, else the default. */
export function categoryFor(item, gameKey, map) {
  return map.kind[item.kind] || (gameKey && map.game[gameKey]) || map.default || 0
}

class RowError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message)
    this.permanent = permanent
  }
}

/**
 * The product fields for an item. Throws RowError (permanent) when the item
 * cannot go on the till as it stands.
 */
export function productFields(item, gameKey, settings) {
  const price = Number(item.price)
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new RowError("No sticker price. Set a price in the Vault and it will sync.", { permanent: true })
  }
  const cost = Number.isSafeInteger(Number(item.cost)) && Number(item.cost) > 0 ? Number(item.cost) : 0
  const categoryId = categoryFor(item, gameKey, settings.map)
  if (!categoryId) {
    throw new RowError(
      `No Epos Now category for ${gameKey || "this game"} or ${item.kind || "this kind"}. Set one under Stock, Epos Now.`,
      { permanent: true }
    )
  }
  return {
    Name: productName(item),
    Barcode: String(item.sku),
    Sku: ownedSku(item.sku),
    SalePrice: pounds(price),
    CostPrice: pounds(cost),
    EatOutPrice: pounds(price),
    CategoryId: categoryId,
    SalePriceTaxGroupId: settings.taxGroupId,
    CostPriceTaxGroupId: settings.taxGroupId,
    IsSalePriceIncTax: true,
    IsCostPriceIncTax: true,
    ProductType: 0,
    SellOnTill: true,
    IsArchived: false,
  }
}

/** The archive body: the required fields as Epos has them, plus IsArchived. */
export function archiveBody(product) {
  const id = idOf(product)
  const sale = field(product, "SalePrice")
  return [
    {
      Id: id,
      Name: field(product, "Name"),
      SalePrice: sale,
      CostPrice: field(product, "CostPrice") ?? 0,
      EatOutPrice: field(product, "EatOutPrice") ?? sale,
      IsArchived: true,
    },
  ]
}

// --- PocketBase writes ----------------------------------------------------

async function retry(fn) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

const setRow = (deps, row, patch) => retry(() => deps.pb.updateRow(row.id, patch))

// --- Epos product list (for the duplicate check) ---------------------------

/** Every Epos Now product, indexed by Sku and by Barcode. One GET per 200. */
export async function scanProducts(deps) {
  const bySku = new Map()
  const byBarcode = new Map()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = classify(await deps.epos("GET", `v4/Product?page=${page}`))
    if (r.outcome !== "ok") throw new Error(`Could not list Epos Now products (page ${page}, ${r.detail})`)
    if (!Array.isArray(r.json)) throw new Error(`Epos Now product list page ${page} was not a list`)
    for (const p of r.json) {
      const sku = String(field(p, "Sku") ?? "")
      const barcode = String(field(p, "Barcode") ?? "")
      if (sku) bySku.set(sku, [...(bySku.get(sku) || []), p])
      if (barcode) byBarcode.set(barcode, [...(byBarcode.get(barcode) || []), p])
    }
    if (r.json.length < PRODUCT_PAGE_SIZE) return { bySku, byBarcode }
  }
  throw new Error(`Epos Now product list ran past ${MAX_PAGES} pages`)
}

async function fetchProduct(deps, id) {
  const r = classify(await deps.epos("GET", `v4/Product/${id}`))
  if (r.outcome === "ok") {
    const p = first(r.json)
    if (!p || idOf(p) !== id) throw new RowError(`Epos Now returned no product ${id}.`)
    return p
  }
  if (r.code === 404) {
    throw new RowError(`Epos Now has no product ${id}. Clear epos_product_id on the item if it was removed in Back Office.`, {
      permanent: true,
    })
  }
  throw new RowError(`Could not read Epos Now product ${id}: ${r.detail}`)
}

function guard(product, sku, id) {
  if (!isOwned(product, sku)) {
    throw new RowError(
      `Epos Now product ${id} does not carry Sku ${SKU_PREFIX}${sku}, so the Vault will not change it. Check which product this item should use.`,
      { permanent: true }
    )
  }
}

async function setStockLevel(deps, productId, qty, tag) {
  if (!deps.stock) return
  const body = JSON.stringify([{ LocationId: deps.stock.locationId, ProductId: productId, CurrentStock: qty }])
  const r = classify(await deps.epos("POST", `v4/Inventory/${productId}/Update`, body))
  if (r.outcome !== "ok" && r.code !== 201) deps.log(`${tag} stock level not set on Epos Now (${r.detail})`)
}

// --- one queue row ---------------------------------------------------------

/**
 * Take one due row to its next state. ctx carries the run's settings and
 * the product list once fetched. Returns { status, line }.
 */
export async function processRow(row, deps, ctx) {
  const attempts = (Number(row.attempts) || 0) + 1
  let item = null
  if (row.item) item = await deps.pb.getItem(row.item)
  const sku = (item && item.sku) || row.sku || ""
  let productId = Number((item && item.epos_product_id) || row.epos_product_id) || 0
  const action = item && SELLABLE.has(item.status || "") ? "upsert" : "archive"
  const tag = `row=${row.id} item=${row.item || "-"} sku=${sku || "-"} ${action}`

  const fail = async (err) => {
    const permanent = err instanceof RowError && err.permanent
    const message = err instanceof RowError ? err.message : `Worker error before sending: ${redact(err.message)}`
    await setRow(deps, row, { status: "failed", attempts: permanent ? Math.max(attempts, MAX_ATTEMPTS) : attempts, last_error: message })
    return { status: "failed", line: `${tag} failed (attempt ${attempts}): ${message}` }
  }

  const markSending = async (id) => {
    const saved = await setRow(deps, row, { status: "sending", epos_product_id: id, attempts, last_error: "" })
    if (!saved || saved.status !== "sending") throw new Error(`row ${row.id} did not save as sending; nothing was sent`)
  }

  const done = async (id, extra = "") => {
    const now = deps.now().toISOString()
    if (item) await retry(() => deps.pb.updateItem(item.id, { epos_product_id: id, epos_synced_at: now }))
    await setRow(deps, row, { status: "done", epos_product_id: id, synced_at: now, last_error: "" })
    return { status: "done", line: `${tag} done product=${id}${extra}` }
  }

  // ---- archive -----------------------------------------------------------
  if (action === "archive") {
    if (!productId) {
      await setRow(deps, row, { status: "done", last_error: "Nothing on Epos Now to archive." })
      return { status: "done", line: `${tag} done: nothing on Epos Now` }
    }
    let product
    try {
      if (!sku) throw new RowError("No SKU to check the product against.", { permanent: true })
      product = await fetchProduct(deps, productId)
      guard(product, sku, productId)
    } catch (err) {
      return fail(err)
    }
    if (field(product, "IsArchived") === true) {
      await setRow(deps, row, { status: "done", epos_product_id: productId, synced_at: deps.now().toISOString(), last_error: "" })
      return { status: "done", line: `${tag} done: already archived product=${productId}` }
    }
    await markSending(productId)
    const r = classify(await deps.epos("PUT", "v4/Product", bodyJson(archiveBody(product))))
    if (r.outcome === "ok") {
      await setRow(deps, row, { status: "done", synced_at: deps.now().toISOString(), last_error: "" })
      return { status: "done", line: `${tag} done: archived product=${productId}` }
    }
    await setRow(deps, row, { status: "failed", last_error: `Epos Now did not archive product ${productId}: ${r.detail} ${redact(r.body)}`.trim() })
    return { status: "failed", line: `${tag} failed (attempt ${attempts}): ${r.detail}` }
  }

  // ---- upsert ------------------------------------------------------------
  let fields
  let product = null
  try {
    fields = productFields(item, item.expand && item.expand.game ? item.expand.game.key : "", ctx.settings)
    if (productId) {
      product = await fetchProduct(deps, productId)
      guard(product, sku, productId)
    } else {
      if (!ctx.index) {
        try {
          ctx.index = await scanProducts(deps)
        } catch (err) {
          throw new RowError(`${err.message}. Nothing was created; it will try again.`)
        }
      }
      const same = ctx.index.bySku.get(fields.Sku) || []
      if (same.length > 1) {
        throw new RowError(`Several Epos Now products carry Sku ${fields.Sku}. Archive the extras in Back Office.`, { permanent: true })
      }
      if (same.length === 1) {
        product = same[0]
        productId = idOf(product)
        if (!productId) throw new RowError(`An Epos Now product carries Sku ${fields.Sku} but has no id.`, { permanent: true })
        // Adopt it: the create went through on an earlier run.
        await retry(() => deps.pb.updateItem(item.id, { epos_product_id: productId }))
      } else {
        const clash = (ctx.index.byBarcode.get(fields.Barcode) || []).filter((p) => !isOwned(p, sku))
        if (clash.length > 0) {
          throw new RowError(
            `Epos Now product ${idOf(clash[0]) || "?"} already uses barcode ${fields.Barcode} and was not made by the Vault. Nothing was created.`,
            { permanent: true }
          )
        }
      }
    }
  } catch (err) {
    return fail(err)
  }

  if (productId) {
    await markSending(productId)
    const r = classify(await deps.epos("PUT", "v4/Product", bodyJson([{ Id: productId, ...fields }])))
    if (r.outcome === "ok") {
      await setStockLevel(deps, productId, Math.max(0, Number(item.qty) || 1), tag)
      return done(productId)
    }
    await setRow(deps, row, { status: "failed", last_error: `Epos Now did not update product ${productId}: ${r.detail} ${redact(r.body)}`.trim() })
    return { status: "failed", line: `${tag} failed (attempt ${attempts}): ${r.detail}` }
  }

  // A create: sending first, and an unknown outcome is never retried.
  await markSending(0)
  const r = classify(await deps.epos("POST", "v4/Product", bodyJson([fields])))
  if (r.outcome === "ok" || r.code === 201) {
    const created = first(r.json)
    const id = idOf(created)
    if (!id) {
      await setRow(deps, row, {
        status: "needs_check",
        last_error: `Epos Now accepted the create but sent no product id. Find Sku ${fields.Sku} in Back Office, then mark this resolved.`,
      })
      return { status: "needs_check", line: `${tag} NEEDS CHECK: created with no id` }
    }
    ctx.index?.bySku.set(fields.Sku, [{ ...created, Sku: fields.Sku }])
    await setStockLevel(deps, id, Math.max(0, Number(item.qty) || 1), tag)
    return done(id, " (created)")
  }
  if (r.outcome === "rejected" || r.outcome === "not_sent") {
    await setRow(deps, row, { status: "failed", last_error: `Epos Now did not create the product: ${r.detail} ${redact(r.body)}`.trim() })
    return { status: "failed", line: `${tag} failed (attempt ${attempts}): ${r.detail}` }
  }
  await setRow(deps, row, {
    status: "needs_check",
    last_error: `The create may have gone through (${r.detail}). Search Epos Now for Sku ${fields.Sku}, then mark this resolved: the sync adopts a product it finds rather than making another.`,
  })
  return { status: "needs_check", line: `${tag} NEEDS CHECK: ${r.detail}` }
}

// --- categories ------------------------------------------------------------

/** Refresh the cached Epos Now category list when it is older than refreshMs. */
export async function syncCategories(deps, refreshMs) {
  const state = await deps.pb.getState("categories")
  const at = state && state.refreshed_at ? Date.parse(state.refreshed_at) : 0
  if (at && deps.now().getTime() - at < refreshMs) return { refreshed: false }
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = classify(await deps.epos("GET", `v4/Category?page=${page}`))
    if (r.outcome !== "ok" || !Array.isArray(r.json)) {
      deps.log(`categories not refreshed: ${r.detail}`)
      return { refreshed: false }
    }
    for (const c of r.json) {
      const id = idOf(c)
      if (id) items.push({ id, name: String(field(c, "Name") ?? ""), parent_id: Number(field(c, "ParentId")) || null })
    }
    if (r.json.length < PRODUCT_PAGE_SIZE) break
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  await deps.pb.setState("categories", { items, refreshed_at: deps.now().toISOString() })
  return { refreshed: true, count: items.length }
}

// --- sales ----------------------------------------------------------------

const day = (d) => d.toISOString().slice(0, 10)

/** Epos Now times are UTC with no marker. */
export function eposTime(text) {
  if (!text) return ""
  const s = String(text)
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : ""
}

/** Turn one till line into what the apply route takes. */
export function saleLine(txn, ti, index) {
  const tid = idOf(txn)
  const lineId = idOf(ti)
  const rawQty = Number(field(ti, "Quantity"))
  const refundReason = field(ti, "RefundReasonId")
  const refund = (refundReason !== null && refundReason !== undefined && Number(refundReason) !== 0) || rawQty < 0
  const unit = poundsToPence(field(ti, "UnitPrice"))
  const out = {
    transaction_id: String(tid),
    line: lineId ? String(lineId) : `i${index}`,
    product_id: Number(field(ti, "ProductId")) || 0,
    qty: Number.isSafeInteger(rawQty) ? Math.abs(rawQty) : 0,
    unit_price: unit === null ? 0 : Math.abs(unit),
    refund,
    occurred_at: eposTime(field(txn, "DateTime")),
  }
  if (!refund && !Number.isSafeInteger(rawQty)) out.flag = `The till quantity ${field(ti, "Quantity")} is not a whole number. Check it by hand.`
  if (unit === null) out.flag = "The till line had no readable unit price. Check the sale price by hand."
  return out
}

async function fetchDay(deps, date, pageSize) {
  const txns = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = `startDate=${date}T00:00:00&endDate=${date}T23:59:59&status=1&extended=true&page=${page}`
    const r = classify(await deps.epos("GET", `v4/Transaction/GetByDate?${q}`))
    if (r.outcome !== "ok") throw new Error(`Could not read till sales for ${date} (page ${page}, ${r.detail})`)
    const list = r.json === undefined ? [] : r.json
    if (!Array.isArray(list)) throw new Error(`Till sales for ${date} page ${page} were not a list`)
    txns.push(...list)
    if (list.length < pageSize) return txns
  }
  throw new Error(`Till sales for ${date} ran past ${MAX_PAGES} pages`)
}

/**
 * Pull and apply till sales, at most every everyMs. Yesterday is pulled
 * until a pull made 2 hours or more into today has gone through cleanly.
 */
export async function syncSales(deps, { everyMs, pageSize = 200 }) {
  const counts = { lines: 0, applied: 0, duplicate: 0, flagged: 0, errors: 0, polled: false }
  const state = (await deps.pb.getState("sales")) || {}
  const now = deps.now()
  if (state.last_polled_at && now.getTime() - Date.parse(state.last_polled_at) < everyMs) return counts
  counts.polled = true

  const today = day(now)
  const yesterday = day(new Date(now.getTime() - 86400000))
  const days = !state.done_through || state.done_through < yesterday ? [yesterday, today] : [today]

  const lines = []
  try {
    for (const d of days) {
      for (const txn of await fetchDay(deps, d, pageSize)) {
        if (!idOf(txn)) continue
        const tis = field(txn, "TransactionItems") || []
        tis.forEach((ti, i) => lines.push(saleLine(txn, ti, i)))
      }
    }
  } catch (err) {
    counts.errors++
    deps.log(`sales: ${redact(err.message)}; nothing applied, it will try again`)
    return counts
  }

  const ids = [...new Set(lines.map((l) => l.product_id).filter((n) => n > 0))]
  const owned = new Set()
  for (let i = 0; i < ids.length; i += 50) {
    for (const it of await deps.pb.findItemsByProductIds(ids.slice(i, i + 50))) owned.add(Number(it.epos_product_id))
  }

  for (const line of lines) {
    if (!owned.has(line.product_id)) continue
    counts.lines++
    try {
      const res = await retry(() => deps.pb.applySale(line))
      const result = res && res.result
      if (result === "applied") counts.applied++
      else if (result === "duplicate") counts.duplicate++
      else counts.flagged++
      if (result !== "duplicate") {
        deps.log(`sale txn=${line.transaction_id} line=${line.line} product=${line.product_id} qty=${line.qty} ${money.formatGBP(line.unit_price)}${line.refund ? " refund" : ""}: ${result}`)
      }
    } catch (err) {
      counts.errors++
      deps.log(`sale txn=${line.transaction_id} line=${line.line} not applied: ${redact(err.message)}`)
    }
  }

  const settled = days.includes(yesterday) && counts.errors === 0 && now.getUTCHours() >= 2
  await deps.pb.setState("sales", {
    last_polled_at: now.toISOString(),
    done_through: settled ? yesterday : state.done_through || null,
    last_days: days,
  })
  return counts
}

// --- one run -----------------------------------------------------------------

/**
 * One run. deps:
 *   pb.listSending(), pb.listDue(max), pb.listNeedsCheck(), pb.getItem(id),
 *   pb.getSettings(), pb.updateRow(id, patch), pb.updateItem(id, patch),
 *   pb.getState(key), pb.setState(key, value), pb.findItemsByProductIds(ids),
 *   pb.applySale(line)
 *   epos(method, path, body?), log(line), now()
 *   stock?: { locationId }   set Epos stock levels (off unless given)
 *   salesEveryMs, categoryRefreshMs
 */
export async function runOnce(deps) {
  const counts = { done: 0, failed: 0, needs_check: 0, stuck: 0, held: 0, errors: 0, sales: null }

  // A row left in sending: a create may have gone through (needs_check);
  // an update or archive is safe to repeat (failed, retried).
  for (const row of await deps.pb.listSending()) {
    const create = !(Number(row.epos_product_id) > 0)
    await setRow(deps, row, create
      ? { status: "needs_check", last_error: `Found in sending when the worker started: the create may have gone through. Search Epos Now for Sku ${SKU_PREFIX}${row.sku}, then mark this resolved.` }
      : { status: "failed", last_error: "Found in sending when the worker started; the update will be sent again." })
    counts.stuck++
    deps.log(`row=${row.id} sku=${row.sku} ${create ? "NEEDS CHECK: create was left in sending" : "update was left in sending; retrying"}`)
  }

  const blocked = new Set((await deps.pb.listNeedsCheck()).map((r) => r.item).filter(Boolean))
  const due = await deps.pb.listDue(MAX_ATTEMPTS)
  if (due.length > 0) {
    const ctx = { settings: readSettings(await deps.pb.getSettings()), index: null }
    const seen = new Set()
    for (const row of due) {
      // One row per item per run, and none while the item waits for a person.
      if (row.item && (blocked.has(row.item) || seen.has(row.item))) {
        counts.held++
        continue
      }
      if (row.item) seen.add(row.item)
      try {
        const res = await processRow(row, deps, ctx)
        if (res.status === "done") counts.done++
        else if (res.status === "failed") counts.failed++
        else counts.needs_check++
        deps.log(res.line)
      } catch (err) {
        counts.errors++
        deps.log(`row=${row.id} sku=${row.sku} skipped: ${redact(err.message)}`)
      }
    }
  }

  try {
    await syncCategories(deps, deps.categoryRefreshMs ?? 6 * 3600000)
  } catch (err) {
    deps.log(`categories: ${redact(err.message)}`)
  }
  counts.sales = await syncSales(deps, { everyMs: deps.salesEveryMs ?? 5 * 60000, pageSize: deps.salesPageSize ?? 200 })

  const waiting = await deps.pb.listNeedsCheck()
  if (waiting.length > 0) {
    deps.log(`NEEDS CHECK: ${waiting.length} Epos product row(s) need a person: ${waiting.map((r) => r.id).join(", ")}. See Stock, Epos Now in the Vault.`)
  }
  return { ...counts, needs_check_total: waiting.length }
}
