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

import { getFullList, getFirst, authenticate, createSubmitContext, submitRequests } from "../src/lib/pb-client.mjs";

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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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

describe("getFirst", () => {
  test("makes exactly one request regardless of how many rows the collection holds", async () => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount += 1;
      const url = new URL(req.url, "http://127.0.0.1");
      assert.equal(url.searchParams.get("perPage"), "1");
      assert.equal(url.searchParams.get("page"), "1");
      // totalPages is huge - a getFullList(..., {perPage:1}) misuse would
      // make one request per row; getFirst must not.
      sendJson(res, 200, { items: [{ id: "latest" }], page: 1, perPage: 1, totalItems: 400, totalPages: 400 });
    });
    const port = await listenOnFreePort(server);
    try {
      const row = await getFirst(`http://127.0.0.1:${port}`, "tok", "fx_rates", { sort: "-fetched_at" });
      assert.equal(row.id, "latest");
      assert.equal(requestCount, 1);
    } finally {
      server.close();
    }
  });

  test("returns null when the collection has no matching rows", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 200, { items: [], page: 1, perPage: 1, totalItems: 0, totalPages: 1 });
    });
    const port = await listenOnFreePort(server);
    try {
      const row = await getFirst(`http://127.0.0.1:${port}`, "tok", "fx_rates");
      assert.equal(row, null);
    } finally {
      server.close();
    }
  });
});

describe("authenticate", () => {
  test("an unreachable PocketBase raises a message naming the container to check, not a bare 'fetch failed'", async () => {
    const server = http.createServer(() => {});
    const port = await listenOnFreePort(server);
    server.close();
    await assert.rejects(() => authenticate(`http://127.0.0.1:${port}`, "a@b.test", "pw"), (err) => {
      assert.match(err.message, /Cannot reach PocketBase/);
      assert.match(err.message, /pocketbase container is running/);
      return true;
    });
  });

  test("rejected credentials propagate PocketBase's own error rather than being swallowed", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 400, { message: "Failed to authenticate.", data: {} });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => authenticate(`http://127.0.0.1:${port}`, "a@b.test", "wrong"), /Failed to authenticate/);
    } finally {
      server.close();
    }
  });
});

describe("createSubmitContext", () => {
  test("uses the server's own maxRequests when it is lower than the requested size", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 200, { batch: { enabled: true, maxRequests: 50, timeout: 60, maxBodySize: 0 } });
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = await createSubmitContext(`http://127.0.0.1:${port}`, "tok", { requestedBatchSize: 200 });
      assert.equal(ctx.batchLimit, 50);
    } finally {
      server.close();
    }
  });

  test("falls back to the requested size when /api/settings cannot be read, rather than failing startup", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 403, { message: "not a superuser" });
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = await createSubmitContext(`http://127.0.0.1:${port}`, "tok", { requestedBatchSize: 200 });
      assert.equal(ctx.batchLimit, 200);
    } finally {
      server.close();
    }
  });

  test("returns batchLimit null when the server reports batch disabled", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 200, { batch: { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 } });
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = await createSubmitContext(`http://127.0.0.1:${port}`, "tok", { requestedBatchSize: 200 });
      assert.equal(ctx.batchLimit, null);
    } finally {
      server.close();
    }
  });
});

/** A fake PocketBase /api/batch endpoint driven by a small in-memory
 * store, for submitRequests' own chunking/retry/fallback logic - separate
 * from test/pipeline.test.mjs's fuller fake server, which exercises the
 * same code as part of the whole pipeline rather than in isolation. */
function createFakeBatchServer({ db = new Map(), onBatch } = {}) {
  const batches = [];
  let nextId = 1;
  const genId = () => `rec${String(nextId++).padStart(6, "0")}`;

  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/batch") {
      const body = await readBody(req);
      batches.push(body.requests);
      if (onBatch) {
        const override = onBatch(body.requests, batches.length);
        if (override) return sendJson(res, override.status, override.body);
      }
      const results = body.requests.map((r) => {
        const m = r.url.match(/^\/api\/collections\/\w+\/records(?:\/([\w-]+))?$/);
        const id = m[1] || genId();
        const record = { id, ...r.body };
        db.set(id, record);
        return { status: 200, body: record };
      });
      return sendJson(res, 200, results);
    }
    sendJson(res, 404, { message: "no route" });
  });
  return { server, batches, db };
}

function req(n) {
  return { method: "POST", url: "/api/collections/price_snapshots/records", body: { n }, meta: { n } };
}

describe("submitRequests", () => {
  test("splits requests into chunks of exactly ctx.batchLimit, in order (the batch limit chunk boundary)", async () => {
    const { server, batches } = createFakeBatchServer();
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 3 };
      const requests = Array.from({ length: 7 }, (_, i) => req(i));
      const { succeeded, failed } = await submitRequests(ctx, requests);
      assert.equal(succeeded.length, 7);
      assert.equal(failed.length, 0);
      assert.deepEqual(
        batches.map((b) => b.length),
        [3, 3, 1]
      );
    } finally {
      server.close();
    }
  });

  test("falls back to individual writes when the batch endpoint reports disabled by a substring match, not just the exact sentence", async () => {
    let batchCalls = 0;
    let individualCalls = 0;
    const server = http.createServer(async (req_, res) => {
      if (req_.method === "POST" && req_.url === "/api/batch") {
        batchCalls += 1;
        await readBody(req_);
        // Deliberately different wording than "Batch requests are not
        // allowed." - finding #19 asks for a substring/403 match, not an
        // exact-string one.
        return sendJson(res, 403, { message: "Batch operations are currently disabled for this application." });
      }
      individualCalls += 1;
      assert.equal(req_.headers.authorization, "tok", "individual writes must still carry Authorization");
      const body = await readBody(req_);
      return sendJson(res, 200, { id: "created1", ...body });
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 200 };
      const { succeeded, failed } = await submitRequests(ctx, [req(1), req(2)]);
      assert.equal(batchCalls, 1, "should try batch exactly once before falling back");
      assert.equal(individualCalls, 2);
      assert.equal(succeeded.length, 2);
      assert.equal(failed.length, 0);
      assert.equal(ctx.batchLimit, null, "ctx should remember batch is off for the rest of the run");
    } finally {
      server.close();
    }
  });

  test("a transactional 400 naming one bad row resubmits the rest, rather than failing the whole chunk", async () => {
    const { server, batches } = createFakeBatchServer({
      onBatch: (requests, callNumber) => {
        if (callNumber === 1) {
          // Row index 1 (n === 1) is "bad".
          const badIndex = requests.findIndex((r) => r.body.n === 1);
          return {
            status: 400,
            body: {
              status: 400,
              message: "Batch transaction failed.",
              data: { requests: { [badIndex]: { code: "batch_request_failed", message: "Batch request failed.", response: { data: { n: { message: "bad" } }, message: "Failed to create record.", status: 400 } } } },
            },
          };
        }
        return null; // let the default handler succeed the retry
      },
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 200 };
      const { succeeded, failed } = await submitRequests(ctx, [req(0), req(1), req(2)]);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].meta.n, 1);
      assert.deepEqual(
        succeeded.map((m) => m.n).sort(),
        [0, 2]
      );
      assert.equal(batches.length, 2, "expected exactly one retry (3 requests, then the 2 good ones)");
      assert.deepEqual(batches[1].map((r) => r.body.n).sort(), [0, 2]);
    } finally {
      server.close();
    }
  });

  test("a 400 with no usable per-index map (the batch itself too big) does not spin: halves the batch limit and retries once, then accepts the result", async () => {
    // Simulates finding #9: /api/settings was unreadable so this client
    // picked batchLimit 200, but the real server only allows 2 per call.
    // PocketBase's actual shape for this (confirmed live) is a single
    // validation error object under data.requests, not one entry per
    // request - see pb-client.mjs's isPerIndexErrorMap doc comment.
    let calls = 0;
    const { server, batches } = createFakeBatchServer({
      onBatch: (requests) => {
        calls += 1;
        if (requests.length > 2) {
          return {
            status: 400,
            body: {
              status: 400,
              message: "Invalid batch request data.",
              data: { requests: { code: "validation_length_too_long", message: "The length must be no more than 2.", params: { max: 2, min: 0 } } },
            },
          };
        }
        return null;
      },
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 5 };
      const { succeeded, failed } = await submitRequests(ctx, [req(0), req(1), req(2), req(3), req(4)]);
      assert.equal(ctx.batchLimit, 2, "should have halved 5 -> 2 (floor)");
      assert.equal(succeeded.length, 5);
      assert.equal(failed.length, 0);
      // 1 failed call at size 5, then chunks of 2, 2, 1 all succeeding -
      // termination is what matters (this used to be able to spin
      // forever on a shape it misread as a per-index map).
      assert.ok(calls <= 6, `expected a small, bounded number of calls, got ${calls}`);
      // batches[0] is the original, oversized attempt that triggered the
      // halving in the first place - every attempt *after* it must stay
      // within the new limit.
      assert.ok(batches.slice(1).every((b) => b.length <= 2), "no batch after the halving should exceed the new limit");
    } finally {
      server.close();
    }
  });

  test("gives up (rather than spinning or halving twice) on a second consecutive too-big rejection", async () => {
    const { server } = createFakeBatchServer({
      onBatch: () => ({
        status: 400,
        body: { status: 400, message: "Invalid batch request data.", data: { requests: { code: "validation_length_too_long", message: "too many", params: {} } } },
      }),
    });
    const port = await listenOnFreePort(server);
    try {
      const ctx = { pbUrl: `http://127.0.0.1:${port}`, token: "tok", batchLimit: 4 };
      const { succeeded, failed } = await submitRequests(ctx, [req(0), req(1), req(2), req(3)]);
      assert.equal(succeeded.length, 0);
      assert.equal(failed.length, 4, "every request should end up reported as failed, not lost or retried forever");
    } finally {
      server.close();
    }
  });
});
