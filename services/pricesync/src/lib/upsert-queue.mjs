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
 * written today (see index.mjs's fetchExistingSnapshotsToday). Each
 * Cardmarket/TCGCSV source id is expected to match at most one `cards`
 * row per run, so this queue does not need to guard against the same key
 * being queued twice in a single run - only against a row already on file
 * from an earlier run today, which is exactly what `existingToday` holds.
 */
export function createUpsertQueue({ ctx, existingToday, flushSize }) {
  let pending = [];
  const succeeded = [];
  const failed = [];

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const { succeeded: ok, failed: bad } = await submitRequests(ctx, batch);
    succeeded.push(...ok);
    failed.push(...bad);
  }

  return {
    /** Queue one price_snapshots row (the exact field shape from
     * cardmarket.mjs / tcgcsv.mjs) for upsert. */
    async push(row) {
      const existingId = existingToday.get(keyFor(row));
      const request = existingId
        ? { method: "PATCH", url: `/api/collections/${COLLECTION}/records/${existingId}`, body: row }
        : { method: "POST", url: `/api/collections/${COLLECTION}/records`, body: row };
      // The row itself rides along as `meta` so a caller building
      // cards.prices afterwards can read back exactly what landed.
      pending.push({ ...request, meta: row });
      if (pending.length >= flushSize) await flush();
    },
    flush,
    results() {
      return { succeeded, failed };
    },
  };
}
