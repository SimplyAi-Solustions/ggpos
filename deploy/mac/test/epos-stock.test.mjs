// node --test deploy/mac/test/
import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequire } from "node:module"

import {
  MAX_ATTEMPTS,
  eposBarcode,
  isEmptyReply,
  lineSalePence,
  bodyJson,
  categoryFor,
  eposTime,
  isOwned,
  pounds,
  productFields,
  productName,
  readSettings,
  runOnce,
  saleLine,
  syncSales,
} from "../lib/epos-stock.mjs"

// --- mocks ------------------------------------------------------------

const out = (code, json) => ({ stdout: `${json === undefined ? "" : JSON.stringify(json)}\nHTTP ${code}\n`, exitCode: 0 })

/** A mock Epos: `script` maps "METHOD path" (prefix match) to a reply, a list of replies or a function. */
function mockEpos(script) {
  const calls = []
  const fn = async (method, path, body) => {
    calls.push({ method, path, body })
    assert.notEqual(method, "DELETE", "the sync must never DELETE")
    const key = Object.keys(script)
      .sort((a, b) => b.length - a.length)
      .find((k) => `${method} ${path}`.startsWith(k))
    if (!key) throw new Error(`unexpected epos call ${method} ${path}`)
    const v = script[key]
    return Array.isArray(v) ? v.shift() : typeof v === "function" ? v(body, path) : v
  }
  fn.calls = calls
  fn.writes = () => calls.filter((c) => c.method !== "GET")
  return fn
}

const SETTINGS = { epos_category_map: { default: 0, game: { pokemon: 516834 }, kind: { graded: 600001 } }, epos_tax_group_id: 0 }

/** An in-memory PocketBase. */
function mockPb({ rows = [], items = {}, settings = SETTINGS, state = {}, failUpdate } = {}) {
  const writes = []
  const applied = new Map()
  const pb = {
    rows: Object.fromEntries(rows.map((r) => [r.id, { attempts: 0, epos_product_id: 0, ...r }])),
    items,
    state,
    writes,
    applied,
    saleCalls: [],
    listSending: async () => Object.values(pb.rows).filter((r) => r.status === "sending"),
    listDue: async (max) => Object.values(pb.rows).filter((r) => r.status === "pending" || (r.status === "failed" && r.attempts < max)),
    listNeedsCheck: async () => Object.values(pb.rows).filter((r) => r.status === "needs_check"),
    getItem: async (id) => items[id] || null,
    getSettings: async () => settings,
    updateRow: async (id, patch) => {
      if (failUpdate && failUpdate(patch)) throw new Error("pocketbase down")
      writes.push({ id, ...patch })
      return Object.assign(pb.rows[id], patch)
    },
    updateItem: async (id, patch) => Object.assign(items[id], patch),
    getState: async (key) => state[key] || null,
    setState: async (key, value) => {
      state[key] = value
    },
    findItemsByProductIds: async (ids) => Object.values(items).filter((i) => ids.includes(Number(i.epos_product_id))),
    // Stands in for POST /api/vault/epos/sales/apply: once per transaction and line.
    applySale: async (line) => {
      pb.saleCalls.push(line)
      const key = `${line.transaction_id}:${line.line}`
      if (applied.has(key)) return { result: "duplicate" }
      applied.set(key, line)
      return { result: line.refund || line.flag ? "flagged" : "applied" }
    },
  }
  return pb
}

const NOW = new Date("2026-11-09T15:00:00Z")
const deps = (pb, epos, extra = {}) => ({ pb, epos, log: () => {}, now: () => NOW, salesEveryMs: 5 * 60000, categoryRefreshMs: 6 * 3600000, ...extra })

const item = (extra = {}) => ({
  id: "i1",
  sku: "GGS7F3K2Q",
  kind: "single",
  title: "Charizard ex #199",
  price: 22999,
  cost: 12000,
  qty: 1,
  status: "in_stock",
  epos_product_id: 0,
  expand: { game: { key: "pokemon" } },
  ...extra,
})
const row = (extra = {}) => ({ id: "q1", item: "i1", sku: "GGS7F3K2Q", action: "upsert", status: "pending", ...extra })
const owned = (extra = {}) => ({ Id: 900, Name: "Charizard ex #199", Sku: "GGV-GGS7F3K2Q", Barcode: "GGS7F3K2Q", SalePrice: 229.99, CostPrice: 120, IsArchived: false, ...extra })
// Background jobs a run also does; quiet unless a test cares.
const quiet = {
  "GET v4/Category": out(200, []),
  "GET v4/Transaction/GetByDate": out(200, []),
  "GET v4/catalogue/Products": out(200, { data: [], metadata: {} }),
}

// --- money ------------------------------------------------------------

test("pence go to Epos as bare decimal pounds, never float maths", () => {
  assert.equal(bodyJson({ SalePrice: pounds(22999), CostPrice: pounds(0), X: pounds(5) }), '{"SalePrice":229.99,"CostPrice":0.00,"X":0.05}')
  assert.equal(bodyJson([{ P: pounds(10) }]), '[{"P":0.10}]')
  assert.throws(() => pounds(12.5))
  assert.throws(() => pounds(-1))
  const f = productFields(item({ price: 1999, cost: 1001 }), "pokemon", readSettings(SETTINGS))
  const body = JSON.parse(bodyJson([f]))[0]
  assert.equal(body.SalePrice, 19.99)
  assert.equal(body.CostPrice, 10.01)
  assert.equal(body.EatOutPrice, 19.99)
})

test("till prices come back to pence through the shared parse helper", () => {
  const txn = { Id: 5, DateTime: "2026-11-09T14:03:00" }
  assert.equal(saleLine(txn, { Id: 1, ProductId: 9, Quantity: 1, UnitPrice: 229.99 }, 0).unit_price, 22999)
  assert.equal(saleLine(txn, { Id: 1, ProductId: 9, Quantity: 1, UnitPrice: 0.1 + 0.2 }, 0).unit_price, 30)
  assert.equal(saleLine(txn, { Id: 1, ProductId: 9, Quantity: 1, UnitPrice: "12.5" }, 0).unit_price, 1250)
  const bad = saleLine(txn, { Id: 1, ProductId: 9, Quantity: 1, UnitPrice: null }, 0)
  assert.equal(bad.unit_price, 0)
  assert.match(bad.flag, /unreadable price/)
  assert.equal(eposTime("2026-11-09T14:03:00"), "2026-11-09T14:03:00.000Z")
})

// --- product fields ------------------------------------------------------

test("the product carries the label barcode, the GGV Sku, the category and the tax group", () => {
  const s = readSettings(SETTINGS)
  assert.equal(s.taxGroupId, 26457, "NoTax by default")
  const f = productFields(item(), "pokemon", s)
  assert.equal(f.Barcode, "GGS7F3K2Q")
  assert.equal(f.Sku, "GGV-GGS7F3K2Q")
  assert.equal(f.CategoryId, 516834)
  assert.equal(f.SalePriceTaxGroupId, 26457)
  assert.equal(f.IsSalePriceIncTax, true)
  assert.equal(f.ProductType, 0)
  assert.equal(f.SellOnTill, true)
  assert.equal(readSettings({ ...SETTINGS, epos_tax_group_id: 26456 }).taxGroupId, 26456)
  // kind wins over game
  assert.equal(categoryFor({ kind: "graded" }, "pokemon", s.map), 600001)
  assert.equal(productName(item({ kind: "graded", grade_company: "PSA", grade: "10" })), "Charizard ex #199 PSA 10")
  assert.throws(() => productFields(item({ price: 0 }), "pokemon", s), /No sticker price/)
  assert.throws(() => productFields(item({ expand: { game: { key: "mtg" } } }), "mtg", s), /No Epos Now category/)
})

// --- creates and the queue -------------------------------------------------

test("a create lists products first, stores sending, then creates and records the id", async () => {
  const items = { i1: item() }
  const pb = mockPb({ rows: [row()], items })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product?page=1": out(200, [{ Id: 1, Sku: "GGE-POK-006", Barcode: "196214157507" }]),
    "POST v4/Product": (body) => {
      assert.equal(pb.rows.q1.status, "sending", "sending is stored before the create")
      assert.equal(pb.rows.q1.epos_product_id, 0)
      const [p] = JSON.parse(body)
      assert.equal(p.Sku, "GGV-GGS7F3K2Q")
      assert.match(body, /"SalePrice":229\.99/)
      return out(201, [{ Id: 777, Sku: "GGV-GGS7F3K2Q" }])
    },
  })
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.done, 1)
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(pb.rows.q1.epos_product_id, 777)
  assert.equal(items.i1.epos_product_id, 777)
  assert.equal(items.i1.epos_synced_at, NOW.toISOString())
  assert.deepEqual(pb.writes.map((w) => w.status), ["sending", "done"])
})

test("an existing GGV product with the Sku is adopted, never created twice", async () => {
  const items = { i1: item() }
  const pb = mockPb({ rows: [row()], items })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product?page=1": out(200, [owned({ Id: 555 })]),
    "PUT v4/Product": (body) => {
      assert.equal(JSON.parse(body)[0].Id, 555)
      return out(200, [owned({ Id: 555 })])
    },
  })
  await runOnce(deps(pb, epos))
  assert.equal(items.i1.epos_product_id, 555)
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, 0)
})

for (const [name, reply] of [
  ["a 500", out(500)],
  ["a curl timeout", { stdout: "\nHTTP 000\n", exitCode: 28 }],
  ["the worker's own timeout", { stdout: "", exitCode: null, timedOut: true }],
]) {
  test(`${name} on a create goes to needs_check and is never sent again`, async () => {
    const pb = mockPb({ rows: [row()], items: { i1: item() } })
    const epos = mockEpos({ ...quiet, "GET v4/Product?page=": out(200, []), "POST v4/Product": () => reply })
    const first = await runOnce(deps(pb, epos))
    assert.equal(first.needs_check, 1)
    assert.equal(pb.rows.q1.status, "needs_check")
    assert.match(pb.rows.q1.last_error, /Search Epos Now for Sku GGV-GGS7F3K2Q/)
    // A later change to the item queues a new row; it is held while the check waits.
    pb.rows.q2 = { id: "q2", item: "i1", sku: "GGS7F3K2Q", action: "upsert", status: "pending", attempts: 0, epos_product_id: 0 }
    const second = await runOnce(deps(pb, epos))
    assert.equal(second.held, 1)
    assert.equal(epos.calls.filter((c) => c.method === "POST").length, 1)
  })
}

test("a 4xx create is failed and retried up to the limit", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() } })
  const epos = mockEpos({ ...quiet, "GET v4/Product?page=": () => out(200, []), "POST v4/Product": () => out(400, { Message: "Bad" }) })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await runOnce(deps(pb, epos))
    assert.equal(pb.rows.q1.status, "failed")
    assert.equal(pb.rows.q1.attempts, i)
  }
  await runOnce(deps(pb, epos))
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, MAX_ATTEMPTS)
})

test("a product list that fails means no create at all", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() } })
  const epos = mockEpos({ ...quiet, "GET v4/Product?page=1": out(503) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "failed")
  assert.equal(pb.rows.q1.attempts, 1)
  assert.equal(epos.writes().length, 0)
})

test("a create left in sending goes to needs_check; an update left in sending is retried", async () => {
  const items = { i1: item({ epos_product_id: 900 }), i2: item({ id: "i2", sku: "GGS0000A1" }) }
  const pb = mockPb({
    rows: [row({ id: "q1", status: "sending", epos_product_id: 900 }), row({ id: "q2", item: "i2", sku: "GGS0000A1", status: "sending", epos_product_id: 0 })],
    items,
  })
  const epos = mockEpos({ ...quiet, "GET v4/Product/900": out(200, owned()), "PUT v4/Product": out(200, [owned()]) })
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.stuck, 2)
  assert.equal(pb.rows.q2.status, "needs_check")
  assert.equal(pb.rows.q1.status, "done", "the update was sent again in the same run")
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, 0)
})

test("if sending cannot be stored, nothing is sent", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() }, failUpdate: (p) => p.status === "sending" })
  const epos = mockEpos({ ...quiet, "GET v4/Product?page=1": out(200, []) })
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.errors, 1)
  assert.equal(epos.writes().length, 0)
  assert.equal(pb.rows.q1.status, "pending")
})

// --- the ownership guard ---------------------------------------------------

test("isOwned needs the exact GGV Sku", () => {
  assert.equal(isOwned(owned(), "GGS7F3K2Q"), true)
  assert.equal(isOwned({ sku: "GGV-GGS7F3K2Q" }, "GGS7F3K2Q"), true, "camelCase replies too")
  assert.equal(isOwned({ Sku: "GGE-POK-006" }, "GGS7F3K2Q"), false)
  assert.equal(isOwned({ Sku: "GGV-GGS7F3K2Q " }, "GGS7F3K2Q"), false)
  assert.equal(isOwned({}, "GGS7F3K2Q"), false)
  assert.equal(isOwned(owned(), ""), false)
})

test("an update to a product the Vault did not create is refused, with no write", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item({ epos_product_id: 42 }) } })
  const epos = mockEpos({ ...quiet, "GET v4/Product/42": out(200, { Id: 42, Name: "Pokemon Pitch Black Booster Pack", Sku: "GGE-POK-006" }) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "failed")
  assert.equal(pb.rows.q1.attempts, MAX_ATTEMPTS, "a guard refusal does not retry")
  assert.match(pb.rows.q1.last_error, /does not carry Sku GGV-GGS7F3K2Q/)
  assert.equal(epos.writes().length, 0)
})

test("an archive of a product the Vault did not create is refused, with no write", async () => {
  const pb = mockPb({ rows: [row({ action: "archive" })], items: { i1: item({ status: "sold", epos_product_id: 42 }) } })
  const epos = mockEpos({ ...quiet, "GET v4/Product/42": out(200, { Id: 42, Sku: "" }) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "failed")
  assert.equal(epos.writes().length, 0)
})

test("a barcode already used by a shop product blocks the create", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() } })
  const epos = mockEpos({ ...quiet, "GET v4/Product?page=1": out(200, [{ Id: 8, Sku: "OTHER", Barcode: "GGS7F3K2Q" }]) })
  await runOnce(deps(pb, epos))
  assert.match(pb.rows.q1.last_error, /already uses barcode GGS7F3K2Q/)
  assert.equal(epos.writes().length, 0)
})

test("an owned product is archived with IsArchived true and its own required fields", async () => {
  const pb = mockPb({ rows: [row({ action: "archive" })], items: { i1: item({ status: "sold", epos_product_id: 900 }) } })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product/900": out(200, owned()),
    "PUT v4/Product": (body) => {
      assert.equal(pb.rows.q1.status, "sending")
      assert.deepEqual(JSON.parse(body), [{ Id: 900, Name: "Charizard ex #199", SalePrice: 229.99, CostPrice: 120, EatOutPrice: 229.99, IsArchived: true }])
      return out(200, [owned({ IsArchived: true })])
    },
  })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
})

test("an archive for an item that never reached Epos makes no call", async () => {
  const pb = mockPb({ rows: [row({ action: "archive" })], items: { i1: item({ status: "written_off" }) } })
  const epos = mockEpos(quiet)
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(epos.calls.filter((c) => c.path.startsWith("v4/Product")).length, 0)
})

test("a deleted item's archive uses the product id and SKU kept on the row", async () => {
  const pb = mockPb({ rows: [row({ item: "", action: "archive", epos_product_id: 900 })], items: {} })
  const epos = mockEpos({ ...quiet, "GET v4/Product/900": out(200, owned()), "PUT v4/Product": out(200, [owned()]) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
})

test("stock levels are only set when switched on", async () => {
  const items = { i1: item({ epos_product_id: 900, qty: 3, kind: "sealed" }) }
  const run = async (stock) => {
    const pb = mockPb({ rows: [row()], items })
    const epos = mockEpos({ ...quiet, "GET v4/Product/900": out(200, owned()), "PUT v4/Product": out(200, [owned()]), "POST v4/Inventory/900/Update": out(200, {}) })
    await runOnce(deps(pb, epos, { stock }))
    return epos.calls.filter((c) => c.path.startsWith("v4/Inventory"))
  }
  assert.equal((await run(null)).length, 0)
  const calls = await run({ locationId: 14037 })
  assert.deepEqual(JSON.parse(calls[0].body), [{ LocationId: 14037, ProductId: 900, CurrentStock: 3 }])
})

// --- sales ----------------------------------------------------------------

const TXNS = [
  {
    Id: 3001,
    DateTime: "2026-11-09T14:03:00",
    TransactionItems: [
      { Id: 1, ProductId: 900, Quantity: 1, UnitPrice: 229.99 },
      { Id: 2, ProductId: 12, Quantity: 2, UnitPrice: 5.99 }, // a shop product, not the Vault's
    ],
  },
  { Id: 3002, DateTime: "2026-11-09T14:10:00", TransactionItems: [{ Id: 3, ProductId: 900, Quantity: -1, UnitPrice: 229.99, RefundReasonId: 4 }] },
]

test("till sales are applied once, however many times they are pulled", async () => {
  const items = { i1: item({ epos_product_id: 900 }) }
  const pb = mockPb({ items })
  const epos = mockEpos({ "GET v4/Transaction/GetByDate": () => out(200, TXNS) })
  const a = await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.equal(a.applied, 1)
  assert.equal(a.flagged, 1, "the refund")
  const b = await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.equal(b.applied, 0)
  assert.equal(b.duplicate, 2)
  assert.equal(pb.applied.size, 2, "one log row per Vault line; the shop product is ignored")
  assert.ok(pb.saleCalls.every((l) => l.product_id === 900))
  const sale = pb.applied.get("3001:1")
  assert.deepEqual(sale, { transaction_id: "3001", line: "1", product_id: 900, qty: 1, unit_price: 22999, sale_price: 22999, refund: false, occurred_at: "2026-11-09T14:03:00.000Z" })
})

test("a refund line is sent flagged as a refund, never as a sale", async () => {
  const pb = mockPb({ items: { i1: item({ epos_product_id: 900 }) } })
  const epos = mockEpos({ "GET v4/Transaction/GetByDate": () => out(200, [TXNS[1]]) })
  await syncSales(deps(pb, epos), { everyMs: 0 })
  const line = pb.applied.get("3002:3")
  assert.equal(line.refund, true)
  assert.equal(line.qty, 1)
  assert.equal(saleLine({ Id: 1 }, { ProductId: 900, Quantity: 1, UnitPrice: 1, RefundReasonId: 2 }, 0).refund, true)
  assert.equal(saleLine({ Id: 1 }, { ProductId: 900, Quantity: 1, UnitPrice: 1, RefundReasonId: null }, 0).refund, false)
  assert.equal(saleLine({ Id: 1 }, { ProductId: 900, Quantity: 1, UnitPrice: 1, RefundReasonId: 0 }, 0).refund, false)
})

test("sales are pulled for yesterday and today, then today only once yesterday is settled", async () => {
  const pb = mockPb({ items: {} })
  const epos = mockEpos({ "GET v4/Transaction/GetByDate": () => out(200, []) })
  await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.deepEqual(epos.calls.map((c) => /startDate=([\d-]+)/.exec(c.path)[1]), ["2026-11-08", "2026-11-09"])
  assert.equal(pb.state.sales.done_through, "2026-11-08")
  epos.calls.length = 0
  await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.deepEqual(epos.calls.map((c) => /startDate=([\d-]+)/.exec(c.path)[1]), ["2026-11-09"])
  // and not again within the poll interval
  epos.calls.length = 0
  await syncSales(deps(pb, epos), { everyMs: 5 * 60000 })
  assert.equal(epos.calls.length, 0)
})

test("a failed page applies nothing and does not move the cursor", async () => {
  const pb = mockPb({ items: { i1: item({ epos_product_id: 900 }) } })
  const epos = mockEpos({ "GET v4/Transaction/GetByDate": [out(200, TXNS), out(500)] })
  const counts = await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.equal(counts.errors, 1)
  assert.equal(pb.saleCalls.length, 0)
  assert.equal(pb.state.sales, undefined)
})

test("a full page fetches the next one", async () => {
  const pb = mockPb({ items: {} })
  const page = Array.from({ length: 3 }, (_, i) => ({ Id: i + 1, TransactionItems: [] }))
  const epos = mockEpos({ "GET v4/Transaction/GetByDate": [out(200, page), out(200, []), out(200, [])] })
  await syncSales(deps(pb, epos), { everyMs: 0, pageSize: 3 })
  assert.equal(epos.calls.length, 3)
})

// --- categories ---------------------------------------------------------

test("the Epos category list is cached for the settings screen", async () => {
  const pb = mockPb()
  const epos = mockEpos({
    "GET v4/Category": out(200, [{ Id: 516834, Name: "Pokemon", ParentId: null }, { Id: 2, Name: "Accessories" }]),
    "GET v4/Transaction/GetByDate": out(200, []),
  })
  await runOnce(deps(pb, epos))
  assert.deepEqual(pb.state.categories.items.map((c) => c.name), ["Accessories", "Pokemon"])
  epos.calls.length = 0
  await runOnce(deps(pb, epos))
  assert.equal(epos.calls.filter((c) => c.path.startsWith("v4/Category")).length, 0, "cached for 6 hours")
})

// --- review fixes: empty replies, archived products, discounts, labels ------

const require = createRequire(import.meta.url)
const sharedSku = require("../../../pb/pb_hooks/lib/shared/sku.js")
const empty = { stdout: "\nHTTP 200\n", exitCode: 0 }

test("an empty body, null, [] or {} is nothing found", () => {
  for (const v of [undefined, null, "", [], {}]) assert.equal(isEmptyReply(v), true)
  for (const v of [[{ Id: 1 }], { Id: 1 }]) assert.equal(isEmptyReply(v), false)
})

for (const [name, reply] of [
  ["an empty body", empty],
  ["null", out(200, null)],
  ["an empty array", out(200, [])],
  ["a 404", out(404, { Message: "Not found" })],
]) {
  test(`a stored product id that comes back as ${name} is not found: no create, a person decides`, async () => {
    const pb = mockPb({ rows: [row()], items: { i1: item({ epos_product_id: 900 }) } })
    const epos = mockEpos({ ...quiet, "GET v4/Product/900": reply, "GET v4/Product?page=1": out(200, []) })
    await runOnce(deps(pb, epos))
    assert.equal(pb.rows.q1.status, "failed")
    assert.equal(pb.rows.q1.attempts, MAX_ATTEMPTS)
    assert.match(pb.rows.q1.last_error, /Epos Now has no product 900 and none with Sku GGV-GGS7F3K2Q/)
    assert.equal(epos.writes().length, 0, "never creates a second product")
  })
}

test("an item back in stock reuses its own archived product and un-archives it", async () => {
  const items = { i1: item({ epos_product_id: 900 }) }
  const pb = mockPb({ rows: [row()], items })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product/900": out(200, owned({ IsArchived: true })),
    "PUT v4/Product": (body) => {
      const [p] = JSON.parse(body)
      assert.equal(p.Id, 900)
      assert.equal(p.IsArchived, false)
      return out(200, [owned()])
    },
  })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, 0)
  assert.equal(epos.calls.filter((c) => c.path.startsWith("v4/Product?")).length, 0, "no product list needed")
})

test("a stored id Epos no longer returns is found by Sku among archived products and un-archived", async () => {
  const items = { i1: item({ epos_product_id: 900 }) }
  const pb = mockPb({ rows: [row()], items })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product/900": empty,
    "GET v4/Product?page=1": out(200, []),
    "GET v4/catalogue/Products": (_b, path) => {
      assert.match(path, /Barcode=GGS7F3K2Q&Archived=true/)
      return out(200, { data: [{ id: 900, sku: "GGV-GGS7F3K2Q", barcode: "GGS7F3K2Q", name: "Charizard ex #199" }], metadata: {} })
    },
    "PUT v4/Product": (body) => {
      assert.equal(JSON.parse(body)[0].IsArchived, false)
      return out(200, [owned()])
    },
  })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(items.i1.epos_product_id, 900)
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, 0)
})

test("before a create, an archived GGV product missing from the list is adopted, not duplicated", async () => {
  const items = { i1: item() }
  const pb = mockPb({ rows: [row()], items })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product?page=1": out(200, [{ Id: 1, Sku: "GGE-POK-006", Barcode: "196214157507" }]),
    "GET v4/catalogue/Products": out(200, { data: [{ id: 4321, sku: "GGV-GGS7F3K2Q", barcode: "GGS7F3K2Q" }] }),
    "PUT v4/Product": (body) => {
      const [p] = JSON.parse(body)
      assert.equal(p.Id, 4321)
      assert.equal(p.IsArchived, false)
      return out(200, [owned({ Id: 4321 })])
    },
  })
  await runOnce(deps(pb, epos))
  assert.equal(items.i1.epos_product_id, 4321)
  assert.equal(epos.calls.filter((c) => c.method === "POST").length, 0)
})

test("an archived shop product with the barcode blocks the create", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() } })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product?page=1": out(200, []),
    "GET v4/catalogue/Products": out(200, { data: [{ id: 77, sku: "OLD-1", barcode: "GGS7F3K2Q" }] }),
  })
  await runOnce(deps(pb, epos))
  assert.match(pb.rows.q1.last_error, /Epos Now product 77 already uses barcode/)
  assert.equal(epos.writes().length, 0)
})

test("if the archived search fails, nothing is created and it retries", async () => {
  const pb = mockPb({ rows: [row()], items: { i1: item() } })
  const epos = mockEpos({ ...quiet, "GET v4/Product?page=1": out(200, []), "GET v4/catalogue/Products": out(500) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "failed")
  assert.equal(pb.rows.q1.attempts, 1)
  assert.equal(epos.writes().length, 0)
})

test("an archive whose product Epos no longer returns by id is done when the archived search has it", async () => {
  const pb = mockPb({ rows: [row({ action: "archive" })], items: { i1: item({ status: "sold", epos_product_id: 900 }) } })
  const epos = mockEpos({
    ...quiet,
    "GET v4/Product/900": empty,
    "GET v4/Product?page=1": out(200, []),
    "GET v4/catalogue/Products": out(200, { data: [{ id: 900, sku: "GGV-GGS7F3K2Q", barcode: "GGS7F3K2Q" }] }),
  })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "done")
  assert.equal(epos.writes().length, 0)
})

test("the barcode sent is the SKU without its hyphen, the same encodeCode the label uses", () => {
  assert.equal(eposBarcode("GGS-7F3K2Q"), "GGS7F3K2Q")
  assert.equal(eposBarcode("ggs7f3k2q"), "GGS7F3K2Q")
  const f = productFields(item({ sku: "GGS-7F3K2Q" }), "pokemon", readSettings(SETTINGS))
  assert.equal(f.Barcode, sharedSku.encodeCode("GGS-7F3K2Q"))
  assert.equal(f.Sku, "GGV-GGS7F3K2Q")
  assert.equal(isOwned({ Sku: "GGV-GGS7F3K2Q" }, "GGS-7F3K2Q"), true)
})

test("the sale price is UnitPrice x Quantity less the line and basket discounts, in pence", () => {
  assert.equal(lineSalePence({ UnitPrice: 10, Quantity: 2, DiscountAmount: 1.5, BasketDiscountPortion: 0.33 }), 1817)
  assert.equal(lineSalePence({ UnitPrice: 229.99, Quantity: 1, DiscountAmount: null, BasketDiscountPortion: null }), 22999)
  assert.equal(lineSalePence({ UnitPrice: 229.99, Quantity: 1 }), 22999)
  assert.equal(lineSalePence({ UnitPrice: 0.1 + 0.2, Quantity: 3, DiscountAmount: "0.10" }), 80)
  assert.equal(lineSalePence({ UnitPrice: 5, Quantity: 1, DiscountAmount: "abc" }), null)
  const txn = { Id: 9, DateTime: "2026-11-09T10:00:00" }
  const line = saleLine(txn, { Id: 4, ProductId: 900, Quantity: 1, UnitPrice: 229.99, DiscountAmount: 20, BasketDiscountPortion: 9.99 }, 0)
  assert.equal(line.unit_price, 22999)
  assert.equal(line.sale_price, 20000)
  assert.equal(line.flag, undefined)
  const refund = saleLine(txn, { Id: 5, ProductId: 900, Quantity: -1, UnitPrice: 229.99, DiscountAmount: 20, RefundReasonId: 1 }, 0)
  assert.equal(refund.sale_price, 20999)
  assert.equal(refund.refund, true)
  assert.match(saleLine(txn, { Id: 6, ProductId: 900, Quantity: 1, UnitPrice: 5, DiscountAmount: 6 }, 0).flag, /more than its price/)
})

test("till lines are keyed by their Id; a line with no Id is flagged, not keyed by position", () => {
  const txn = { Id: 9 }
  assert.equal(saleLine(txn, { Id: 41, ProductId: 900, Quantity: 1, UnitPrice: 1 }, 3).line, "41")
  const noId = saleLine(txn, { ProductId: 900, Quantity: 1, UnitPrice: 1 }, 3)
  assert.equal(noId.line, "noid-3")
  assert.match(noId.flag, /no Id/)
})

test("discounted till sales reach the apply route with the discounted price", async () => {
  const pb = mockPb({ items: { i1: item({ epos_product_id: 900 }) } })
  const epos = mockEpos({
    "GET v4/Transaction/GetByDate": () =>
      out(200, [{ Id: 5001, DateTime: "2026-11-09T12:00:00", TransactionItems: [{ Id: 1, ProductId: 900, Quantity: 1, UnitPrice: 229.99, DiscountAmount: 10, BasketDiscountPortion: null }] }]),
  })
  await syncSales(deps(pb, epos), { everyMs: 0 })
  assert.equal(pb.applied.get("5001:1").sale_price, 21999)
})

test("nested Children categories are cached too, with their parent", async () => {
  const pb = mockPb()
  const epos = mockEpos({
    "GET v4/Category": out(200, [{ Id: 1, Name: "Pokemon", ParentId: null, Children: [{ Id: 2, Name: "Pokemon Singles", Children: [] }] }]),
    "GET v4/Transaction/GetByDate": out(200, []),
  })
  await runOnce(deps(pb, epos))
  assert.deepEqual(pb.state.categories.items, [
    { id: 1, name: "Pokemon", parent_id: null },
    { id: 2, name: "Pokemon Singles", parent_id: 1 },
  ])
})

test("an empty category reply is an empty list", async () => {
  const pb = mockPb()
  const epos = mockEpos({ "GET v4/Category": empty, "GET v4/Transaction/GetByDate": empty })
  await runOnce(deps(pb, epos))
  assert.deepEqual(pb.state.categories.items, [])
})
