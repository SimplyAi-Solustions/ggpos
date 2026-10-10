// The small PocketBase REST client, against a real local http.createServer
// test double - the same pattern services/pricesync's own
// test/pb-client.test.mjs uses, and the one this service's own client can
// actually be tested against (unlike web-push - see push.test.mjs's own
// comment on why that one needs a fake implementation instead).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  authenticate,
  listUnpushedNotifications,
  listPushSubscriptions,
  markPushed,
  deleteSubscription,
} from "../src/lib/pb-client.mjs";

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

describe("authenticate", () => {
  test("posts identity/password to the superuser auth route and returns the token", async () => {
    let seenBody;
    let seenPath;
    const server = http.createServer(async (req, res) => {
      seenPath = req.url;
      seenBody = await readBody(req);
      sendJson(res, 200, { token: "sutok123", record: { id: "su1" } });
    });
    const port = await listenOnFreePort(server);
    try {
      const token = await authenticate(`http://127.0.0.1:${port}`, "admin@example.test", "hunter2");
      assert.equal(token, "sutok123");
      assert.equal(seenPath, "/api/collections/_superusers/auth-with-password");
      assert.deepEqual(seenBody, { identity: "admin@example.test", password: "hunter2" });
    } finally {
      server.close();
    }
  });

  test("a non-2xx response raises an error naming the HTTP status, not a bare parse failure", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 400, { message: "Failed to authenticate." });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => authenticate(`http://127.0.0.1:${port}`, "a@b.test", "wrong"), /HTTP 400/);
    } finally {
      server.close();
    }
  });

  test("a 200 with no token field is still treated as a failure, not a silent undefined token", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 200, { record: { id: "su1" } });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => authenticate(`http://127.0.0.1:${port}`, "a@b.test", "pw"), /no token/);
    } finally {
      server.close();
    }
  });
});

describe("listUnpushedNotifications", () => {
  test("filters on pushed_at = \"\", sorts by created, and pages until it has every row", async () => {
    const allRows = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, pushed_at: "" }));
    const seenFilters = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      seenFilters.push(url.searchParams.get("filter"));
      assert.equal(url.searchParams.get("sort"), "created");
      const page = Number(url.searchParams.get("page"));
      const perPage = Number(url.searchParams.get("perPage"));
      const items = allRows.slice((page - 1) * perPage, page * perPage);
      sendJson(res, 200, { items, page, perPage, totalItems: allRows.length, totalPages: Math.ceil(allRows.length / perPage) });
    });
    const port = await listenOnFreePort(server);
    try {
      const rows = await listUnpushedNotifications(`http://127.0.0.1:${port}`, "tok", { perPage: 2 });
      assert.deepEqual(rows.map((r) => r.id), allRows.map((r) => r.id));
      assert.ok(seenFilters.every((f) => f === 'pushed_at = ""'));
      assert.equal(seenFilters.length, 3, "5 rows at 2 per page should take 3 requests");
    } finally {
      server.close();
    }
  });

  test("an empty collection is a clean empty array, not an error", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 200, { items: [], page: 1, perPage: 200, totalItems: 0, totalPages: 1 });
    });
    const port = await listenOnFreePort(server);
    try {
      const rows = await listUnpushedNotifications(`http://127.0.0.1:${port}`, "tok");
      assert.deepEqual(rows, []);
    } finally {
      server.close();
    }
  });

  test("a failed list request raises rather than being swallowed into an empty list", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 500, { message: "boom" });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => listUnpushedNotifications(`http://127.0.0.1:${port}`, "tok"), /HTTP 500/);
    } finally {
      server.close();
    }
  });
});

describe("listPushSubscriptions", () => {
  test("pages through every push_subscriptions row", async () => {
    const allRows = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, endpoint: `https://push.example.test/${i}` }));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      assert.equal(url.pathname, "/api/collections/push_subscriptions/records");
      const page = Number(url.searchParams.get("page"));
      sendJson(res, 200, { items: page === 1 ? allRows : [], page, perPage: 200, totalItems: allRows.length, totalPages: 1 });
    });
    const port = await listenOnFreePort(server);
    try {
      const rows = await listPushSubscriptions(`http://127.0.0.1:${port}`, "tok");
      assert.deepEqual(rows.map((r) => r.id), allRows.map((r) => r.id));
    } finally {
      server.close();
    }
  });
});

describe("markPushed", () => {
  test("PATCHes pushed_at with the given timestamp, carrying the Authorization header", async () => {
    let seenMethod;
    let seenAuth;
    let seenBody;
    const server = http.createServer(async (req, res) => {
      seenMethod = req.method;
      seenAuth = req.headers.authorization;
      seenBody = await readBody(req);
      sendJson(res, 200, { id: "n1", pushed_at: seenBody.pushed_at });
    });
    const port = await listenOnFreePort(server);
    try {
      await markPushed(`http://127.0.0.1:${port}`, "tok123", "n1", "2026-09-20T12:00:00.000Z");
      assert.equal(seenMethod, "PATCH");
      assert.equal(seenAuth, "tok123");
      assert.deepEqual(seenBody, { pushed_at: "2026-09-20T12:00:00.000Z" });
    } finally {
      server.close();
    }
  });

  test("a non-ok response raises, naming the notification id and the status", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 404, { message: "not found" });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => markPushed(`http://127.0.0.1:${port}`, "tok", "missing1", "2026-01-01T00:00:00.000Z"), /missing1.*HTTP 404/s);
    } finally {
      server.close();
    }
  });
});

describe("deleteSubscription", () => {
  test("DELETEs the subscription's own record", async () => {
    let seenMethod;
    let seenPath;
    const server = http.createServer((req, res) => {
      seenMethod = req.method;
      seenPath = req.url;
      res.writeHead(204);
      res.end();
    });
    const port = await listenOnFreePort(server);
    try {
      await deleteSubscription(`http://127.0.0.1:${port}`, "tok", "sub1");
      assert.equal(seenMethod, "DELETE");
      assert.equal(seenPath, "/api/collections/push_subscriptions/records/sub1");
    } finally {
      server.close();
    }
  });

  test("tolerates a 404 (already gone) rather than raising", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 404, { message: "not found" });
    });
    const port = await listenOnFreePort(server);
    try {
      await deleteSubscription(`http://127.0.0.1:${port}`, "tok", "already-gone");
    } finally {
      server.close();
    }
  });

  test("a different failure (not 404) still raises", async () => {
    const server = http.createServer((req, res) => {
      sendJson(res, 500, { message: "boom" });
    });
    const port = await listenOnFreePort(server);
    try {
      await assert.rejects(() => deleteSubscription(`http://127.0.0.1:${port}`, "tok", "sub1"), /HTTP 500/);
    } finally {
      server.close();
    }
  });
});
