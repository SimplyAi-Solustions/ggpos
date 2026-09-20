#!/usr/bin/env node
// pricesync: nightly price file sync into PocketBase.
//
// Runs once and exits (the host cron schedules it at 04:00 - see
// deploy/README.md and deploy/docker-compose.yml's pricesync service).
// Streams Cardmarket's public price guide files and TCGCSV's daily
// TCGplayer dumps, keeps only the cards this shop's catalogue actually
// carries, and upserts price_snapshots plus each touched card's cached
// `prices` summary. See docs/PLAN.md, "Card images and market prices" and
// the "pricesync sidecar" paragraph under Architecture, for the sources
// and why this runs as a separate Node process rather than a pb_hooks
// cron (goja has no streaming JSON parser and $http.send buffers whole
// response bodies - neither can handle a 15-26 MB file).
//
// Every number that reaches this file from a third party (Cardmarket,
// TCGCSV, or PocketBase's own JSON responses) is parsed as a decimal
// string, never a float - see src/lib/json-stream.mjs and
// src/lib/money.mjs, which reimplement the two conversions this service
// needs from packages/shared/src/money.ts (this plain Node script has no
// build step, so it cannot import that TypeScript module directly).
import { pathToFileURL } from "node:url";

import { authenticate, getFullList, createSubmitContext, submitRequests, chunkArray } from "./lib/pb-client.mjs";
import { fetchCachedStream } from "./lib/http.mjs";
import { ingestCardmarketStream } from "./lib/cardmarket.mjs";
import { fetchGroups, findRelevantGroups, fetchPrices, buildTcgcsvRow } from "./lib/tcgcsv.mjs";
import { createUpsertQueue } from "./lib/upsert-queue.mjs";

const DEFAULT_CARDMARKET_BASE_URL = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide";
const DEFAULT_TCGCSV_BASE_URL = "https://tcgcsv.com/tcgplayer";
const FX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 200;
const TCGCSV_GROUP_DISCOVERY_CONCURRENCY = 8;

// Cardmarket game ids and TCGCSV category ids, both from docs/PLAN.md,
// "Card images and market prices (verified live, 19 Sep 2026)".
const GAME_CONFIG = [
  { key: "mtg", cardmarketGameId: 1, tcgcsvCategoryId: 1 },
  { key: "yugioh", cardmarketGameId: 3, tcgcsvCategoryId: 2 },
  { key: "pokemon", cardmarketGameId: 6, tcgcsvCategoryId: 3 },
  { key: "onepiece", cardmarketGameId: 18, tcgcsvCategoryId: 68 },
  { key: "lorcana", cardmarketGameId: 19, tcgcsvCategoryId: 71 },
];

/** A failure this run cannot recover from (bad config, stale FX, cannot
 * authenticate). Carries the process exit code the task brief specifies
 * (2 for a stale/missing FX rate, 1 for everything else). */
export class HardFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "HardFailure";
    this.exitCode = exitCode;
  }
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new HardFailure(`Missing required environment variable ${name}.`, 1);
  return value;
}

/** PocketBase's own date filter/field format ("YYYY-MM-DD HH:MM:SS.sssZ",
 * a space instead of "T") - matches pb/pb_hooks/crons.pb.js's
 * toISOString().replace("T", " ") and the literal filter strings in
 * pb/pb_hooks/exports.pb.js, so this reads the same way as the rest of
 * the codebase does when it builds a PocketBase date filter. */
function toPbDate(date) {
  return date.toISOString().replace("T", " ");
}

function dayBoundsPb(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startPb: toPbDate(start), endPb: toPbDate(end) };
}

/** Every price_snapshots row already written today for `source`, keyed
 * `card|finish|source` - see src/lib/upsert-queue.mjs, which consults this
 * to PATCH an existing row instead of creating a duplicate one. */
async function fetchExistingToday(pbUrl, token, source, startPb, endPb) {
  const rows = await getFullList(pbUrl, token, "price_snapshots", {
    fields: "id,card,finish,source",
    filter: `source = "${source}" && fetched_at >= "${startPb}" && fetched_at <= "${endPb}"`,
    perPage: 200,
  });
  const map = new Map();
  for (const r of rows) map.set(`${r.card}|${r.finish}|${r.source}`, r.id);
  return map;
}

/** Record the representative row for one (card, source) pair, preferring
 * the "normal" finish, so cards.prices carries one entry per source even
 * when a card has several finishes' worth of rows from this run. */
function recordTouched(touchedCards, row) {
  if (!touchedCards.has(row.card)) touchedCards.set(row.card, {});
  const bySource = touchedCards.get(row.card);
  const existing = bySource[row.source];
  if (!existing || (existing.finish !== "normal" && row.finish === "normal")) {
    bySource[row.source] = row;
  }
}

async function fetchCurrentCardPrices(pbUrl, token, cardIds) {
  const map = new Map();
  for (const ids of chunkArray(cardIds, 50)) {
    const filter = ids.map((id) => `id = "${id}"`).join(" || ");
    const rows = await getFullList(pbUrl, token, "cards", { fields: "id,prices", filter, perPage: 200 });
    for (const r of rows) map.set(r.id, r.prices || {});
  }
  return map;
}

/** "finally update each touched card's `prices` json with the latest
 * value per source and fetched_at" - merged, not overwritten, so a
 * source this run did not touch (for example TCGCSV failed but Cardmarket
 * succeeded) keeps its last known value instead of being wiped out. */
async function updateCardPrices(pbUrl, submitCtx, touchedCards, log, warn) {
  const cardIds = [...touchedCards.keys()];
  const currentPrices = await fetchCurrentCardPrices(pbUrl, submitCtx.token, cardIds);
  const requests = cardIds.map((cardId) => {
    const merged = { ...(currentPrices.get(cardId) || {}) };
    for (const [source, row] of Object.entries(touchedCards.get(cardId))) {
      merged[source] = {
        finish: row.finish,
        native_currency: row.native_currency,
        native_market: row.native_market,
        gbp_market: row.gbp_market,
        fetched_at: row.fetched_at,
      };
    }
    return {
      method: "PATCH",
      url: `/api/collections/cards/records/${cardId}`,
      body: { prices: merged },
      meta: { card: cardId },
    };
  });
  const { succeeded, failed } = await submitRequests(submitCtx, requests);
  log(`cards.prices updated on ${succeeded.length} card(s)${failed.length ? `, ${failed.length} failed` : ""}`);
  for (const f of failed) warn(`cards.prices update failed for ${f.meta.card}: ${f.error}`);
  return failed.length;
}

async function runCardmarketGame(game, ctx) {
  const { gamesByKey, cardsByCardmarketIdByGame, cardmarketBaseUrl, cacheDir, gbpPerEur, fxDatePb, fetchedAtPb, existingToday, submitCtx, log, warn } =
    ctx;
  const label = `cardmarket:${game.key}`;
  const gameRow = gamesByKey.get(game.key);
  if (!gameRow || !gameRow.enabled) {
    log(`${label}: game not found or disabled, skipping`);
    return null;
  }
  const wanted = cardsByCardmarketIdByGame.get(gameRow.id) || new Map();
  if (wanted.size === 0) {
    log(`${label}: no cards carry a cardmarket_id for this game, skipping download`);
    return null;
  }

  const url = `${cardmarketBaseUrl}/price_guide_${game.cardmarketGameId}.json`;
  const { stream, fromCache, whenCached } = await fetchCachedStream(url, cacheDir, `cardmarket-${game.cardmarketGameId}`);
  const { seen, matched, rows } = await ingestCardmarketStream(stream, {
    cardsByCardmarketId: wanted,
    fx: { gbpPerEur, fxDatePb },
    fetchedAtPb,
    warn: (msg) => warn(`${label}: ${msg}`),
  });
  await whenCached.catch((err) => warn(`${label}: could not update the on-disk cache: ${err.message}`));

  const queue = createUpsertQueue({ ctx: submitCtx, existingToday, flushSize: BATCH_SIZE });
  for (const row of rows) await queue.push(row);
  await queue.flush();
  const { succeeded, failed } = queue.results();
  for (const f of failed) warn(`${label}: failed to write card ${f.meta.card} (${f.meta.finish}): ${f.error}`);

  log(
    `${label}: ${fromCache ? "cache hit (unchanged since last run), " : ""}entries seen=${seen} matched=${matched} written=${succeeded.length}${
      failed.length ? ` failed=${failed.length}` : ""
    }`
  );
  return { label, seen, matched, written: succeeded.length, failed: failed.length, rows: succeeded };
}

async function runTcgcsvGame(game, ctx) {
  const { gamesByKey, cardsByTcgplayerIdByGame, tcgcsvBaseUrl, cacheDir, gbpPerUsd, fxDatePb, fetchedAtPb, existingToday, submitCtx, log, warn } = ctx;
  const label = `tcgplayer:${game.key}`;
  const gameRow = gamesByKey.get(game.key);
  if (!gameRow || !gameRow.enabled) {
    log(`${label}: game not found or disabled, skipping`);
    return null;
  }
  const wanted = cardsByTcgplayerIdByGame.get(gameRow.id) || new Map();
  if (wanted.size === 0) {
    log(`${label}: no cards carry a tcgplayer_id for this game, skipping`);
    return null;
  }

  const groups = await fetchGroups(tcgcsvBaseUrl, game.tcgcsvCategoryId, cacheDir);
  const relevantGroupIds = await findRelevantGroups(
    tcgcsvBaseUrl,
    game.tcgcsvCategoryId,
    groups,
    new Set(wanted.keys()),
    cacheDir,
    TCGCSV_GROUP_DISCOVERY_CONCURRENCY
  );

  let seen = 0;
  let matched = 0;
  const rows = [];
  for (const groupId of relevantGroupIds) {
    const prices = await fetchPrices(tcgcsvBaseUrl, game.tcgcsvCategoryId, groupId, cacheDir);
    for (const entry of prices) {
      seen += 1;
      const row = buildTcgcsvRow(entry, wanted, { gbpPerUsd, fxDatePb }, fetchedAtPb);
      if (row) {
        matched += 1;
        rows.push(row);
      }
    }
  }

  const queue = createUpsertQueue({ ctx: submitCtx, existingToday, flushSize: BATCH_SIZE });
  for (const row of rows) await queue.push(row);
  await queue.flush();
  const { succeeded, failed } = queue.results();
  for (const f of failed) warn(`${label}: failed to write card ${f.meta.card} (${f.meta.finish}): ${f.error}`);

  log(
    `${label}: groups=${groups.length} relevant=${relevantGroupIds.size} entries seen=${seen} matched=${matched} written=${succeeded.length}${
      failed.length ? ` failed=${failed.length}` : ""
    }`
  );
  return { label, seen, matched, written: succeeded.length, failed: failed.length, rows: succeeded };
}

/**
 * Run one full pricesync pass. `env` defaults to process.env; tests pass a
 * plain object pointing PB_URL/CARDMARKET_BASE_URL/TCGCSV_BASE_URL at a
 * local fake server instead, and CACHE_DIR at a throwaway directory.
 * `now` is injectable for the same reason (pinning "today" in tests).
 *
 * Never calls process.exit - returns `{ exitCode, summary }`, or throws
 * HardFailure for a condition that stops the run before it can produce a
 * summary at all (bad config, stale FX, cannot authenticate). The CLI
 * entry point at the bottom of this file is the only thing that turns
 * either of those into an actual process exit code.
 */
export async function run(env = process.env, { now = () => new Date() } = {}) {
  const log = (...args) => console.log("[pricesync]", ...args);
  const warn = (...args) => console.warn("[pricesync]", ...args);

  const runStartedAt = now();
  const fetchedAtPb = toPbDate(runStartedAt);
  const pbUrl = requireEnv(env, "PB_URL").replace(/\/+$/, "");
  const email = requireEnv(env, "PB_SUPERUSER_EMAIL");
  const password = requireEnv(env, "PB_SUPERUSER_PASSWORD");
  const cacheDir = env.CACHE_DIR || "/app/cache";
  // Overridable only for tests, which point these at a local fake server -
  // production always uses the real Cardmarket/TCGCSV hosts.
  const cardmarketBaseUrl = env.CARDMARKET_BASE_URL || DEFAULT_CARDMARKET_BASE_URL;
  const tcgcsvBaseUrl = env.TCGCSV_BASE_URL || DEFAULT_TCGCSV_BASE_URL;

  log(`starting run at ${fetchedAtPb}`);
  const token = await authenticate(pbUrl, email, password);
  log("authenticated to PocketBase");

  // --- FX rate: refuse to run on a stale or missing rate ------------------
  const [fxRow] = await getFullList(pbUrl, token, "fx_rates", { sort: "-fetched_at", perPage: 1 });
  if (!fxRow) {
    throw new HardFailure("No fx_rates row exists yet. Run the FX cron before pricesync.", 2);
  }
  const fxFetchedAt = new Date(fxRow.fetched_at.replace(" ", "T"));
  const ageMs = runStartedAt.getTime() - fxFetchedAt.getTime();
  if (!(ageMs <= FX_MAX_AGE_MS)) {
    const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    throw new HardFailure(
      `Latest fx_rates row is from ${fxRow.fetched_at}, ${ageDays} days old (more than 3). Run the FX cron before pricesync.`,
      2
    );
  }
  const gbpPerEur = Number(fxRow.quotes?.EUR);
  const gbpPerUsd = Number(fxRow.quotes?.USD);
  if (!(gbpPerEur > 0) || !(gbpPerUsd > 0)) {
    throw new HardFailure(`fx_rates row ${fxRow.id} has an invalid EUR or USD rate: ${JSON.stringify(fxRow.quotes)}.`, 2);
  }
  const fxDatePb = fxRow.fetched_at;
  log(`fx rate ok: 1 EUR = ${gbpPerEur} GBP, 1 USD = ${gbpPerUsd} GBP (fetched ${fxRow.fetched_at})`);

  // --- games (need id -> enabled, keyed by the same key GAME_CONFIG uses) -
  const gameRows = await getFullList(pbUrl, token, "games", { fields: "id,key,enabled" });
  const gamesByKey = new Map(gameRows.map((g) => [g.key, g]));

  // --- cards: every id carrying a cardmarket_id or tcgplayer_id, scoped --
  // per game so a game with zero wanted ids never triggers its (15-26 MB,
  // for Cardmarket) download at all.
  const cardRows = await getFullList(pbUrl, token, "cards", {
    fields: "id,cardmarket_id,tcgplayer_id,game",
    filter: `cardmarket_id != "" || tcgplayer_id != ""`,
    perPage: 200,
  });
  const cardsByCardmarketIdByGame = new Map();
  const cardsByTcgplayerIdByGame = new Map();
  for (const c of cardRows) {
    if (c.cardmarket_id) {
      if (!cardsByCardmarketIdByGame.has(c.game)) cardsByCardmarketIdByGame.set(c.game, new Map());
      const byId = cardsByCardmarketIdByGame.get(c.game);
      if (byId.has(c.cardmarket_id)) {
        warn(`duplicate cardmarket_id ${c.cardmarket_id} on cards ${byId.get(c.cardmarket_id).id} and ${c.id}; keeping the first`);
      } else {
        byId.set(c.cardmarket_id, c);
      }
    }
    if (c.tcgplayer_id) {
      if (!cardsByTcgplayerIdByGame.has(c.game)) cardsByTcgplayerIdByGame.set(c.game, new Map());
      const byId = cardsByTcgplayerIdByGame.get(c.game);
      if (byId.has(c.tcgplayer_id)) {
        warn(`duplicate tcgplayer_id ${c.tcgplayer_id} on cards ${byId.get(c.tcgplayer_id).id} and ${c.id}; keeping the first`);
      } else {
        byId.set(c.tcgplayer_id, c);
      }
    }
  }
  log(`loaded ${cardRows.length} card(s) carrying a cardmarket_id or tcgplayer_id`);

  // --- rows already written today, for the upsert decision ---------------
  const { startPb, endPb } = dayBoundsPb(runStartedAt);
  const existingCardmarketToday = await fetchExistingToday(pbUrl, token, "cardmarket", startPb, endPb);
  const existingTcgplayerToday = await fetchExistingToday(pbUrl, token, "tcgplayer", startPb, endPb);

  const submitCtx = await createSubmitContext(pbUrl, token, { requestedBatchSize: BATCH_SIZE });

  const touchedCards = new Map(); // cardId -> { [source]: representative row }
  const summary = [];

  const cardmarketCtx = {
    gamesByKey,
    cardsByCardmarketIdByGame,
    cardmarketBaseUrl,
    cacheDir,
    gbpPerEur,
    fxDatePb,
    fetchedAtPb,
    existingToday: existingCardmarketToday,
    submitCtx,
    log,
    warn,
  };
  for (const game of GAME_CONFIG) {
    try {
      const result = await runCardmarketGame(game, cardmarketCtx);
      if (result) {
        summary.push(result);
        for (const row of result.rows) recordTouched(touchedCards, row);
      }
    } catch (err) {
      warn(`cardmarket:${game.key}: ${err.message}`);
      summary.push({ label: `cardmarket:${game.key}`, error: err.message });
    }
  }

  const tcgcsvCtx = {
    gamesByKey,
    cardsByTcgplayerIdByGame,
    tcgcsvBaseUrl,
    cacheDir,
    gbpPerUsd,
    fxDatePb,
    fetchedAtPb,
    existingToday: existingTcgplayerToday,
    submitCtx,
    log,
    warn,
  };
  for (const game of GAME_CONFIG) {
    try {
      const result = await runTcgcsvGame(game, tcgcsvCtx);
      if (result) {
        summary.push(result);
        for (const row of result.rows) recordTouched(touchedCards, row);
      }
    } catch (err) {
      warn(`tcgplayer:${game.key}: ${err.message}`);
      summary.push({ label: `tcgplayer:${game.key}`, error: err.message });
    }
  }

  let cardPriceFailures = 0;
  if (touchedCards.size > 0) {
    try {
      cardPriceFailures = await updateCardPrices(pbUrl, submitCtx, touchedCards, log, warn);
    } catch (err) {
      warn(`cards.prices update: ${err.message}`);
      cardPriceFailures = touchedCards.size;
    }
  }

  const hadFailure = cardPriceFailures > 0 || summary.some((s) => s.error || s.failed > 0);
  log("summary:");
  for (const s of summary) {
    log(s.error ? `  ${s.label}: FAILED - ${s.error}` : `  ${s.label}: seen=${s.seen} matched=${s.matched} written=${s.written}${s.failed ? ` failed=${s.failed}` : ""}`);
  }
  log(hadFailure ? "done, with failures - see warnings above" : "done, no failures");

  return { exitCode: hadFailure ? 1 : 0, summary };
}

async function mainCli() {
  try {
    const result = await run(process.env);
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(`[pricesync] ${err.message}`);
    process.exitCode = err instanceof HardFailure ? err.exitCode : 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  mainCli();
}
