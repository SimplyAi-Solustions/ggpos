#!/usr/bin/env node
/**
 * Epos Now stock sync, run every 2 minutes on the shop Mac by launchd
 * (uk.co.ggentertainment.epos-stock-sync.plist). Makes Vault stock into Epos
 * Now products (epos_product_queue), archives them when they leave the shelf,
 * and applies Epos Now till sales of Vault items back to the Vault. The Epos
 * Now token stays on this Mac: every Epos call goes through the `epos`
 * command. See deploy/mac/README.md.
 *
 * Env:
 *   VAULT_PB_URL                PocketBase base URL, e.g. https://vault.example
 *   VAULT_PB_EMAIL              superuser email
 *   VAULT_PB_KEYCHAIN_SERVICE   keychain service holding the superuser password
 *   EPOS_BIN                    optional, default /usr/local/bin/epos
 *   EPOS_TIMEOUT_MS             optional, default 60000
 *   EPOS_SALES_EVERY_MIN        optional, default 5: how often to pull till sales
 *   EPOS_CATEGORY_REFRESH_HOURS optional, default 6
 *   EPOS_SET_STOCK              optional, "1" to set Epos stock levels (off by default)
 *   EPOS_LOCATION_ID            optional, default 14037, for EPOS_SET_STOCK
 *   EPOS_ARCHIVED_LOOKUP        optional, "0" to skip the archived product search before a create
 *   SECURITY_BIN                optional, default /usr/bin/security
 *   EPOS_STOCK_LOCK             optional lock file path
 *
 * Node 22 or later, built-ins only.
 */
import { execFile } from "node:child_process"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { makeEposRunner } from "./epos-credit-sync.mjs"
import { runOnce } from "./lib/epos-stock.mjs"

export { makeEposRunner }

function log(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
}

function need(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Set ${name}. See deploy/mac/README.md.`)
  return v
}

function keychainPassword(service) {
  const bin = process.env.SECURITY_BIN || "/usr/bin/security"
  return new Promise((resolve, reject) => {
    execFile(bin, ["find-generic-password", "-s", service, "-w"], (err, stdout) => {
      if (err) reject(new Error(`Could not read keychain item "${service}" (exit ${err.code}).`))
      else resolve(stdout.replace(/\r?\n$/, ""))
    })
  })
}

/** A minimal PocketBase REST client with a superuser token. */
export function makePb(baseUrl, token) {
  const base = baseUrl.replace(/\/+$/, "")
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 404 && method === "GET") return null
    const text = await res.text()
    if (!res.ok) throw new Error(`PocketBase ${method} ${path.split("?")[0]} returned ${res.status}`)
    return text ? JSON.parse(text) : null
  }
  async function list(collection, filter, sort, extra = {}) {
    const q = new URLSearchParams({ filter, sort, perPage: "200", ...extra })
    const out = await call("GET", `/api/collections/${collection}/records?${q}`)
    return (out && out.items) || []
  }
  const Q = "epos_product_queue"
  const clean = (id) => String(id).replace(/[^a-z0-9]/gi, "")
  async function stateRow(key) {
    return (await list("epos_sync_state", `key = '${clean(key)}'`, "created"))[0] || null
  }
  return {
    listSending: () => list(Q, "status = 'sending'", "created"),
    listDue: (max) => list(Q, `status = 'pending' || (status = 'failed' && attempts < ${Number(max)})`, "created"),
    listNeedsCheck: () => list(Q, "status = 'needs_check'", "created"),
    getItem: (id) => call("GET", `/api/collections/items/records/${encodeURIComponent(id)}?expand=game`),
    getSettings: async () => (await list("settings", "id != ''", "created"))[0] || null,
    updateRow: (id, patch) => call("PATCH", `/api/collections/${Q}/records/${encodeURIComponent(id)}`, patch),
    updateItem: (id, patch) => call("PATCH", `/api/collections/items/records/${encodeURIComponent(id)}`, patch),
    getState: async (key) => {
      const row = await stateRow(key)
      return row ? row.value : null
    },
    setState: async (key, value) => {
      const row = await stateRow(key)
      if (row) return call("PATCH", `/api/collections/epos_sync_state/records/${row.id}`, { value })
      return call("POST", "/api/collections/epos_sync_state/records", { key, value })
    },
    findItemsByProductIds: (ids) => {
      const nums = ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
      if (nums.length === 0) return []
      return list("items", nums.map((n) => `epos_product_id = ${n}`).join(" || "), "created", { fields: "id,epos_product_id" })
    },
    applySale: (line) => call("POST", "/api/vault/epos/sales/apply", line),
  }
}

/** One run at a time, even if started by hand while launchd is running it. */
function takeLock(path) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          unlinkSync(path)
        } catch {}
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      const pid = Number(readFileSync(path, "utf8")) || 0
      let alive = false
      try {
        if (pid > 0) process.kill(pid, 0)
        alive = pid > 0
      } catch (e) {
        alive = e.code === "EPERM"
      }
      if (alive) return null
      unlinkSync(path) // stale lock from a run that died
    }
  }
  return null
}

async function main() {
  const url = need("VAULT_PB_URL")
  const email = need("VAULT_PB_EMAIL")
  const service = need("VAULT_PB_KEYCHAIN_SERVICE")
  const release = takeLock(process.env.EPOS_STOCK_LOCK || join(tmpdir(), "uk.co.ggentertainment.epos-stock-sync.lock"))
  if (!release) {
    log("another run is still going; skipping this one")
    return 0
  }
  try {
    const password = await keychainPassword(service)
    const auth = await fetch(`${url.replace(/\/+$/, "")}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
      signal: AbortSignal.timeout(30000),
    })
    if (!auth.ok) throw new Error(`PocketBase superuser login failed with ${auth.status}.`)
    const { token } = await auth.json()

    const counts = await runOnce({
      pb: makePb(url, token),
      epos: makeEposRunner(process.env.EPOS_BIN || "/usr/local/bin/epos", Number(process.env.EPOS_TIMEOUT_MS) || 60000),
      log,
      now: () => new Date(),
      archivedLookup: process.env.EPOS_ARCHIVED_LOOKUP !== "0",
      stock: process.env.EPOS_SET_STOCK === "1" ? { locationId: Number(process.env.EPOS_LOCATION_ID) || 14037 } : null,
      salesEveryMs: (Number(process.env.EPOS_SALES_EVERY_MIN) || 5) * 60000,
      categoryRefreshMs: (Number(process.env.EPOS_CATEGORY_REFRESH_HOURS) || 6) * 3600000,
    })
    const s = counts.sales || {}
    const total = counts.done + counts.failed + counts.needs_check + counts.stuck + counts.errors + (s.lines || 0) + (s.errors || 0)
    if (total > 0 || counts.needs_check_total > 0) {
      log(
        `run: done=${counts.done} failed=${counts.failed} needs_check=${counts.needs_check + counts.stuck} held=${counts.held} skipped=${counts.errors} sales_applied=${s.applied || 0} sales_flagged=${s.flagged || 0} sales_errors=${s.errors || 0} waiting_for_check=${counts.needs_check_total}`
      )
    }
    return counts.errors > 0 || (s.errors || 0) > 0 ? 1 : 0
  } finally {
    release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(`error: ${err.message}`)
      process.exit(1)
    }
  )
}
