#!/usr/bin/env node
// Photo identification eval: runs the verified shop photos through
// POST /api/vault/scan/identify on a local PocketBase and reports top-1,
// top-5 and the auto-accept precision.
//
//   STAFF_EMAIL=... STAFF_PASSWORD=... node pb/scripts/eval-identify.mjs \
//     --url http://127.0.0.1:8095 [--photos DIR] [--truth CSV] [--save reads.json] [--limit N]
//
// Replay mode costs nothing: it re-ranks reads saved by an earlier run through
// POST /api/vault/catalogue/rank-read (superuser), with no model call.
//
//   PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... node pb/scripts/eval-identify.mjs \
//     --url http://127.0.0.1:8095 --replay reads.json
//
// The Anthropic key belongs to the PocketBase process (ANTHROPIC_API_KEY);
// this script never sees it. Photos are resized to 1,400 px on the long edge
// with macOS `sips`, as the bake-off did.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = process.env.HOME
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : true
}
const URL_ = String(args.url || "http://127.0.0.1:8095").replace(/\/$/, "")
const PHOTOS = args.photos || join(HOME, ".buzz/RESEARCH/CARDID_PHOTOS")
const TRUTH = args.truth || join(HOME, ".buzz/REPOS/cardid-bakeoff/truth_real.csv")

/** Verified rows only: they carry a TCGdex id. */
function loadTruth(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#"))
  const head = lines.shift().split(",")
  return lines
    .map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i], v])))
    .filter((r) => r.verified === "yes" && r.tcgdex_id)
}

/** "SV10-ja" to "sv10", "me02" to "me02". */
const baseCode = (code) => String(code || "").toLowerCase().replace(/-(ja|ko|tw|cn|th|id|fr|de|it|es|pt)$/, "")

/** True when a candidate row is the truth's TCGdex card (set id plus number, ignoring zero padding). */
function isTruth(cand, truthId) {
  if (!cand) return false
  const at = truthId.lastIndexOf("-")
  const set = truthId.slice(0, at).toLowerCase()
  const num = truthId.slice(at + 1).replace(/^0+/, "").toLowerCase()
  return baseCode(cand.set_code) === set && String(cand.number).replace(/^0+/, "").toLowerCase() === num
}

async function auth(collection, email, password) {
  const res = await fetch(`${URL_}/api/collections/${collection}/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  })
  if (!res.ok) throw new Error(`${collection} login failed (${res.status})`)
  return (await res.json()).token
}

function photoBase64(file) {
  const dir = mkdtempSync(join(tmpdir(), "evalid-"))
  const out = join(dir, "p.jpg")
  execFileSync("sips", ["-Z", "1400", "-s", "format", "jpeg", file, "--out", out], { stdio: "ignore" })
  return readFileSync(out).toString("base64")
}

function describe(c) {
  return c ? `${c.name} ${c.set_code} ${c.number}${c.language && c.language !== "en" ? " " + c.language : ""}` : "-"
}

const truth = loadTruth(TRUTH).slice(0, args.limit ? Number(args.limit) : undefined)
const results = []

if (args.replay) {
  const token = await auth("_superusers", process.env.PB_SUPERUSER_EMAIL, process.env.PB_SUPERUSER_PASSWORD)
  const saved = JSON.parse(readFileSync(args.replay, "utf8"))
  for (const row of truth) {
    const prior = saved[row.filename]
    if (!prior || !prior.read) {
      results.push({ row, error: "no saved read" })
      continue
    }
    const res = await fetch(`${URL_}/api/vault/catalogue/rank-read`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ read: prior.read, game: "pokemon" }),
    })
    const json = await res.json()
    results.push({ row, json })
  }
} else {
  const token = await auth("staff", process.env.STAFF_EMAIL, process.env.STAFF_PASSWORD)
  // --save is also a resume file: a photo already answered there is not sent again.
  const saved = args.save && existsSync(args.save) ? JSON.parse(readFileSync(args.save, "utf8")) : {}
  for (const row of truth) {
    if (saved[row.filename] && saved[row.filename].response) {
      results.push({ row, json: saved[row.filename].response })
      continue
    }
    const started = Date.now()
    try {
      const res = await fetch(`${URL_}/api/vault/scan/identify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify({ image: photoBase64(join(PHOTOS, row.filename)), game: "pokemon" }),
      })
      const json = await res.json()
      if (!res.ok) {
        results.push({ row, error: `${res.status} ${json.message || ""}` })
        continue
      }
      results.push({ row, json, ms: Date.now() - started })
      saved[row.filename] = { read: json.read, model: json.model, escalated: json.escalated, response: json }
      if (args.save) writeFileSync(args.save, JSON.stringify(saved, null, 1))
    } catch (err) {
      results.push({ row, error: String(err.message || err) })
    }
    process.stderr.write(".")
  }
  process.stderr.write("\n")
}

let top1 = 0
let top5 = 0
let accepted = 0
let acceptedRight = 0
console.log("photo  truth          top-1                                   hit   auto  reasons")
for (const r of results) {
  if (r.error) {
    console.log(`${r.row.filename} ${r.row.tcgdex_id.padEnd(14)} ERROR ${r.error}`)
    continue
  }
  const cands = r.json.candidates || []
  const at = cands.findIndex((c) => isTruth(c, r.row.tcgdex_id))
  if (at === 0) top1++
  if (at >= 0 && at < 5) top5++
  if (r.json.auto_accept) {
    accepted++
    if (at === 0) acceptedRight++
  }
  console.log(
    `${r.row.filename} ${r.row.tcgdex_id.padEnd(14)} ${describe(cands[0]).slice(0, 38).padEnd(39)} ${at === 0 ? "1" : at > 0 ? String(at + 1) : "-"}`.padEnd(70) +
      `${r.json.auto_accept ? "yes" : "no "}   ${(r.json.reasons || []).join("; ")}`
  )
}
const n = results.length
const pct = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "n/a")
console.log(`\n${n} photos. top-1 ${top1}/${n} (${pct(top1, n)}), top-5 ${top5}/${n} (${pct(top5, n)}), auto-accepted ${accepted}, precision ${acceptedRight}/${accepted} (${pct(acceptedRight, accepted)})`)
