// A small PocketBase REST client: just enough for pricesync's needs
// (superuser auth, paged listing, and upserting through /api/batch with a
// graceful fallback when that API is switched off or capped below the
// batch size this service wants to use).
//
// Verified empirically against a throwaway PocketBase v0.40.4 instance
// built from this repo's own migrations (see the batch-behaviour notes
// below) rather than assumed from the docs.
import { requestJson } from "./http.mjs";

/** Authenticate as a PocketBase superuser. Auth collections were merged
 * into `_superusers` in PocketBase 0.23+ (this repo pins 0.40.4 - see
 * pb/scripts/dev.sh and pb/scripts/check.sh, which authenticates the same
 * way). */
export async function authenticate(pbUrl, identity, password) {
  const { json } = await requestJson(`${pbUrl}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    body: { identity, password },
  });
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

/** Page through every record in `collection` matching `filter`, returning
 * only `fields` when given. Used for both the initial cards load (a
 * handful of fields, every matching row) and small full-collection reads
 * (games, the latest fx_rates row). */
export async function getFullList(pbUrl, token, collection, { filter, fields, sort, perPage = 200 } = {}) {
  const items = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (filter) qs.set("filter", filter);
    if (fields) qs.set("fields", fields);
    if (sort) qs.set("sort", sort);
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

function chunkArray(array, size) {
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

const BATCH_DISABLED_WARNING =
  "[pricesync] Batch API is disabled on this PocketBase instance (Settings > Application > " +
  "Batch requests). Falling back to individual record writes for the rest of this run, which " +
  "is slower. Enable it, with Max requests at least 200, to speed pricesync up.";

/** Submit one chunk (at most ctx.batchLimit requests) through POST
 * /api/batch. PocketBase's batch endpoint is transactional: if ANY
 * sub-request in the chunk fails validation, the WHOLE chunk is rolled
 * back with an outer 400 ("Batch transaction failed.") and a per-index
 * error map - confirmed against a live instance, not assumed from the
 * docs. So a single bad row must not cost every other row in the chunk:
 * this pulls the bad indices out (logging why) and resubmits the rest,
 * shrinking by at least one request each time until either everything
 * left succeeds or nothing is left to retry. */
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
        timeoutMs: 60_000,
        allowErrorStatus: true,
      }));
    } catch (err) {
      for (const r of pending) failed.push({ meta: r.meta, error: err.message });
      pending = [];
      break;
    }

    if (status === 403 && firstAttempt && json?.message === "Batch requests are not allowed.") {
      return { disabled: true, succeeded: [], failed: [] };
    }
    firstAttempt = false;

    if (status >= 200 && status < 300) {
      for (const r of pending) succeeded.push(r.meta);
      pending = [];
      break;
    }

    const perIndex = json?.data?.requests;
    if (status === 400 && perIndex && typeof perIndex === "object" && Object.keys(perIndex).length > 0) {
      const badIndices = new Set(Object.keys(perIndex).map(Number));
      const next = [];
      for (let i = 0; i < pending.length; i += 1) {
        if (badIndices.has(i)) {
          failed.push({ meta: pending[i].meta, error: describeBatchItemError(perIndex[String(i)]) });
        } else {
          next.push(pending[i]);
        }
      }
      if (next.length === pending.length) {
        // PocketBase reported a transaction failure but named no specific
        // index - do not spin forever re-sending the same chunk.
        for (const r of pending) failed.push({ meta: r.meta, error: json?.message || "batch failed, cause unclear" });
        pending = [];
        break;
      }
      pending = next;
      continue;
    }

    for (const r of pending) {
      failed.push({ meta: r.meta, error: `HTTP ${status}${json?.message ? `: ${json.message}` : ""}` });
    }
    pending = [];
  }

  return { disabled: false, succeeded, failed };
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
 * moment a batch call itself reports it is disabled.
 *
 * Returns `{ succeeded: meta[], failed: {meta, error}[] }` - `meta` is
 * whatever the caller attached to each request (typically the card id,
 * finish and source), so it can tell exactly which rows landed.
 */
export async function submitRequests(ctx, requests) {
  const succeeded = [];
  const failed = [];
  if (requests.length === 0) return { succeeded, failed };

  let i = 0;
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
    succeeded.push(...outcome.succeeded);
    failed.push(...outcome.failed);
    i += ctx.batchLimit;
  }
  return { succeeded, failed };
}

export { chunkArray };
