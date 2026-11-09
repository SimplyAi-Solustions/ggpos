// node --test pb/scripts/reset-test-data.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { DELETE, KEEP, hostAllowed, classify, parseArgs } = require("./reset-test-data.js");

test("only vault-test hosts and this machine are allowed", () => {
  assert.ok(hostAllowed("https://vault-test.ggentertainment.co.uk"));
  assert.ok(hostAllowed("http://127.0.0.1:8091"));
  assert.ok(hostAllowed("http://localhost:8090/"));
  assert.ok(hostAllowed("http://[::1]:8090"));
  assert.ok(!hostAllowed("https://vault.ggentertainment.co.uk"));
  assert.ok(!hostAllowed("https://vault.ggentertainment.co.uk/?vault-test"));
  assert.ok(!hostAllowed("https://localhost.evil.com"));
  assert.ok(!hostAllowed("not a url"));
});

test("no collection is both deleted and kept", () => {
  for (const n of DELETE) assert.ok(!KEEP.includes(n), n);
});

test("the business collections are deleted", () => {
  for (const n of [
    "items", "trade_ins", "trade_in_lines", "quotes", "sales", "cash_sessions", "cash_movements",
    "bookings", "customers", "customer_private", "id_documents", "points_ledger", "credit_ledger",
    "research_requests",
  ]) {
    assert.ok(DELETE.includes(n), n);
  }
});

test("the reference data is kept", () => {
  for (const n of [
    "cards", "card_sets", "games", "retro_titles", "price_snapshots", "fx_rates", "categories",
    "settings", "loyalty_programme", "staff", "label_templates", "counters",
  ]) {
    assert.ok(KEEP.includes(n), n);
  }
});

test("classify keeps system and unknown collections and orders deletes children first", () => {
  const plan = classify(["customers", "_superusers", "_mfas", "cards", "trade_ins", "trade_in_lines", "items", "label_jobs", "brand_new"]);
  assert.deepStrictEqual(plan.del, ["label_jobs", "trade_in_lines", "items", "trade_ins", "customers"]);
  assert.deepStrictEqual(plan.keep, ["_mfas", "_superusers", "cards"]);
  assert.deepStrictEqual(plan.unknown, ["brand_new"]);
});

test("parseArgs needs explicit flags", () => {
  assert.deepStrictEqual(parseArgs(["--url", "http://localhost:8091/"]), { url: "http://localhost:8091", yes: false, dryRun: false });
  assert.strictEqual(parseArgs(["--url=http://x", "--yes"]).yes, true);
  assert.throws(() => parseArgs(["-y"]));
});
