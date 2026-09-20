// createUpsertQueue's own de-duplication (finding #22): a blank or
// missing TCGCSV subTypeName always normalises to "normal" (see
// tcgcsv.mjs's normalizeFinish), so two different wanted productIds that
// both lack one, matched to two different cards, could otherwise both try
// to create the same (card, finish, source) row on the same day. This
// queue must land at most one row per key per run either way: as one
// in-flight request updated in place if the duplicate arrives before the
// first has been flushed, or as a PATCH against the id the first create
// returned if it arrives after.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createUpsertQueue } from "../src/lib/upsert-queue.mjs";

function listenOnFreePort(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : undefined));
  });
}

/** A fake PocketBase /api/batch that actually behaves like one for
 * create/update: assigns an id on POST, applies a PATCH to that id,
 * rejects a PATCH to an unknown id (so a bug that tries to patch an id
 * that was never created surfaces as a failure, not a silent no-op). */
function createFakeBatchServer() {
  const db = new Map();
  const batches = [];
  let nextId = 1;
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/batch") {
      const body = await readBody(req);
      batches.push(body.requests);
      const results = body.requests.map((r) => {
        const m = r.url.match(/^\/api\/collections\/price_snapshots\/records(?:\/([\w-]+))?$/);
        if (r.method === "POST") {
          const id = `rec${String(nextId++).padStart(6, "0")}`;
          const record = { id, ...r.body };
          db.set(id, record);
          return { status: 200, body: record };
        }
        const id = m[1];
        if (!db.has(id)) return { status: 404, body: { message: "not found" } };
        const record = { ...db.get(id), ...r.body, id };
        db.set(id, record);
        return { status: 200, body: record };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(results));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "no route" }));
  });
  return { server, db, batches };
}

function row(card, finish, overrides = {}) {
  return { card, finish, source: "tcgplayer", native_currency: "USD", native_low: 1, native_mid: 1, native_market: 1, fetched_at: "2026-09-20 04:00:00.000Z", ...overrides };
}

describe("createUpsertQueue", () => {
  test("two pushes for the same key before a flush collapse into a single POST, using the latest row", async () => {
    const { server, db, batches } = createFakeBatchServer();
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 200 };
      const queue = createUpsertQueue({ ctx, existingToday: new Map(), flushSize: 200 });

      // Two different TCGCSV productIds, both missing subTypeName, both
      // matched to card "cardX" - normalizeFinish gives both "normal".
      await queue.push(row("cardX", "normal", { native_market: 111 }));
      await queue.push(row("cardX", "normal", { native_market: 222 }));
      await queue.flush();

      const { succeeded, failed } = queue.results();
      assert.equal(failed.length, 0);
      assert.equal(succeeded.length, 1, "only one row should have reached the server");
      assert.equal(succeeded[0].native_market, 222, "the later push should win, not the earlier one");
      assert.equal(db.size, 1);
      assert.equal(batches.length, 1);
      assert.equal(batches[0].length, 1, "only one request should have been sent, not two");
    } finally {
      server.close();
    }
  });

  test("a duplicate key pushed after the first has already been flushed and created is PATCHed against the learned id, not POSTed again", async () => {
    const { server, db, batches } = createFakeBatchServer();
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 200 };
      // flushSize 1 forces the first push to hit the network before the
      // second one is queued, exercising the "already created this run"
      // path rather than the in-flight one above.
      const queue = createUpsertQueue({ ctx, existingToday: new Map(), flushSize: 1 });

      await queue.push(row("cardY", "normal", { native_market: 111 }));
      await queue.push(row("cardY", "normal", { native_market: 222 }));
      await queue.flush();

      const { succeeded, failed } = queue.results();
      assert.equal(failed.length, 0);
      assert.equal(succeeded.length, 2, "both pushes report success (a create, then an update)");
      assert.equal(db.size, 1, "exactly one price_snapshots row must exist for this key");
      assert.equal([...db.values()][0].native_market, 222, "the row should reflect the second push's value");
      assert.equal(batches.length, 2);
      assert.equal(batches[0][0].method, "POST");
      assert.equal(batches[1][0].method, "PATCH");
      assert.equal(batches[1][0].url, `/api/collections/price_snapshots/records/${[...db.keys()][0]}`);
    } finally {
      server.close();
    }
  });

  test("a key already in existingToday (an earlier run today) is PATCHed on the very first push", async () => {
    const { server, db, batches } = createFakeBatchServer();
    const port = await listenOnFreePort(server);
    db.set("earlier-run-id", { id: "earlier-run-id", card: "cardZ", finish: "normal", source: "tcgplayer" });
    const port2 = port;
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port2}`, token: "tok", batchLimit: 200 };
      const existingToday = new Map([["cardZ|normal|tcgplayer", "earlier-run-id"]]);
      const queue = createUpsertQueue({ ctx, existingToday, flushSize: 200 });

      await queue.push(row("cardZ", "normal", { native_market: 333 }));
      await queue.flush();

      assert.equal(batches[0][0].method, "PATCH");
      assert.equal(batches[0][0].url, "/api/collections/price_snapshots/records/earlier-run-id");
      assert.equal(db.get("earlier-run-id").native_market, 333);
    } finally {
      server.close();
    }
  });
});
