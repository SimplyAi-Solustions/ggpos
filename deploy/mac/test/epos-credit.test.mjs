// node --test deploy/mac/test/
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MAX_ATTEMPTS,
  balanceBody,
  classify,
  parseAddress,
  parseEposOutput,
  penceToPounds,
  poundsToPence,
  processRow,
  redact,
  runOnce,
  splitName,
} from "../lib/epos-credit.mjs"

// --- mocks ------------------------------------------------------------

const out = (code, json) => ({ stdout: `${json === undefined ? "" : JSON.stringify(json)}\nHTTP ${code}\n`, exitCode: 0 })

/** A mock Epos: `script` maps "METHOD path-prefix" to a reply or a list of replies. */
function mockEpos(script) {
  const calls = []
  const fn = async (method, path, body) => {
    calls.push({ method, path, body })
    const exact = `${method} ${path.split("?")[0]}`
    const key = exact in script ? exact : Object.keys(script).find((k) => `${method} ${path}`.startsWith(k))
    if (!key) throw new Error(`unexpected epos call ${method} ${path}`)
    const v = script[key]
    return Array.isArray(v) ? v.shift() : typeof v === "function" ? v(body) : v
  }
  fn.calls = calls
  fn.balanceCalls = () => calls.filter((c) => c.path === "v4/Customer/balance")
  return fn
}

/** An in-memory PocketBase. Every row write is recorded in order. */
function mockPb({ rows = [], customers = {}, privates = {}, failUpdate } = {}) {
  const writes = []
  const pb = {
    rows: Object.fromEntries(rows.map((r) => [r.id, { attempts: 0, ...r }])),
    customers,
    writes,
    listSending: async () => Object.values(pb.rows).filter((r) => r.status === "sending"),
    listDue: async (max) =>
      Object.values(pb.rows).filter((r) => r.status === "pending" || (r.status === "failed" && r.attempts < max)),
    listNeedsCheck: async () => Object.values(pb.rows).filter((r) => r.status === "needs_check"),
    getCustomer: async (id) => customers[id] || null,
    getPrivate: async (id) => privates[id] || null,
    updateCustomer: async (id, patch) => Object.assign(customers[id], patch),
    updateRow: async (id, patch) => {
      if (failUpdate && failUpdate(patch)) throw new Error("pocketbase down")
      writes.push({ id, ...patch })
      return Object.assign(pb.rows[id], patch)
    },
  }
  return pb
}

const deps = (pb, epos) => ({ pb, epos, log: () => {}, now: () => new Date("2026-11-09T15:00:00Z") })
const row = (extra = {}) => ({ id: "q1", customer: "c1", trade_in: "t1", amount: 6324, status: "pending", ...extra })

// --- money ------------------------------------------------------------

test("pence go to Epos as decimal pounds, never float maths", () => {
  assert.equal(penceToPounds(6324), "63.24")
  assert.equal(penceToPounds(5), "0.05")
  assert.equal(penceToPounds(10), "0.10")
  assert.equal(balanceBody(42, 6324), '{"CustomerId":42,"BalanceToAdd":63.24}')
  assert.equal(balanceBody(42, 30), '{"CustomerId":42,"BalanceToAdd":0.30}')
  assert.deepEqual(JSON.parse(balanceBody(42, 6324)), { CustomerId: 42, BalanceToAdd: 63.24 })
  assert.throws(() => penceToPounds(0))
  assert.throws(() => penceToPounds(12.5))
  assert.throws(() => balanceBody(0, 100))
})

test("Epos balances come back to pence through their decimal text", () => {
  assert.equal(poundsToPence(63.24), 6324)
  assert.equal(poundsToPence(0.1 + 0.2), 30)
  assert.equal(poundsToPence("12.5"), 1250)
  assert.equal(poundsToPence(-4), -400)
  assert.equal(poundsToPence(1.005), 101)
  assert.equal(poundsToPence(null), null)
  assert.equal(poundsToPence("abc"), null)
})

// --- parsing ----------------------------------------------------------

test("the epos command's output splits into body and status", () => {
  const p = parseEposOutput('{"Id":5,"CurrentBalance":10.5}\nHTTP 200\n')
  assert.equal(p.code, 200)
  assert.deepEqual(p.json, { Id: 5, CurrentBalance: 10.5 })
  assert.equal(parseEposOutput("\nHTTP 000\n").code, null)
  assert.equal(parseEposOutput("").code, null)
  assert.equal(parseEposOutput("HTTP 404").code, 404)
})

test("classify separates definite failures from unknown outcomes", () => {
  assert.equal(classify(out(200, {})).outcome, "ok")
  assert.equal(classify(out(400, {})).outcome, "rejected")
  assert.equal(classify(out(429, {})).outcome, "rejected")
  assert.equal(classify(out(500, {})).outcome, "unknown")
  assert.equal(classify(out(502)).outcome, "unknown")
  assert.equal(classify(out(201, {})).outcome, "unknown")
  assert.equal(classify({ stdout: "\nHTTP 000\n", exitCode: 6 }).outcome, "not_sent") // DNS
  assert.equal(classify({ stdout: "\nHTTP 000\n", exitCode: 7 }).outcome, "not_sent") // refused
  assert.equal(classify({ stdout: "\nHTTP 000\n", exitCode: 28 }).outcome, "unknown") // curl timeout
  assert.equal(classify({ stdout: "\nHTTP 000\n", exitCode: 52 }).outcome, "unknown") // empty reply
  assert.equal(classify({ stdout: "\nHTTP 000\n", exitCode: 56 }).outcome, "unknown") // recv failure
  assert.equal(classify({ stdout: "", exitCode: null, timedOut: true }).outcome, "unknown")
  assert.equal(classify({ stdout: "", spawnError: "ENOENT" }).outcome, "not_sent")
})

test("names and free-text addresses map onto Epos fields", () => {
  assert.deepEqual(splitName("Jo Bloggs Smith"), { Forename: "Jo", Surname: "Bloggs Smith" })
  assert.deepEqual(splitName("Cher"), { Forename: "Cher", Surname: "" })
  assert.deepEqual(parseAddress("4 Cavendish Walk, Bolsover, s44 6aa"), {
    AddressLine1: "4 Cavendish Walk",
    AddressLine2: "",
    Town: "Bolsover",
    County: "",
    PostCode: "S44 6AA",
  })
  assert.equal(parseAddress("Flat 2\n10 High St\nOld Town\nChesterfield S40 1AB").AddressLine2, "10 High St, Old Town")
  assert.equal(parseAddress(""), null)
  assert.equal(redact("bad email jo@example.com phone 07700 900123"), "bad email [email] phone [number]")
})

// --- the row lifecycle --------------------------------------------------

test("a linked customer is credited; sending is stored before the balance call", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } } })
  const epos = mockEpos({
    "PUT v4/Customer/balance": (body) => {
      // The guard: by the time Epos is called, the row already says sending.
      assert.equal(pb.rows.q1.status, "sending")
      assert.equal(body, '{"CustomerId":42,"BalanceToAdd":63.24}')
      return out(200, { Id: 42, CurrentBalance: 73.24 })
    },
  })
  const res = await processRow(pb.rows.q1, deps(pb, epos))
  assert.equal(res.status, "done")
  assert.deepEqual(
    pb.writes.map((w) => w.status),
    ["sending", "done"]
  )
  assert.equal(pb.rows.q1.epos_balance_after, 7324)
  assert.equal(pb.rows.q1.epos_customer_id, 42)
  assert.equal(pb.rows.q1.sent_at, "2026-11-09T15:00:00.000Z")
  assert.equal(pb.rows.q1.attempts, 1)
  assert.equal(epos.calls.length, 1)
  assert.doesNotMatch(res.line, /Jo/)
})

test("an unlinked customer with an email is matched by email and linked", async () => {
  const customers = { c1: { id: "c1", name: "Jo Bloggs", email: "jo@example.com" } }
  const pb = mockPb({ rows: [row()], customers })
  const epos = mockEpos({
    "GET v4/Customer/GetByEmail?email=jo%40example.com": out(200, { Id: 77 }),
    "PUT v4/Customer/balance": out(200, [{ Id: 77, CurrentBalance: 63.24 }]),
  })
  const res = await processRow(pb.rows.q1, deps(pb, epos))
  assert.equal(res.status, "done")
  assert.equal(customers.c1.epos_customer_id, 77)
  assert.equal(pb.rows.q1.epos_balance_after, 6324)
  assert.doesNotMatch(res.line, /example\.com/)
})

test("no match: the customer and address are created, then credited", async () => {
  const customers = { c1: { id: "c1", name: "Jo Bloggs", email: "jo@example.com", phone: "+447700900123" } }
  const pb = mockPb({ rows: [row()], customers, privates: { c1: { address: "4 Cavendish Walk, Bolsover, S44 6AA" } } })
  const epos = mockEpos({
    "GET v4/Customer/GetByEmail": out(404, { Message: "Not found" }),
    "POST v4/Customer": (body) => {
      assert.deepEqual(JSON.parse(body), [
        {
          Forename: "Jo",
          Surname: "Bloggs",
          ContactNumber: "+447700900123",
          EmailAddress: "jo@example.com",
          Notes: "Created by GG Vault",
        },
      ])
      return out(201, [{ Id: 501 }])
    },
    "POST v4/CustomerAddress": (body) => {
      const [a] = JSON.parse(body)
      assert.equal(a.CustomerId, 501)
      assert.equal(a.PostCode, "S44 6AA")
      assert.equal(a.IsMainAddress, true)
      assert.equal(a.Name, "Main")
      return out(201, [{}])
    },
    "PUT v4/Customer/balance": out(200, [{ Id: 501, CurrentBalance: 63.24 }]),
  })
  const res = await processRow(pb.rows.q1, deps(pb, epos))
  assert.equal(res.status, "done")
  assert.equal(customers.c1.epos_customer_id, 501)
  assert.deepEqual(
    epos.calls.map((c) => c.method + " " + c.path.split("?")[0]),
    ["GET v4/Customer/GetByEmail", "POST v4/Customer", "POST v4/CustomerAddress", "PUT v4/Customer/balance"]
  )
})

test("no email: created straight away without a lookup", async () => {
  const customers = { c1: { id: "c1", name: "Walk In" } }
  const pb = mockPb({ rows: [row()], customers })
  const epos = mockEpos({
    "POST v4/Customer": out(200, [{ Id: 9 }]),
    "PUT v4/Customer/balance": out(200, { Id: 9, CurrentBalance: 63.24 }),
  })
  assert.equal((await processRow(pb.rows.q1, deps(pb, epos))).status, "done")
  assert.equal(epos.calls[0].method, "POST")
})

test("a 4xx on the balance call is failed and retried later, up to the limit", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } } })
  const epos = mockEpos({ "PUT v4/Customer/balance": () => out(400, { Message: "Invalid" }) })
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const counts = await runOnce(deps(pb, epos))
    assert.equal(counts.failed, 1)
    assert.equal(pb.rows.q1.status, "failed")
    assert.equal(pb.rows.q1.attempts, i)
  }
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.failed, 0, "no sixth attempt")
  assert.equal(epos.balanceCalls().length, MAX_ATTEMPTS)
})

test("a request that never left the Mac is failed, not needs_check", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } } })
  const epos = mockEpos({ "PUT v4/Customer/balance": { stdout: "\nHTTP 000\n", exitCode: 7 } })
  assert.equal((await processRow(pb.rows.q1, deps(pb, epos))).status, "failed")
  assert.equal(pb.rows.q1.status, "failed")
})

for (const [name, reply] of [
  ["a 500", out(500, { Message: "Server error" })],
  ["a 503 with no body", out(503)],
  ["a curl timeout", { stdout: "\nHTTP 000\n", exitCode: 28 }],
  ["the worker's own timeout", { stdout: "", exitCode: null, timedOut: true }],
  ["a dropped connection", { stdout: "\nHTTP 000\n", exitCode: 56 }],
]) {
  test(`${name} after sending goes to needs_check and is never sent again`, async () => {
    const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } } })
    const epos = mockEpos({ "PUT v4/Customer/balance": () => reply })
    const first = await runOnce(deps(pb, epos))
    assert.equal(first.needs_check, 1)
    assert.equal(pb.rows.q1.status, "needs_check")
    assert.match(pb.rows.q1.last_error, /Check the customer's balance/)
    await runOnce(deps(pb, epos))
    await runOnce(deps(pb, epos))
    assert.equal(epos.balanceCalls().length, 1, "the credit is never sent twice")
  })
}

test("a row left in sending (a crash mid-call) goes to needs_check at startup, unsent", async () => {
  const logs = []
  const pb = mockPb({
    rows: [row({ status: "sending", attempts: 1 })],
    customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } },
  })
  const epos = mockEpos({})
  const counts = await runOnce({ ...deps(pb, epos), log: (l) => logs.push(l) })
  assert.equal(counts.stuck, 1)
  assert.equal(pb.rows.q1.status, "needs_check")
  assert.equal(epos.calls.length, 0)
  assert.ok(logs.some((l) => /^NEEDS CHECK: 1 /.test(l)), "a summary line for the operator")
})

test("if sending cannot be stored, nothing is sent", async () => {
  const pb = mockPb({
    rows: [row()],
    customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } },
    failUpdate: (patch) => patch.status === "sending",
  })
  const epos = mockEpos({})
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.errors, 1)
  assert.equal(epos.balanceCalls().length, 0)
  assert.equal(pb.rows.q1.status, "pending")
})

test("if done cannot be stored after a 200, the row stays sending and the next run flags it", async () => {
  const pb = mockPb({
    rows: [row()],
    customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } },
    failUpdate: (patch) => patch.status === "done",
  })
  const epos = mockEpos({ "PUT v4/Customer/balance": () => out(200, { CurrentBalance: 63.24 }) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "sending")
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "needs_check")
  assert.equal(epos.balanceCalls().length, 1)
})

test("a failed lookup does not touch the balance and is retried", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", email: "jo@example.com" } } })
  const epos = mockEpos({ "GET v4/Customer/GetByEmail": out(500) })
  assert.equal((await processRow(pb.rows.q1, deps(pb, epos))).status, "failed")
  assert.equal(pb.rows.q1.attempts, 1)
  assert.doesNotMatch(pb.rows.q1.last_error, /example\.com/)
  assert.equal(epos.balanceCalls().length, 0)
})

test("a create with an unknown outcome stops retrying, so no duplicate customer", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Walk In" } } })
  const epos = mockEpos({ "POST v4/Customer": () => out(504) })
  await runOnce(deps(pb, epos))
  assert.equal(pb.rows.q1.status, "failed")
  assert.equal(pb.rows.q1.attempts, MAX_ATTEMPTS)
  await runOnce(deps(pb, epos))
  assert.equal(epos.calls.length, 1)
})

test("several Epos customers on one email is a permanent failure", async () => {
  const pb = mockPb({ rows: [row()], customers: { c1: { id: "c1", name: "Jo", email: "jo@example.com" } } })
  const epos = mockEpos({ "GET v4/Customer/GetByEmail": out(200, [{ Id: 1 }, { Id: 2 }]) })
  await processRow(pb.rows.q1, deps(pb, epos))
  assert.equal(pb.rows.q1.attempts, MAX_ATTEMPTS)
  assert.equal(epos.balanceCalls().length, 0)
})

test("rows run oldest first and one failure does not stop the rest", async () => {
  const pb = mockPb({
    rows: [row({ id: "q1", customer: "gone" }), row({ id: "q2", amount: 100 })],
    customers: { c1: { id: "c1", name: "Jo", epos_customer_id: 42 } },
  })
  const epos = mockEpos({ "PUT v4/Customer/balance": out(200, { CurrentBalance: 1 }) })
  const counts = await runOnce(deps(pb, epos))
  assert.equal(counts.failed, 1)
  assert.equal(counts.done, 1)
  assert.equal(pb.rows.q2.status, "done")
})

// --- the default runner, against a stand-in `epos` script ----------------

test("the default runner passes METHOD PATH BODY and kills a hung call", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { makeEposRunner } = await import("../epos-credit-sync.mjs")
  const dir = mkdtempSync(join(tmpdir(), "epos-mock-"))
  try {
    const echo = join(dir, "epos-echo")
    writeFileSync(echo, '#!/bin/sh\nprintf \'{"m":"%s","p":"%s","b":%s}\\nHTTP 200\\n\' "$1" "$2" "$3"\n')
    chmodSync(echo, 0o755)
    const r = classify(await makeEposRunner(echo, 5000)("PUT", "v4/Customer/balance", balanceBody(42, 6324)))
    assert.equal(r.outcome, "ok")
    assert.deepEqual(r.json, { m: "PUT", p: "v4/Customer/balance", b: { CustomerId: 42, BalanceToAdd: 63.24 } })

    const hang = join(dir, "epos-hang")
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n")
    chmodSync(hang, 0o755)
    const h = await makeEposRunner(hang, 200)("PUT", "v4/Customer/balance", "{}")
    assert.equal(h.timedOut, true)
    assert.equal(classify(h).outcome, "unknown")

    const missing = await makeEposRunner(join(dir, "nope"), 1000)("GET", "v4/TokenInfo")
    assert.equal(classify(missing).outcome, "not_sent")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
