// Web Push sending, and telling a dead subscription apart from a
// transient failure. Kept to this one small module so index.mjs's main
// loop never touches the web-push library directly - tests inject a fake
// implementation with the same two-method shape (setVapidDetails,
// sendNotification) instead of a real VAPID keypair and a real push
// service.
"use strict";

/**
 * @param {{setVapidDetails: Function, sendNotification: Function}} webpush
 * @param {{subject: string, publicKey: string, privateKey: string}} vapid
 */
export function configure(webpush, vapid) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
}

/**
 * Send one Web Push message. The payload is always exactly
 * `{ title, body, link, tag }` - the portal's own service worker expects
 * this shape and opens `link` on a click; `tag` is the notification row's
 * own id, so if this sidecar's own retry logic (there is none today, but
 * a future one) ever sent the same notification twice, the second push
 * would replace the first rather than stacking a duplicate.
 *
 * Returns `{ sent: true }`, `{ sent: false, gone: true }` for a 404/410
 * (the subscription is dead - the caller deletes it) or
 * `{ sent: false, gone: false, error }` for anything else (left alone, so
 * a transient failure is retried on the next notification to that same
 * target, which markPushed's own per-row semantics already keeps possible
 * since nothing here ever half-writes a notification's own pushed_at).
 * Never throws - a bad subscription or a push-service outage must not stop
 * this sidecar's whole run.
 */
export async function sendPush(webpush, subscription, notification) {
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    link: notification.link || "",
    tag: notification.id,
  });
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      payload
    );
    return { sent: true };
  } catch (err) {
    const status = err && (err.statusCode || err.status);
    if (status === 404 || status === 410) {
      return { sent: false, gone: true };
    }
    // Never the endpoint or the keys - both are credentials
    // (docs/PLAN.md's own "never log an endpoint or a key" rule).
    return { sent: false, gone: false, error: (err && err.message) || String(err) };
  }
}
