// Turns price_snapshots row objects into PocketBase batch requests and
// flushes them once enough have queued up, applying the upsert rule from
// the task brief: one row per (card, finish, source, fetched date) - a row
// already written today for that combination is PATCHed in place, never
// duplicated with a second POST.
import { submitRequests } from "./pb-client.mjs";

const COLLECTION = "price_snapshots";

function keyFor(row) {
  return `${row.card}|${row.finish}|${row.source}`;
}

/**
 * `existingToday` is a Map from `card|finish|source` to an existing
 * price_snapshots record id, built once up front from every row already
 * written today (see index.mjs's fetchExistingSnapshotsToday). That alone
 * only guards against a row from an *earlier run* today; within a single
 * run, two different source rows can still land on the same key (a blank
 * or missing TCGCSV subTypeName always normalises to "normal" - see
 * tcgcsv.mjs's normalizeFinish - so two different productIds that are
 * both missing one, matched to two different wanted ids, would otherwise
 * both try to create the same (card, finish, source) row). This queue
 * remembers every key it has queued this run and, on a repeat:
 *   - if that key's request has not been flushed yet, updates its body in
 *     place instead of adding a second request;
 *   - if it has already been flushed and succeeded, PATCHes the id that
 *     create returned instead of sending a second POST.
 * Either way, at most one row per key reaches PocketBase per run.
 */
export function createUpsertQueue({ ctx, existingToday, flushSize }) {
  let pending = [];
  const pendingByKey = new Map(); // key -> the pending request object, for in-flight de-dup
  const createdThisRun = new Map(); // key -> id, once a create for that key has succeeded this run
  const succeeded = [];
  const failed = [];

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    pendingByKey.clear();
    const { succeeded: ok, failed: bad } = await submitRequests(ctx, batch);
    succeeded.push(...ok);
    failed.push(...bad);
    for (const meta of ok) {
      if (meta.id) createdThisRun.set(keyFor(meta), meta.id);
    }
  }

  return {
    /** Queue one price_snapshots row (the exact field shape from
     * cardmarket.mjs / tcgcsv.mjs) for upsert. */
    async push(row) {
      const key = keyFor(row);

      const createdId = createdThisRun.get(key);
      if (createdId) {
        pending.push({ method: "PATCH", url: `/api/collections/${COLLECTION}/records/${createdId}`, body: row, meta: row });
        if (pending.length >= flushSize) await flush();
        return;
      }

      const inFlight = pendingByKey.get(key);
      if (inFlight) {
        inFlight.body = row;
        inFlight.meta = row;
        return;
      }

      const existingId = existingToday.get(key);
      const request = existingId
        ? { method: "PATCH", url: `/api/collections/${COLLECTION}/records/${existingId}`, body: row, meta: row }
        : { method: "POST", url: `/api/collections/${COLLECTION}/records`, body: row, meta: row };
      pending.push(request);
      pendingByKey.set(key, request);
      if (pending.length >= flushSize) await flush();
    },
    flush,
    results() {
      return { succeeded, failed };
    },
  };
}
