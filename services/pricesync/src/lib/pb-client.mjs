// A small PocketBase REST client: just enough for pricesync's needs
// (superuser auth, paged listing, and upserting through /api/batch with a
// graceful fallback when that API is switched off or capped below the
// batch size this service wants to use).
//
// Verified empirically against a throwaway PocketBase v0.40.4 instance
// built from this repo's own migrations/hooks (including
// pb_migrations/1789819980_batch_api_settings.js, which turns the Batch
// API on with maxRequests 200) rather than assumed from the docs - see the
// comments on submitBatchChunk below for the exact response shapes this
// was checked against.
import { requestJson, HttpError } from "./http.mjs";

const BATCH_REQUEST_TIMEOUT_MS = 90_000; // above the server's own 60s batch transaction timeout (pb_migrations/1789819980_batch_api_settings.js), so this client never gives up on a batch call before PocketBase itself would.

/** Authenticate as a PocketBase superuser. Auth collections were merged
 * into `_superusers` in PocketBase 0.23+ (this repo pins 0.40.4 - see
 * pb/scripts/dev.sh and pb/scripts/check.sh, which authenticates the same
 * way). */
export async function authenticate(pbUrl, identity, password) {
  let json;
  try {
    ({ json } = await requestJson(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      body: { identity, password },
    }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 0) {
      throw new Error(`Cannot reach PocketBase at ${pbUrl}. Check the pocketbase container is running.`);
    }
    throw err;
  }
  if (!json?.token) throw new Error("PocketBase auth succeeded but returned no token");
  return json.token;
}

/**
 * Best-effort read of this instance's Batch API settings. Returns null
 * when the endpoint cannot be read (older PocketBase, or a superuser
 * without settings access) - callers then fall back to probing batch
 * reactively on the first write instead of failing the whole run over a
 * settings read.
 */
export async function fetchBatchSettings(pbUrl, token) {
  try {
    const { status, json } = await requestJson(`${pbUrl}/api/settings`, {
      headers: { Authorization: token },
      allowErrorStatus: true,
    });
    if (status !== 200 || !json?.batch) return null;
    return {
      enabled: Boolean(json.batch.enabled),
      maxRequests: Number(json.batch.maxRequests) || 0,
    };
  } catch {
    return null;
  }
}

function buildListQuery({ filter, fields, sort, page, perPage }) {
  const qs = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (filter) qs.set("filter", filter);
  if (fields) qs.set("fields", fields);
  if (sort) qs.set("sort", sort);
  return qs;
}

/** Page through every record in `collection` matching `filter`, returning
 * only `fields` when given. Used for both the initial cards load (a
 * handful of fields, every matching row) and small full-collection reads
 * (games, existing today's price_snapshots). For "just the single most
 * recent row" (fx_rates), use getFirst instead - it makes one request
 * regardless of how many rows the collection holds, where this would make
 * one request per row when perPage is 1. */
export async function getFullList(pbUrl, token, collection, { filter, fields, sort, perPage = 200 } = {}) {
  const items = [];
  let page = 1;
  for (;;) {
    const qs = buildListQuery({ filter, fields, sort, page, perPage });
    const { json } = await requestJson(`${pbUrl}/api/collections/${collection}/records?${qs}`, {
      headers: { Authorization: token },
    });
    items.push(...(json.items || []));
    // json.totalPages arrives as a decimal string, not a number, like
    // every other value this service reads (see json-stream.mjs) - made
    // explicit here rather than relying on `>=`'s numeric coercion of a
    // string operand, which is easy to misread as a bug on re-reading.
    if (page >= Number(json.totalPages) || (json.items || []).length === 0) break;
    page += 1;
  }
  return items;
}

/** The first record matching `filter`/`sort`, or null - a single request
 * regardless of how many rows the collection holds (unlike
 * `getFullList(..., { perPage: 1 })`, which would page through every row
 * one at a time to get there). Used for "the latest fx_rates row". */
export async function getFirst(pbUrl, token, collection, { filter, fields, sort } = {}) {
  const qs = buildListQuery({ filter, fields, sort, page: 1, perPage: 1 });
  const { json } = await requestJson(`${pbUrl}/api/collections/${collection}/records?${qs}`, {
    headers: { Authorization: token },
  });
  return (json.items && json.items[0]) || null;
}

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

/** Turn one failed batch sub-request's PocketBase error body into a short,
 * human-readable line for the log (field-level validation errors, not
 * just "Failed to create record."). */
function describeBatchItemError(detail) {
  const inner = detail?.response;
  const data = inner?.data;
  if (data && typeof data === "object" && Object.keys(data).length > 0) {
    const fieldErrors = Object.entries(data)
      .map(([field, e]) => `${field}: ${e?.message || e?.code || "invalid"}`)
      .join(", ");
    return `${inner.message || "validation failed"} (${fieldErrors})`;
  }
  return inner?.message || detail?.message || "batch item failed";
}

/**
 * True only when `perIndex` is a genuine "which of my requests failed"
 * map - every key a numeric string within range - as PocketBase sends for
 * a transactional batch failure (one bad row rolls the whole chunk back:
 * `{"data":{"requests":{"1":{"code":"batch_request_failed",...}}},
 * "message":"Batch transaction failed.","status":400}`, confirmed live).
 *
 * PocketBase reuses the same `data.requests` field name for a completely
 * different error shape when the chunk itself is too big for its
 * `Max requests` setting - a single validation error object, keys "code"/
 * "message"/"params", not one entry per request:
 * `{"data":{"requests":{"code":"validation_length_too_long",
 * "message":"The length must be no more than 2.","params":{"max":2,...}}},
 * "message":"Invalid batch request data.","status":400}` (confirmed live
 * against a maxRequests of 2). Treating that as a per-index map would
 * "shrink" the batch by removing entries named "code", "message" and
 * "params" - `Object.keys(...).map(Number)` on those is three NaNs - so
 * this checks the keys are actually indices before trusting either shape.
 */
function isPerIndexErrorMap(perIndex, pendingLength) {
  if (!perIndex || typeof perIndex !== "object") return false;
  const keys = Object.keys(perIndex);
  if (keys.length === 0) return false;
  return keys.every((k) => /^\d+$/.test(k) && Number(k) < pendingLength);
}

/** A 403 whose message mentions "batch" - matched loosely (403 plus a
 * substring, not the exact sentence PocketBase happens to use today) so a
 * future wording change does not silently stop the fallback from
 * triggering. Restricted to a 403 specifically mentioning batch, rather
 * than any 403, so a genuine permission problem on the token itself is
 * not misread as "batch is off" and quietly retried hundreds of times
 * one record at a time instead of being reported. */
function looksLikeBatchDisabled(status, json) {
  if (status !== 403) return false;
  return (json?.message || "").toLowerCase().includes("batch");
}

const BATCH_DISABLED_WARNING =
  "[pricesync] Batch API is disabled on this PocketBase instance (Settings > Application > " +
  "Batch requests). Falling back to individual record writes for the rest of this run, which " +
  "is slower. Enable it, with Max requests at least 200, to speed pricesync up.";

/** Submit one chunk (at most ctx.batchLimit requests) through POST
 * /api/batch. PocketBase's batch endpoint is transactional: if ANY
 * sub-request in the chunk fails validation, the WHOLE chunk is rolled
 * back with an outer 400 and a per-index error map (isPerIndexErrorMap's
 * doc comment above has the confirmed shape). So a single bad row must
 * not cost every other row in the chunk: this pulls the bad indices out
 * (logging why) and resubmits the rest, shrinking by at least one request
 * each time until either everything left succeeds or nothing is left to
 * retry.
 *
 * A 400 with no usable per-index map (the "chunk itself is too big" shape
 * above) is reported back via `tooMany: true` instead of being treated as
 * every row failing outright - submitRequests decides whether to halve
 * the batch size and retry, or give up, since only it knows whether that
 * has been tried already for this run.
 */
async function submitBatchChunk(ctx, requests) {
  let pending = requests.map((r, i) => ({ ...r, _i: i }));
  const succeeded = [];
  const failed = [];
  let firstAttempt = true;

  while (pending.length > 0) {
    let status;
    let json;
    try {
      ({ status, json } = await requestJson(`${ctx.pbUrl}/api/batch`, {
        method: "POST",
        headers: { Authorization: ctx.token },
        body: { requests: pending.map((r) => ({ method: r.method, url: r.url, body: r.body })) },
        timeoutMs: BATCH_REQUEST_TIMEOUT_MS,
        allowErrorStatus: true,
      }));
    } catch (err) {
      for (const r of pending) failed.push({ meta: r.meta, error: err.message });
      pending = [];
      break;
    }

    if (firstAttempt && looksLikeBatchDisabled(status, json)) {
      return { disabled: true, tooMany: false, succeeded: [], failed: [] };
    }
    firstAttempt = false;

    if (status >= 200 && status < 300) {
      const bodies = Array.isArray(json) ? json : [];
      for (let i = 0; i < pending.length; i += 1) {
        const meta = pending[i].meta;
        // The created/updated record's id, so upsert-queue.mjs can PATCH
        // a row this run already created if the same (card, finish,
        // source) key is queued again later (see its own doc comment).
        const createdId = bodies[i]?.body?.id;
        if (createdId) meta.id = createdId;
        succeeded.push(meta);
      }
      pending = [];
      break;
    }

    const perIndex = json?.data?.requests;
    if (status === 400 && isPerIndexErrorMap(perIndex, pending.length)) {
      const badIndices = new Set(Object.keys(perIndex).map(Number));
      const next = [];
      for (let i = 0; i < pending.length; i += 1) {
        if (badIndices.has(i)) {
          failed.push({ meta: pending[i].meta, error: describeBatchItemError(perIndex[String(i)]) });
        } else {
          next.push(pending[i]);
        }
      }
      pending = next;
      continue;
    }

    if (status === 400 && !isPerIndexErrorMap(perIndex, pending.length) && pending.length > 1) {
      // The chunk was rejected outright with no per-row detail - most
      // likely larger than this server's own Max requests setting.
      // submitRequests decides whether to halve and retry (once) or
      // accept this as final, since only it tracks whether that has
      // already been tried this run.
      for (const r of pending) {
        failed.push({ meta: r.meta, error: json?.message || `HTTP 400 (batch of ${pending.length} rejected outright, no per-row detail)` });
      }
      return { disabled: false, tooMany: true, succeeded, failed };
    }

    for (const r of pending) {
      failed.push({ meta: r.meta, error: `HTTP ${status}${json?.message ? `: ${json.message}` : ""}` });
    }
    pending = [];
  }

  return { disabled: false, tooMany: false, succeeded, failed };
}

/** Same upsert, one request at a time through the ordinary records API.
 * Used when the batch endpoint is disabled or capped too low to bother
 * with. */
async function submitIndividually(ctx, requests) {
  const succeeded = [];
  const failed = [];
  for (const r of requests) {
    try {
      const { status, json } = await requestJson(`${ctx.pbUrl}${r.url}`, {
        method: r.method,
        headers: { Authorization: ctx.token },
        body: r.body,
        allowErrorStatus: true,
      });
      if (status >= 200 && status < 300) {
        if (json?.id) r.meta.id = json.id;
        succeeded.push(r.meta);
      } else {
        failed.push({ meta: r.meta, error: `HTTP ${status}${json?.message ? `: ${json.message}` : ""}` });
      }
    } catch (err) {
      failed.push({ meta: r.meta, error: err.message });
    }
  }
  return { succeeded, failed };
}

/**
 * Create a submission context. `batchLimit` is the number of requests to
 * put in each /api/batch call (at most the requested size and the
 * server's own configured maxRequests, when that could be read), or null
 * when batch is known to be off - submitRequests then writes one record
 * at a time instead of failing the run.
 */
export async function createSubmitContext(pbUrl, token, { requestedBatchSize = 200 } = {}) {
  const settings = await fetchBatchSettings(pbUrl, token);
  if (settings && !settings.enabled) {
    console.warn(BATCH_DISABLED_WARNING);
    return { pbUrl, token, batchLimit: null };
  }
  const cap = settings?.maxRequests > 0 ? settings.maxRequests : requestedBatchSize;
  return { pbUrl, token, batchLimit: Math.max(1, Math.min(requestedBatchSize, cap)) };
}

/**
 * Submit a list of `{method, url, body, meta}` requests as upserts,
 * preferring PocketBase's batch API in chunks of `ctx.batchLimit` and
 * falling back to individual requests either from the start (when
 * createSubmitContext already found batch disabled) or reactively, the
 * moment a batch call itself reports it is disabled or rejects a chunk
 * outright for being too big (see submitBatchChunk's doc comment) - the
 * latter halves ctx.batchLimit and retries once before giving up, which
 * matters when /api/settings could not be read at startup so this client
 * picked a bigger batch size than the server actually allows.
 *
 * Returns `{ succeeded: meta[], failed: {meta, error}[] }` - `meta` is
 * whatever the caller attached to each request (typically the
 * price_snapshots row itself), so it can tell exactly which rows landed;
 * a successful create also gets `meta.id` set to the new record's id.
 */
export async function submitRequests(ctx, requests) {
  const succeeded = [];
  const failed = [];
  if (requests.length === 0) return { succeeded, failed };

  let i = 0;
  let sizeHalvedOnce = false;
  while (i < requests.length) {
    if (ctx.batchLimit === null) {
      const outcome = await submitIndividually(ctx, requests.slice(i));
      succeeded.push(...outcome.succeeded);
      failed.push(...outcome.failed);
      break;
    }
    const group = requests.slice(i, i + ctx.batchLimit);
    const outcome = await submitBatchChunk(ctx, group);

    if (outcome.disabled) {
      console.warn(BATCH_DISABLED_WARNING);
      ctx.batchLimit = null;
      continue; // retry this same group through the individual path
    }

    if (outcome.tooMany && !sizeHalvedOnce && group.length > 1) {
      sizeHalvedOnce = true;
      ctx.batchLimit = Math.max(1, Math.floor(ctx.batchLimit / 2));
      console.warn(
        `[pricesync] PocketBase rejected a batch of ${group.length} requests outright with no per-row detail - ` +
          `its Batch API Max requests setting is likely lower than expected. Halving the batch size to ${ctx.batchLimit} and retrying once.`
      );
      continue; // same i, a smaller group next time round
    }

    succeeded.push(...outcome.succeeded);
    failed.push(...outcome.failed);
    i += group.length;
  }
  return { succeeded, failed };
}
