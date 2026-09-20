#!/usr/bin/env node
// notify: the push sidecar (docs/PLAN.md, "Email and push";
// docs/api-contract.md's Phase 5 section).
//
// Every minute, reads `notifications` rows PocketBase has not pushed yet
// (`pushed_at` empty) for a customer or staff member who has at least one
// `push_subscriptions` row, sends each through Web Push
// (VAPID keys from GG_VAPID_PUBLIC_KEY / GG_VAPID_PRIVATE_KEY /
// GG_VAPID_SUBJECT), marks `pushed_at`, and deletes a subscription that
// answers 404 or 410 (gone on the push service's own side). Never logs an
// endpoint or a key - see lib/push.mjs's own comment on why that is safe
// even when a send fails and its error is logged.
//
// A long-running process, not a run-once-and-exit script like
// services/pricesync: "every minute" reads far better as one process with
// its own interval than as a `docker compose run --rm` invoked by a host
// cron every single minute (the container-start overhead alone would be a
// meaningful fraction of the interval). See deploy/docker-compose.yml's
// own comment on its "notify" service for how this is actually scheduled.
import { pathToFileURL } from "node:url";
import webpushDefault from "web-push";

import {
  authenticate,
  listUnpushedNotifications,
  listPushSubscriptions,
  markPushed,
  deleteSubscription,
} from "./lib/pb-client.mjs";
import { configure, sendPush } from "./lib/push.mjs";

const POLL_MS = 60_000;

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

/**
 * One full pass: read every unpushed notification and every push
 * subscription, push to whichever of a notification's target's
 * subscriptions exist, mark the notification pushed, remove any dead
 * subscription. `env` and the injectable options default to the real
 * thing; tests pass a fake `webpushImpl` (matching web-push's own
 * `{ setVapidDetails, sendNotification }` shape) and point `env.PB_URL` at
 * a local fake PocketBase instead.
 *
 * Returns `{ total, pushed, removed, skippedNoSubscription }` and never
 * throws for a single notification's or subscription's own failure - only
 * for something that stops the whole pass (bad config, cannot reach or
 * authenticate to PocketBase).
 */
export async function runOnce(
  env = process.env,
  { now = () => new Date(), webpushImpl = webpushDefault, log = console.log, warn = console.warn } = {}
) {
  const pbUrl = requireEnv(env, "PB_URL").replace(/\/+$/, "");
  const email = requireEnv(env, "PB_SUPERUSER_EMAIL");
  const password = requireEnv(env, "PB_SUPERUSER_PASSWORD");
  const vapidPublicKey = requireEnv(env, "GG_VAPID_PUBLIC_KEY");
  const vapidPrivateKey = requireEnv(env, "GG_VAPID_PRIVATE_KEY");
  const vapidSubject = requireEnv(env, "GG_VAPID_SUBJECT");

  configure(webpushImpl, { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey });

  const token = await authenticate(pbUrl, email, password);

  const [notifications, subscriptions] = await Promise.all([
    listUnpushedNotifications(pbUrl, token),
    listPushSubscriptions(pbUrl, token),
  ]);

  // Grouped once per pass rather than one push_subscriptions query per
  // notification - a small table, read whole, the same reasoning
  // pb_hooks/lib/reports/query.js's own batched lookups use for a child
  // collection keyed by a handful of parent ids.
  const byCustomer = new Map();
  const byStaff = new Map();
  for (const sub of subscriptions) {
    if (sub.customer) {
      if (!byCustomer.has(sub.customer)) byCustomer.set(sub.customer, []);
      byCustomer.get(sub.customer).push(sub);
    }
    if (sub.staff) {
      if (!byStaff.has(sub.staff)) byStaff.set(sub.staff, []);
      byStaff.get(sub.staff).push(sub);
    }
  }

  let pushed = 0;
  let removed = 0;
  let skippedNoSubscription = 0;

  for (const notification of notifications) {
    const targetSubs = notification.customer
      ? byCustomer.get(notification.customer)
      : notification.staff
        ? byStaff.get(notification.staff)
        : null;

    if (!targetSubs || targetSubs.length === 0) {
      // Left with pushed_at empty rather than marked and skipped: a
      // customer or staff member with no device subscribed yet is not a
      // failure, and the row becomes eligible the moment one exists
      // (docs/api-contract.md's Phase 5 section) - never retried as if it
      // had been tried and failed, because it never was tried at all.
      skippedNoSubscription += 1;
      continue;
    }

    for (const sub of targetSubs) {
      const result = await sendPush(webpushImpl, sub, notification);
      if (result.gone) {
        try {
          await deleteSubscription(pbUrl, token, sub.id);
          removed += 1;
        } catch (err) {
          warn(`[notify] could not remove a dead subscription: ${err.message}`);
        }
      } else if (!result.sent) {
        // Never the endpoint or the keys - push.mjs's own sendPush only
        // ever hands back web-push's fixed error message, never the
        // endpoint or response body it also carries.
        warn(`[notify] push failed for notification ${notification.id}: ${result.error}`);
      }
    }

    // Marked pushed once every subscription for this target has been
    // tried, whatever the individual outcomes - a transient failure on one
    // device is not retried forever, the same "best effort, not a queue"
    // reasoning the email side of lib/notify.js already follows (a failed
    // send there is logged, not retried, either).
    try {
      await markPushed(pbUrl, token, notification.id, now().toISOString());
      pushed += 1;
    } catch (err) {
      warn(`[notify] could not mark notification ${notification.id} pushed: ${err.message}`);
    }
  }

  log(
    `[notify] pass complete: ${notifications.length} unpushed, ${pushed} marked pushed, ${removed} dead subscription(s) removed, ${skippedNoSubscription} skipped (no subscription yet)`
  );
  return { total: notifications.length, pushed, removed, skippedNoSubscription };
}

let stopping = false;

async function mainLoop() {
  console.log(`[notify] starting, polling every ${POLL_MS / 1000}s`);
  process.on("SIGTERM", () => {
    console.log("[notify] SIGTERM received, stopping after the current pass");
    stopping = true;
  });
  process.on("SIGINT", () => {
    console.log("[notify] SIGINT received, stopping after the current pass");
    stopping = true;
  });

  while (!stopping) {
    try {
      await runOnce();
    } catch (err) {
      console.error(`[notify] pass failed: ${err.message}`);
    }
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log("[notify] stopped");
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  mainLoop();
}
