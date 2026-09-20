// HTTP helpers shared by the PocketBase client and the Cardmarket/TCGCSV
// readers: a fixed User-Agent (every outbound request must send one - see
// docs/PLAN.md's pricesync sidecar paragraph and the TCGCSV row), a small
// error type that carries the response status/body, a whole-document JSON
// fetch, and a disk-cached streaming fetch for the large Cardmarket files.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, readFile, writeFile, unlink } from "node:fs/promises";
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

export class HttpError extends Error {
  constructor(url, status, body) {
    super(`GET ${url} failed: ${status}${body ? ` - ${truncate(body, 300)}` : ""}`);
    this.name = "HttpError";
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
 * them.
 */
export async function requestJson(
  url,
  { method = "GET", headers = {}, body, timeoutMs = SMALL_REQUEST_TIMEOUT_MS, allowErrorStatus = false } = {}
) {
  const response = await fetch(url, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = response.body ? await parseJsonStream(Readable.fromWeb(response.body)).catch(() => null) : null;
  if (!response.ok && !allowErrorStatus) {
    throw new HttpError(url, response.status, json ? JSON.stringify(json) : "");
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
 *     The caller awaits this after it finishes reading `stream`, so a
 *     cache-write failure surfaces as a logged warning rather than being
 *     lost, without holding up the parse itself.
 */
export async function fetchCachedStream(url, cacheDir, cacheKey, { headers = {} } = {}) {
  await mkdir(cacheDir, { recursive: true });
  const safeKey = cacheKey || createHash("sha256").update(url).digest("hex");
  const bodyPath = path.join(cacheDir, `${safeKey}.body`);
  const metaPath = path.join(cacheDir, `${safeKey}.meta.json`);

  const meta = await readJsonSafe(metaPath);
  const conditionalHeaders = {};
  if (meta?.etag) conditionalHeaders["If-None-Match"] = meta.etag;
  else if (meta?.lastModified) conditionalHeaders["If-Modified-Since"] = meta.lastModified;

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers, ...conditionalHeaders },
    signal: AbortSignal.timeout(LARGE_REQUEST_TIMEOUT_MS),
  });

  if (response.status === 304) {
    if (response.body) await response.body.cancel().catch(() => {});
    return { stream: createReadStream(bodyPath), fromCache: true, whenCached: Promise.resolve() };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new HttpError(url, response.status, bodyText);
  }

  const tmpPath = `${bodyPath}.tmp-${process.pid}`;
  const networkStream = Readable.fromWeb(response.body);
  const toDisk = createWriteStream(tmpPath);
  const toCaller = new PassThrough();

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
 */
export async function fetchCachedJson(url, cacheDir, cacheKey, options) {
  const { stream, fromCache, whenCached } = await fetchCachedStream(url, cacheDir, cacheKey, options);
  const json = await parseJsonStream(stream);
  await whenCached;
  return { json, fromCache };
}
