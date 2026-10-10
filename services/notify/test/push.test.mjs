// push.mjs against a fake { setVapidDetails, sendNotification } - never a
// real web-push call: the library always speaks HTTPS regardless of the
// subscription endpoint's own scheme (confirmed against web-push's own
// source, web-push-lib.js), so a plain local http.createServer test
// double cannot stand in for a push service the way one does for
// PocketBase in pb-client.test.mjs. A fake with the same two-method shape
// is the one way to exercise sendPush's own branching without a real
// VAPID keypair or a real endpoint.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { configure, sendPush } from "../src/lib/push.mjs";

function fakeWebpush({ onSend } = {}) {
  const calls = { setVapidDetails: [], sendNotification: [] };
  return {
    calls,
    webpush: {
      setVapidDetails(subject, publicKey, privateKey) {
        calls.setVapidDetails.push({ subject, publicKey, privateKey });
      },
      async sendNotification(subscription, payload) {
        calls.sendNotification.push({ subscription, payload });
        if (onSend) return onSend(subscription, payload);
        return { statusCode: 201 };
      },
    },
  };
}

function webPushError(statusCode) {
  // Mirrors web-push-error.js's own shape exactly: message is always the
  // fixed string, never the endpoint - see push.mjs's own doc comment on
  // why logging err.message alone never leaks a subscription's identity.
  const err = new Error("Received unexpected response code");
  err.statusCode = statusCode;
  err.endpoint = "https://push.example.test/some-very-identifying-path";
  err.body = "some response body";
  return err;
}

describe("configure", () => {
  test("passes subject, publicKey and privateKey through to setVapidDetails in order", () => {
    const { webpush, calls } = fakeWebpush();
    configure(webpush, { subject: "mailto:shop@example.test", publicKey: "pub123", privateKey: "priv456" });
    assert.deepEqual(calls.setVapidDetails, [{ subject: "mailto:shop@example.test", publicKey: "pub123", privateKey: "priv456" }]);
  });
});

describe("sendPush", () => {
  test("returns { sent: true } and builds the exact { title, body, link, tag } payload the service worker expects", async () => {
    const { webpush, calls } = fakeWebpush();
    const subscription = { endpoint: "https://push.example.test/abc", keys: { p256dh: "p", auth: "a" } };
    const notification = { id: "notif1", title: "Your quote offer", body: "We have offered you 28.00", link: "/account/quotes/notif1" };

    const result = await sendPush(webpush, subscription, notification);

    assert.deepEqual(result, { sent: true });
    assert.equal(calls.sendNotification.length, 1);
    assert.deepEqual(calls.sendNotification[0].subscription, { endpoint: subscription.endpoint, keys: subscription.keys });
    assert.deepEqual(JSON.parse(calls.sendNotification[0].payload), {
      title: "Your quote offer",
      body: "We have offered you 28.00",
      link: "/account/quotes/notif1",
      tag: "notif1",
    });
  });

  test("an empty link becomes an empty string in the payload, never null or undefined", async () => {
    const { webpush } = fakeWebpush();
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/x", keys: {} }, { id: "n2", title: "t", body: "b" });
    assert.equal(result.sent, true);
  });

  test("a 404 response is reported as gone, not as a generic failure", async () => {
    const { webpush } = fakeWebpush({
      onSend: () => {
        throw webPushError(404);
      },
    });
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/dead", keys: {} }, { id: "n3", title: "t", body: "b" });
    assert.deepEqual(result, { sent: false, gone: true });
  });

  test("a 410 response is also reported as gone (the other 'subscription is dead' status)", async () => {
    const { webpush } = fakeWebpush({
      onSend: () => {
        throw webPushError(410);
      },
    });
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/dead", keys: {} }, { id: "n4", title: "t", body: "b" });
    assert.deepEqual(result, { sent: false, gone: true });
  });

  test("a 500 is reported as a plain failure, not gone, and carries only the fixed error message - never the endpoint or the response body", async () => {
    const { webpush } = fakeWebpush({
      onSend: () => {
        throw webPushError(500);
      },
    });
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/still-alive", keys: {} }, { id: "n5", title: "t", body: "b" });
    assert.equal(result.sent, false);
    assert.equal(result.gone, false);
    assert.equal(result.error, "Received unexpected response code");
    assert.doesNotMatch(result.error, /push\.example\.test/, "the error string must never carry the subscription's own endpoint");
  });

  test("never throws even when sendNotification rejects with something that is not a WebPushError at all", async () => {
    const { webpush } = fakeWebpush({
      onSend: () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/y", keys: {} }, { id: "n6", title: "t", body: "b" });
    assert.deepEqual(result, { sent: false, gone: false, error: "ECONNRESET" });
  });

  test("falls back to String(err) when the rejection has no .message at all", async () => {
    const { webpush } = fakeWebpush({
      onSend: () => {
        throw "a bare string rejection";
      },
    });
    const result = await sendPush(webpush, { endpoint: "https://push.example.test/z", keys: {} }, { id: "n7", title: "t", body: "b" });
    assert.equal(result.sent, false);
    assert.equal(result.gone, false);
    assert.match(result.error, /a bare string rejection/);
  });
});
