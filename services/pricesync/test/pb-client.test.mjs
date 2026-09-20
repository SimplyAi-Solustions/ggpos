// getFullList's own paging loop, against a minimal fake PocketBase that
// deliberately returns few records per page. Every PocketBase response in
// this service is parsed with numberAsString (see json-stream.mjs), so
// `totalPages`/`totalItems` arrive as decimal strings, not numbers - this
// pins that the paging loop still terminates correctly rather than
// relying on a reader trusting `page >= json.totalPages` "just works"
// across a string/number comparison.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { getFullList } from "../src/lib/pb-client.mjs";

function listenOnFreePort(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

describe("getFullList", () => {
  test("pages through every record, two-per-page, across four pages", async () => {
    const allRecords = Array.from({ length: 7 }, (_, i) => ({ id: `rec${i}` }));
    const requestedPages = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const perPage = 2;
      const totalItems = allRecords.length;
      const totalPages = Math.ceil(totalItems / perPage);
      const items = allRecords.slice((page - 1) * perPage, page * perPage);
      res.writeHead(200, { "Content-Type": "application/json" });
      // Every field a number, sent as PocketBase actually sends them
      // (JSON numbers) - it is this service's own parser that turns them
      // into strings on the way in, which is exactly what this test wants
      // to exercise.
      res.end(JSON.stringify({ items, page, perPage, totalItems, totalPages }));
    });
    const port = await listenOnFreePort(server);
    try {
      const items = await getFullList(`http://127.0.0.1:${port}`, "tok", "widgets", { perPage: 2 });
      assert.deepEqual(
        items.map((r) => r.id),
        allRecords.map((r) => r.id)
      );
      assert.deepEqual(requestedPages, [1, 2, 3, 4], "expected exactly one request per page, in order, then stop");
    } finally {
      server.close();
    }
  });

  test("stops after a single page when totalPages is 1", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: "only" }], page: 1, perPage: 200, totalItems: 1, totalPages: 1 }));
    });
    const port = await listenOnFreePort(server);
    try {
      const items = await getFullList(`http://127.0.0.1:${port}`, "tok", "widgets");
      assert.equal(items.length, 1);
    } finally {
      server.close();
    }
  });
});
