// HTTP helpers shared by the PocketBase client and the Cardmarket/TCGCSV
// readers: a fixed User-Agent (every outbound request must send one - see
// docs/PLAN.md's pricesync sidecar paragraph and the TCGCSV row), a small
// error type that carries the request method/status/body, a whole-document
// JSON fetch, and a disk-cached streaming fetch for the large Cardmarket
// files.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { parseJsonStream } from "./json-stream.mjs";

export const USER_AGENT = "GGVault-pricesync/1.0 (+https://vault.ggentertainment.co.uk)";

// Generous timeouts: the Cardmarket files run 15-26 MB and this is a
// nightly batch job with no one waiting on it, so it is better to wait
// out a slow connection than to abort a download that is still landing.
const SMALL_REQUEST_TIMEOUT_MS = 30_000;
const LARGE_REQUEST_TIMEOUT_MS = 10 * 60_000;

/**
 * `status` is 0 for a request that never got a response at all (DNS
 * failure, connection refused, timeout) as distinct from a real HTTP
 * error status - callers use that to tell "the server said no" from
 * "there was no server to ask" and word the two differently (see
 * pb-client.mjs's authenticate(), which turns a status-0 failure to
 * PocketBase into a message naming the container to check).
 */
export class HttpError extends Error {
  constructor(method, url, status, body) {
    const summary = status === 0 ? `cannot reach ${url}: ${body}` : `${method} ${url} failed: ${status}${body ? ` - ${truncate(body, 300)}` : ""}`;
    super(summary);
    this.name = "HttpError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Make a JSON request (GET by default), preserving every number in the
 * response as a decimal string (see json-stream.mjs). Returns
 * `{ status, json }` - callers that need to inspect a non-2xx body (the
 * batch client does, to tell a partial batch failure from a hard one)
 * pass `allowErrorStatus: true`; everyone else gets HttpError thrown for
 * them. A connection-level failure (fetch() itself throwing rather than
 * resolving with a response) always throws HttpError with status 0,
 * regardless of allowErrorStatus - there is no response to hand back.
 */
export async function requestJson(
  url,
  { method = "GET", headers = {}, body, timeoutMs = SMALL_REQUEST_TIMEOUT_MS, allowErrorStatus = false } = {}
) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch() threw rather than resolving: the connection could not be
    // made at all (DNS failure, connection refused, our own timeout).
    // Node's own message for this ("fetch failed") names neither the URL
    // nor what to do about it, so this is deliberately not left as-is.
    throw new HttpError(method, url, 0, err.message);
  }
  const json = response.body ? await parseJsonStream(Readable.fromWeb(response.body)).catch(() => null) : null;
  if (!response.ok && !allowErrorStatus) {
    throw new HttpError(method, url, response.status, json ? JSON.stringify(json) : "");
  }
  return { status: response.status, json };
}

/** Fetch a whole JSON document with GET, preserving every number as a
 * decimal string. Throws HttpError on a non-2xx status. */
export async function fetchJson(url, { headers = {}, timeoutMs = SMALL_REQUEST_TIMEOUT_MS } = {}) {
  const { json } = await requestJson(url, { headers, timeoutMs });
  return json;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function bodyFileExists(bodyPath) {
  try {
    await stat(bodyPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a Node Readable for `url`, honouring ETag / If-Modified-Since
 * against a small cache directory so an unchanged file is never
 * re-downloaded (docs/PLAN.md's pricesync sidecar paragraph; the task
 * brief's CACHE_DIR requirement).
 *
 * The response body is streamed straight through to the caller (never
 * buffered in memory - the Cardmarket files run 15-26 MB) while a copy is
 * written to disk in parallel; only once that copy lands safely on disk is
 * the cache metadata (etag/last-modified) updated, so a run that crashes
 * mid-download does not poison the next run's cache with a half-written
 * file.
 *
 * Returns:
 *   - `stream`: a Node Readable the caller pipes into the JSON parser,
 *     whether the bytes came fresh off the network or off the previous
 *     run's cached copy.
 *   - `fromCache`: true when the server answered 304 and `stream` is the
 *     cached file, not a live network response.
 *   - `whenCached`: a promise that resolves once the fresh download has
 *     safely landed in the cache (or immediately, when fromCache is true).
 *     Attach a .catch() to this the moment it is returned (see
 *     index.mjs's runCardmarketGame) rather than only awaiting it later:
 *     on Node 22 an unhandled rejection is fatal, and if the caller's own
 *     ingest throws first, a later `await whenCached` line is never
 *     reached to observe a rejection that settles in the background.
 */
export async function fetchCachedStream(url, cacheDir, cacheKey, { headers = {} } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const safeKey = cacheKey || createHash("sha256").update(url).digest("hex");
  const bodyPath = path.join(cacheDir, `${safeKey}.body`);
  const metaPath = path.join(cacheDir, `${safeKey}.meta.json`);

  let meta = await readJsonSafe(metaPath);
  if (meta && !(await bodyFileExists(bodyPath))) {
    // The meta file survived (or was written) without a matching body -
    // a previous run's cache directory was partially cleared, or crashed
    // between the two writes. Trusting the meta here would make every
    // future request 304 against a file that does not exist. Drop the
    // stale meta and fall through to an unconditional request instead.
    await unlink(metaPath).catch(() => {});
    meta = null;
  }

  const conditionalHeaders = {};
  if (meta?.etag) conditionalHeaders["If-None-Match"] = meta.etag;
  else if (meta?.lastModified) conditionalHeaders["If-Modified-Since"] = meta.lastModified;

  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers, ...conditionalHeaders },
      signal: AbortSignal.timeout(LARGE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError("GET", url, 0, err.message);
  }

  if (response.status === 304) {
    if (response.body) await response.body.cancel().catch(() => {});
    return { stream: createReadStream(bodyPath), fromCache: true, whenCached: Promise.resolve() };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new HttpError("GET", url, response.status, bodyText);
  }

  const tmpPath = `${bodyPath}.tmp-${process.pid}`;
  const networkStream = Readable.fromWeb(response.body);
  const toDisk = createWriteStream(tmpPath);
  const toCaller = new PassThrough();

  // A connection dropped mid-body must fail both destinations - `pipe()`
  // does not forward 'error' events between the streams it connects (the
  // same class of gap json-stream.mjs's pipeline() rewrite closes for the
  // parser chain), so without this an aborted download either hangs the
  // caller's parse or leaves an orphaned, half-written .tmp file with
  // nothing to clean it up.
  networkStream.on("error", (err) => {
    toDisk.destroy(err);
    toCaller.destroy(err);
  });
  // Fan the same bytes out to both the disk cache and the caller. A single
  // Readable can be piped to more than one Writable; backpressure from the
  // slower of the two throttles the source for both, which is fine for a
  // once-nightly batch job.
  networkStream.pipe(toDisk);
  networkStream.pipe(toCaller);

  const whenCached = finished(toDisk)
    .then(async () => {
      await rename(tmpPath, bodyPath);
      await writeFile(
        metaPath,
        JSON.stringify({
          etag: response.headers.get("etag") || null,
          lastModified: response.headers.get("last-modified") || null,
          cachedAt: new Date().toISOString(),
        })
      );
    })
    .catch(async (err) => {
      await unlink(tmpPath).catch(() => {});
      throw err;
    });

  return { stream: toCaller, fromCache: false, whenCached };
}

/**
 * Fetch a whole JSON document through the same ETag/If-Modified-Since disk
 * cache as fetchCachedStream, for the smaller TCGCSV endpoints (groups,
 * products, prices) - these are not 15-26 MB like Cardmarket's files, but
 * TCGCSV asks for the same courtesy (an identifiable User-Agent, and not
 * re-fetching what has not changed), and a category's groups/products are
 * fetched by the hundreds, so caching them matters just as much.
 *
 * A failure to persist the cache (for example the cache directory is not
 * writable) is logged through `warn` and otherwise ignored - the data
 * itself was already fetched and parsed successfully, so the run
 * continues at the cost of re-downloading this one file next time,
 * rather than failing the whole game over a cache write.
 */
export async function fetchCachedJson(url, cacheDir, cacheKey, options, warn = () => {}) {
  const { stream, fromCache, whenCached } = await fetchCachedStream(url, cacheDir, cacheKey, options);
  const cacheReady = whenCached.catch((err) => warn(`could not update the on-disk cache for ${cacheKey}: ${err.message}`));
  const json = await parseJsonStream(stream);
  await cacheReady;
  return { json, fromCache };
}
