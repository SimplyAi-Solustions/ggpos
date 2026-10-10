// runOnce's own orchestration: which notification goes to which
// subscription, when a dead subscription gets removed, when a
// notification is left unmarked because nothing can be pushed to it yet,
// and that a bad config fails loudly rather than silently doing nothing.
// The fake PocketBase server here is deliberately small - just enough of
// notifications/push_subscriptions to drive runOnce - not a copy of
// pb-client.test.mjs's own per-function tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { runOnce } from "../src/index.mjs";

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

/** A minimal fake PocketBase: in-memory notifications and
 * push_subscriptions, just enough surface for pb-client.mjs's own calls. */
function createFakePocketBase({ notifications = [], subscriptions = [] } = {}) {
  const patches = [];
  const deletes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/api/collections/_superusers/auth-with-password") {
      await readBody(req);
      return sendJson(res, 200, { token: "fake-superuser-token" });
    }

    if (req.method === "GET" && url.pathname === "/api/collections/notifications/records") {
      const unpushed = notifications.filter((n) => !n.pushed_at);
      return sendJson(res, 200, { items: unpushed, page: 1, perPage: 200, totalItems: unpushed.length, totalPages: 1 });
    }

    if (req.method === "GET" && url.pathname === "/api/collections/push_subscriptions/records") {
      return sendJson(res, 200, { items: subscriptions, page: 1, perPage: 200, totalItems: subscriptions.length, totalPages: 1 });
    }

    const patchMatch = req.method === "PATCH" && url.pathname.match(/^\/api\/collections\/notifications\/records\/([\w-]+)$/);
    if (patchMatch) {
      const body = await readBody(req);
      patches.push({ id: patchMatch[1], body });
      const row = notifications.find((n) => n.id === patchMatch[1]);
      if (row) row.pushed_at = body.pushed_at;
      return sendJson(res, 200, row || {});
    }

    const deleteMatch = req.method === "DELETE" && url.pathname.match(/^\/api\/collections\/push_subscriptions\/records\/([\w-]+)$/);
    if (deleteMatch) {
      deletes.push(deleteMatch[1]);
      const idx = subscriptions.findIndex((s) => s.id === deleteMatch[1]);
      if (idx >= 0) subscriptions.splice(idx, 1);
      res.writeHead(204);
      return res.end();
    }

    sendJson(res, 404, { message: "no route" });
  });
  return { server, patches, deletes, notifications, subscriptions };
}

function baseEnv(pbUrl) {
  return {
    PB_URL: pbUrl,
    PB_SUPERUSER_EMAIL: "admin@example.test",
    PB_SUPERUSER_PASSWORD: "hunter2",
    GG_VAPID_PUBLIC_KEY: "pub",
    GG_VAPID_PRIVATE_KEY: "priv",
    GG_VAPID_SUBJECT: "mailto:shop@example.test",
  };
}

function fakeWebpush({ onSend } = {}) {
  return {
    setVapidDetails() {},
    async sendNotification(subscription, payload) {
      if (onSend) return onSend(subscription, payload);
      return { statusCode: 201 };
    },
  };
}

describe("runOnce", () => {
  test("requires every env var up front, naming the missing one, before making any request", async () => {
    // PB_URL is requireEnv's first check, so a wholly empty env fails on
    // that name specifically - proving the check runs (and fails loudly)
    // before any network call, not that some fetch merely rejected later.
    await assert.rejects(() => runOnce({}), /Missing required environment variable PB_URL/);
  });

  test("passes once PB_URL is set but still fails naming the next missing var, rather than stopping short", async () => {
    await assert.rejects(() => runOnce({ PB_URL: "http://127.0.0.1:1" }), /Missing required environment variable PB_SUPERUSER_EMAIL/);
  });

  test("pushes a customer notification to that customer's one subscription and marks it pushed", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust1", staff: "", title: "Held for you", body: "It is in", link: "/account/wants", pushed_at: "" }],
      subscriptions: [{ id: "sub1", customer: "cust1", staff: "", endpoint: "https://push.example.test/1", keys: { p256dh: "p", auth: "a" } }],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sent = [];
      const webpush = fakeWebpush({
        onSend: (sub, payload) => {
          sent.push({ sub, payload: JSON.parse(payload) });
          return { statusCode: 201 };
        },
      });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), {
        webpushImpl: webpush,
        now: () => new Date("2026-09-20T12:00:00.000Z"),
        log: () => {},
        warn: () => {},
      });

      assert.deepEqual(result, { total: 1, pushed: 1, removed: 0, skippedNoSubscription: 0 });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].sub.endpoint, "https://push.example.test/1");
      assert.deepEqual(sent[0].payload, { title: "Held for you", body: "It is in", link: "/account/wants", tag: "n1" });
      assert.equal(fake.patches.length, 1);
      assert.deepEqual(fake.patches[0], { id: "n1", body: { pushed_at: "2026-09-20T12:00:00.000Z" } });
    } finally {
      fake.server.close();
    }
  });

  test("pushes a staff notification to that staff member's subscription", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "", staff: "staff1", title: "New quote submitted", body: "...", link: "/counter/quotes/q1", pushed_at: "" }],
      subscriptions: [{ id: "sub1", customer: "", staff: "staff1", endpoint: "https://push.example.test/staff", keys: {} }],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sent = [];
      const webpush = fakeWebpush({ onSend: (sub) => (sent.push(sub), { statusCode: 201 }) });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.equal(result.pushed, 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].endpoint, "https://push.example.test/staff");
    } finally {
      fake.server.close();
    }
  });

  test("a notification for a customer with no subscription yet is left unmarked, not treated as failed", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust-no-device", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const webpush = fakeWebpush();
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 1, pushed: 0, removed: 0, skippedNoSubscription: 1 });
      assert.equal(fake.patches.length, 0, "an un-pushed notification must not be marked pushed - it stays eligible once a subscription exists");
    } finally {
      fake.server.close();
    }
  });

  test("a subscription answering 404 is deleted, and the notification is still marked pushed", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust1", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [{ id: "dead-sub", customer: "cust1", staff: "", endpoint: "https://push.example.test/dead", keys: {} }],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const err = new Error("Received unexpected response code");
      err.statusCode = 404;
      const webpush = fakeWebpush({
        onSend: () => {
          throw err;
        },
      });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 1, pushed: 1, removed: 1, skippedNoSubscription: 0 });
      assert.deepEqual(fake.deletes, ["dead-sub"]);
      assert.equal(fake.subscriptions.length, 0);
      assert.equal(fake.patches.length, 1, "the notification is still marked pushed even though its one subscription turned out to be dead");
    } finally {
      fake.server.close();
    }
  });

  test("a transient failure (not gone) is warned about, the subscription survives, and the notification is left unmarked for a retry", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust1", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [{ id: "sub1", customer: "cust1", staff: "", endpoint: "https://push.example.test/flaky", keys: {} }],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const err = new Error("Received unexpected response code");
      err.statusCode = 500;
      const webpush = fakeWebpush({
        onSend: () => {
          throw err;
        },
      });
      const warnings = [];
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: (m) => warnings.push(m) });
      // Not pushed: 1 (fix round, finding 6) - a transient failure must
      // never be recorded as delivered, or it would never be retried.
      assert.deepEqual(result, { total: 1, pushed: 0, removed: 0, skippedNoSubscription: 0 });
      assert.equal(fake.notifications[0].pushed_at, "", "pushed_at must stay empty so the next pass retries this notification");
      assert.equal(fake.subscriptions.length, 1, "a merely-failed send must not remove the subscription");
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(warnings[0], /push\.example\.test/, "a warned failure must never log the subscription's own endpoint");
    } finally {
      fake.server.close();
    }
  });

  test("a customer with notify_push off is never sent to, and the notification is left unmarked (fix round, finding 5)", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust-opted-out", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [
        {
          id: "sub1",
          customer: "cust-opted-out",
          staff: "",
          endpoint: "https://push.example.test/opted-out",
          keys: {},
          expand: { customer: { id: "cust-opted-out", notify_push: false } },
        },
      ],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sent = [];
      const webpush = fakeWebpush({ onSend: (sub) => (sent.push(sub), { statusCode: 201 }) });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 1, pushed: 0, removed: 0, skippedNoSubscription: 1 });
      assert.equal(sent.length, 0, "a subscription for an opted-out customer must never be sent to");
    } finally {
      fake.server.close();
    }
  });

  test("a customer with notify_push on (the explicit true, not just unset) is still sent to", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust-opted-in", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [
        {
          id: "sub1",
          customer: "cust-opted-in",
          staff: "",
          endpoint: "https://push.example.test/opted-in",
          keys: {},
          expand: { customer: { id: "cust-opted-in", notify_push: true } },
        },
      ],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sent = [];
      const webpush = fakeWebpush({ onSend: (sub) => (sent.push(sub), { statusCode: 201 }) });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 1, pushed: 1, removed: 0, skippedNoSubscription: 0 });
      assert.equal(sent.length, 1);
    } finally {
      fake.server.close();
    }
  });

  test("a subscription whose customer expand cannot be resolved fails open (still sent to), rather than silently going quiet", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust-unresolved", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [
        { id: "sub1", customer: "cust-unresolved", staff: "", endpoint: "https://push.example.test/no-expand", keys: {} },
      ],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sent = [];
      const webpush = fakeWebpush({ onSend: (sub) => (sent.push(sub), { statusCode: 201 }) });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 1, pushed: 1, removed: 0, skippedNoSubscription: 0 });
      assert.equal(sent.length, 1);
    } finally {
      fake.server.close();
    }
  });

  test("multiple devices for one customer each get the push, and the notification is marked pushed once both are tried", async () => {
    const fake = createFakePocketBase({
      notifications: [{ id: "n1", customer: "cust1", staff: "", title: "t", body: "b", link: "/account/notifications", pushed_at: "" }],
      subscriptions: [
        { id: "sub1", customer: "cust1", staff: "", endpoint: "https://push.example.test/phone", keys: {} },
        { id: "sub2", customer: "cust1", staff: "", endpoint: "https://push.example.test/laptop", keys: {} },
      ],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const sentEndpoints = [];
      const webpush = fakeWebpush({ onSend: (sub) => (sentEndpoints.push(sub.endpoint), { statusCode: 201 }) });
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.equal(result.pushed, 1, "one notification marked pushed once, not once per device");
      assert.deepEqual(sentEndpoints.sort(), ["https://push.example.test/laptop", "https://push.example.test/phone"]);
      assert.equal(fake.patches.length, 1);
    } finally {
      fake.server.close();
    }
  });

  test("several unpushed notifications in one pass are each handled independently", async () => {
    const fake = createFakePocketBase({
      notifications: [
        { id: "n1", customer: "cust1", staff: "", title: "t1", body: "b1", link: "/account/notifications", pushed_at: "" },
        { id: "n2", customer: "cust2", staff: "", title: "t2", body: "b2", link: "/account/notifications", pushed_at: "" },
      ],
      subscriptions: [{ id: "sub1", customer: "cust1", staff: "", endpoint: "https://push.example.test/1", keys: {} }],
    });
    const port = await listenOnFreePort(fake.server);
    try {
      const webpush = fakeWebpush();
      const result = await runOnce(baseEnv(`http://127.0.0.1:${port}`), { webpushImpl: webpush, log: () => {}, warn: () => {} });
      assert.deepEqual(result, { total: 2, pushed: 1, removed: 0, skippedNoSubscription: 1 });
    } finally {
      fake.server.close();
    }
  });
});
