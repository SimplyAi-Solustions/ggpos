#!/usr/bin/env node
// Full card catalogue import into GG Vault's `cards` and `card_sets`.
//
//   node pb/scripts/catalogue-import.mjs --push http://127.0.0.1:8091 \
//     [--games pokemon,mtg,onepiece,lorcana] [--langs en,ja,ko,zh-tw,zh-cn,th,id] \
//     [--cache DIR] [--repush] [--refresh]
//
// Needs PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD in the environment for
// --push. Without --push it only downloads and counts (a dry run).
//
// Sources:
//   pokemon   TCGdex: /v2/{lang}/sets, /sets/{id}, /rarities/{name}, /dex-ids/{n}
//             (dex ids give the English species for Japanese and other prints)
//   mtg       Scryfall bulk "default_cards" (about 80 MB compressed) and /sets
//   onepiece  OPTCG /api/allSetCards/
//   lorcana   Lorcast /v0/sets and /v0/sets/{id}/cards
//
// Polite: at most 4 requests at once, retries with backoff on 429 and 5xx,
// and every response is cached on disk (default pb/pb_data/catalogue_cache,
// which git ignores), so a rerun after a failure downloads nothing twice.
// --refresh refetches the set lists (new sets) but keeps cached set details
// unless their card count changed. A ledger of pushed batches makes the push
// resumable too; --repush pushes everything again.
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { createGunzip } from "node:zlib"

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const sync = require(join(here, "../pb_hooks/lib/catalogue_sync.js"))

const args = parseArgs(process.argv.slice(2))
const CACHE = resolve(args.cache || join(here, "../pb_data/catalogue_cache"))
const GAMES = (args.games || "pokemon,mtg,onepiece,lorcana").split(",").filter(Boolean)
const LANGS = (args.langs || sync.TCGDEX_LANGS.join(",")).split(",").filter(Boolean)
const PUSH = args.push ? String(args.push).replace(/\/$/, "") : ""
const CONCURRENCY = 4
const UA = "GGVault-catalogue/1.0 (ggentertainment.co.uk)"
mkdirSync(join(CACHE, "http"), { recursive: true })

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let active = 0
const waiters = []
async function slot(fn) {
  while (active >= CONCURRENCY) await new Promise((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiters.shift()
    if (next) next()
  }
}

function cachePath(url) {
  return join(CACHE, "http", createHash("sha1").update(url).digest("hex") + ".json")
}

/** GET a JSON url through the disk cache. `fresh` skips the cache read. */
async function getJson(url, { fresh = false, allow404 = true } = {}) {
  const file = cachePath(url)
  if (!fresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  return slot(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      let res
      try {
        res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } })
      } catch (err) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (res.status === 404 && allow404) {
        writeFileSync(file, "null")
        return null
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      if (!res.ok) throw new Error(`${url} answered ${res.status}`)
      const json = await res.json()
      writeFileSync(file, JSON.stringify(json))
      await sleep(50)
      return json
    }
    throw new Error(`${url} kept failing`)
  })
}

const all = (items, fn) => Promise.all(items.map(fn))

// ---------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------
const ledgerFile = join(CACHE, "pushed.json")
const ledger = existsSync(ledgerFile) && !args.repush ? JSON.parse(readFileSync(ledgerFile, "utf8")) : {}
let token = ""

async function login() {
  const email = process.env.PB_SUPERUSER_EMAIL
  const password = process.env.PB_SUPERUSER_PASSWORD
  if (!email || !password) throw new Error("Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD to push.")
  const res = await fetch(`${PUSH}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  })
  if (!res.ok) throw new Error(`Superuser login failed (${res.status}).`)
  token = (await res.json()).token
}

const totals = {}
async function push(key, batch) {
  const count = (totals[batch.game] = totals[batch.game] || {})
  for (const c of batch.cards) count[c.language || "en"] = (count[c.language || "en"] || 0) + 1
  if (!PUSH) return
  const hash = createHash("sha1").update(JSON.stringify(batch)).digest("hex")
  if (ledger[key] === hash) return
  for (let i = 0; i < Math.max(1, batch.cards.length); i += 2000) {
    const part = { ...batch, sets: i === 0 ? batch.sets : [], cards: batch.cards.slice(i, i + 2000) }
    const res = await fetch(`${PUSH}/api/vault/catalogue/import`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify(part),
    })
    if (!res.ok) throw new Error(`Import of ${key} failed: ${res.status} ${await res.text()}`)
  }
  ledger[key] = hash
  writeFileSync(ledgerFile, JSON.stringify(ledger))
}

// ---------------------------------------------------------------------
// Pokemon (TCGdex)
// ---------------------------------------------------------------------
async function pokemon() {
  const T = sync.TCGDEX
  const dexByLang = {}
  const perLang = {}
  for (const lang of [...new Set(["en", ...LANGS])]) {
    const list = (await getJson(`${T}/${lang}/sets`, { fresh: !!args.refresh })) || []
    const details = (
      await all(list, async (brief) => {
        const url = `${T}/${lang}/sets/${encodeURIComponent(brief.id)}`
        let d = await getJson(url)
        const want = brief.cardCount && brief.cardCount.total
        if (d && want && (d.cards || []).length !== want && args.refresh) d = await getJson(url, { fresh: true })
        return d
      })
    ).filter((d) => d && d.id)
    const rarityNames = (await getJson(`${T}/${lang}/rarities`, { fresh: !!args.refresh })) || []
    const rarityById = {}
    await all(rarityNames, async (name) => {
      const r = await getJson(`${T}/${lang}/rarities/${encodeURIComponent(name)}`, { fresh: !!args.refresh })
      for (const c of (r && r.cards) || []) rarityById[c.id] = name
    })
    const dexIds = (await getJson(`${T}/${lang}/dex-ids`)) || []
    const dex = {}
    await all(dexIds, async (n) => {
      const r = await getJson(`${T}/${lang}/dex-ids/${n}`)
      dex[n] = ((r && r.cards) || []).map((c) => c.name)
    })
    dexByLang[lang] = dex
    perLang[lang] = { details, rarityById }
    console.log(`pokemon ${lang}: ${details.length} sets, ${Object.keys(rarityById).length} rarities known, ${dexIds.length} dex ids`)
  }
  const species = sync.speciesTable(dexByLang)
  for (const lang of Object.keys(perLang)) {
    if (!LANGS.includes(lang)) continue
    const { details, rarityById } = perLang[lang]
    let first = true
    for (const d of details) {
      const batch = {
        game: "pokemon",
        sets: [sync.tcgdexSet(lang, d)],
        cards: sync.tcgdexCards(lang, d, rarityById, species[lang] || {}),
      }
      if (first && lang !== "en") batch.species = { [lang]: species[lang] || {} }
      first = false
      await push(`pokemon:${lang}:${d.id}`, batch)
    }
  }
}

// ---------------------------------------------------------------------
// Magic (Scryfall default_cards)
// ---------------------------------------------------------------------
async function mtg() {
  const setList = await getJson("https://api.scryfall.com/sets", { fresh: !!args.refresh })
  const sets = ((setList && setList.data) || []).filter((s) => !s.digital).map(sync.scryfallSet)
  const bulk = await getJson("https://api.scryfall.com/bulk-data", { fresh: true })
  const entry = ((bulk && bulk.data) || []).find((d) => d.type === "default_cards")
  if (!entry) throw new Error("Scryfall has no default_cards bulk file.")
  const url = entry.download_uri || entry.jsonl_download_uri
  const file = join(CACHE, `scryfall-default-${String(entry.updated_at || "").slice(0, 10)}${/\.gz$/.test(url) ? ".gz" : ""}`)
  if (!existsSync(file)) {
    console.log(`mtg: downloading ${url}`)
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } })
    if (!res.ok) throw new Error(`Scryfall bulk answered ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file + ".part"))
    const { renameSync } = await import("node:fs")
    renameSync(file + ".part", file)
  }
  const input = /\.gz$/.test(file) ? createReadStream(file).pipe(createGunzip()) : createReadStream(file)
  const bySet = {}
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const t = line.trim().replace(/,$/, "")
    if (!t.startsWith("{")) continue
    let raw
    try {
      raw = JSON.parse(t)
    } catch {
      continue
    }
    const row = sync.scryfallCard(raw)
    if (row) (bySet[row.set_code] = bySet[row.set_code] || []).push(row)
  }
  const setByCode = Object.fromEntries(sets.map((s) => [s.code, s]))
  for (const code of Object.keys(bySet)) {
    await push(`mtg:${code}`, { game: "mtg", sets: setByCode[code] ? [setByCode[code]] : [], cards: bySet[code] })
  }
  console.log(`mtg: ${Object.keys(bySet).length} sets`)
}

// ---------------------------------------------------------------------
// One Piece (OPTCG) and Lorcana (Lorcast)
// ---------------------------------------------------------------------
async function onepiece() {
  const list = (await getJson("https://optcgapi.com/api/allSetCards/", { fresh: !!args.refresh })) || []
  const st = (await getJson("https://optcgapi.com/api/allSTCards/", { fresh: !!args.refresh })) || []
  const { sets, cards } = sync.optcgRows([...list, ...(Array.isArray(st) ? st : [])])
  for (const s of sets) await push(`onepiece:${s.code}`, { game: "onepiece", sets: [s], cards: cards.filter((c) => c.set_code === s.code) })
  console.log(`onepiece: ${sets.length} sets, ${cards.length} cards`)
}

async function lorcana() {
  const list = await getJson("https://api.lorcast.com/v0/sets", { fresh: !!args.refresh })
  const sets = (list && list.results) || []
  for (const s of sets) {
    const cards = ((await getJson(`https://api.lorcast.com/v0/sets/${encodeURIComponent(s.id)}/cards`)) || []).map(sync.lorcastCard).filter(Boolean)
    await push(`lorcana:${s.code}`, { game: "lorcana", sets: [sync.lorcastSet(s)], cards })
  }
  console.log(`lorcana: ${sets.length} sets`)
}

const RUN = { pokemon, mtg, onepiece, lorcana }
if (PUSH) await login()
for (const g of GAMES) {
  if (!RUN[g]) throw new Error(`Unknown game ${g}`)
  const started = Date.now()
  try {
    await RUN[g]()
  } catch (err) {
    console.error(`${g}: ${err.message}`)
    process.exitCode = 1
  }
  console.log(`${g}: done in ${Math.round((Date.now() - started) / 1000)}s`)
}
console.log("cards per game and language:", JSON.stringify(totals))
