// A small PocketBase REST client: just enough for the notify sidecar's own
// needs (superuser auth, reading notifications and push_subscriptions,
// stamping pushed_at, deleting a dead subscription). Deliberately not a
// copy of services/pricesync's own pb-client.mjs: that one also drives the
// Batch API for a nightly bulk upsert, which this sidecar has no use for -
// every write here is a single small PATCH or DELETE.
//
// Uses the platform's own fetch (Node >= 18) rather than a hand-rolled
// http.mjs, since nothing here needs pricesync's streaming/caching layer.

/** Authenticate as a PocketBase superuser - same route pricesync itself
 * uses (auth collections were merged into `_superusers` in PocketBase
 * 0.23+; this repo pins 0.40.4). */
export async function authenticate(pbUrl, identity, password) {
  const res = await fetch(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity, password }),
  });
  if (!res.ok) {
    throw new Error(`PocketBase superuser auth failed: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json?.token) throw new Error("PocketBase auth succeeded but returned no token");
  return json.token;
}

async function pbFetch(pbUrl, token, path, init = {}) {
  const res = await fetch(`${pbUrl}${path}`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  return res;
}

/** Every `notifications` row with an empty `pushed_at`, oldest first, in
 * fixed-size pages (never one unbounded read - the same convention
 * pb_hooks/lib/reports/query.js's own findAllByFilter uses for an
 * unbounded list). */
export async function listUnpushedNotifications(pbUrl, token, { perPage = 200 } = {}) {
  const items = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      filter: 'pushed_at = ""',
      sort: "created",
    });
    const res = await pbFetch(pbUrl, token, `/api/collections/notifications/records?${qs}`);
    if (!res.ok) throw new Error(`listing notifications failed: HTTP ${res.status}`);
    const json = await res.json();
    items.push(...(json.items || []));
    if (page >= Number(json.totalPages) || (json.items || []).length === 0) break;
    page += 1;
  }
  return items;
}

/** Every push_subscriptions row - a small table (one per device per
 * customer/staff member), so one unpaged-in-practice read is fine; still
 * pages defensively in case it ever grows past one page.
 *
 * `expand=customer` inlines each row's own customer (`notify_push`
 * included) in this same response, so index.mjs can honour a customer's
 * opt-out without a second round trip per subscription or a separate
 * whole-collection customers fetch. A row with no `customer` (a staff
 * subscription) simply has no `expand.customer` - staff have no push
 * opt-out to check, the same asymmetry lib/notify.js's own email side
 * already has (only a customer's `notify_email` is ever checked). */
export async function listPushSubscriptions(pbUrl, token) {
  const items = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page), perPage: "200", expand: "customer" });
    const res = await pbFetch(pbUrl, token, `/api/collections/push_subscriptions/records?${qs}`);
    if (!res.ok) throw new Error(`listing push_subscriptions failed: HTTP ${res.status}`);
    const json = await res.json();
    items.push(...(json.items || []));
    if (page >= Number(json.totalPages) || (json.items || []).length === 0) break;
    page += 1;
  }
  return items;
}

/** Stamp `pushed_at` on a notification row, once every subscription for
 * its target has been tried (win or lose - see index.mjs's own comment on
 * why a per-device failure never blocks this). */
export async function markPushed(pbUrl, token, notificationId, whenIso) {
  const res = await pbFetch(pbUrl, token, `/api/collections/notifications/records/${notificationId}`, {
    method: "PATCH",
    body: JSON.stringify({ pushed_at: whenIso }),
  });
  if (!res.ok) throw new Error(`marking notification ${notificationId} pushed failed: HTTP ${res.status}`);
}

/** Remove a subscription that answered 404 or 410 - it is gone on the
 * push service's own side and sending to it again would only ever repeat
 * the same failure. */
export async function deleteSubscription(pbUrl, token, subscriptionId) {
  const res = await pbFetch(pbUrl, token, `/api/collections/push_subscriptions/records/${subscriptionId}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleting push_subscriptions/${subscriptionId} failed: HTTP ${res.status}`);
  }
}
