#!/usr/bin/env node
/**
 * Epos Now store-credit sync, run every minute on the shop Mac by launchd
 * (uk.co.ggentertainment.epos-credit-sync.plist). Sends credit queued by
 * GG Vault deals (the epos_credit_queue collection) to the customer's Epos
 * Now balance. The Epos Now token stays on this Mac: every Epos call goes
 * through the `epos` command. See deploy/mac/README.md.
 *
 * Env:
 *   VAULT_PB_URL                PocketBase base URL, e.g. https://vault.example
 *   VAULT_PB_EMAIL              superuser email
 *   VAULT_PB_KEYCHAIN_SERVICE   keychain service holding the superuser password
 *   EPOS_BIN                    optional, default /usr/local/bin/epos
 *   EPOS_TIMEOUT_MS             optional, default 60000
 *   SECURITY_BIN                optional, default /usr/bin/security
 *   EPOS_CREDIT_LOCK            optional lock file path
 *
 * Node 22 or later, built-ins only.
 */
import { execFile, spawn } from "node:child_process"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { runOnce } from "./lib/epos-credit.mjs"

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

/** The default Epos runner: spawn `epos METHOD PATH [BODY]`, kill it on timeout. */
export function makeEposRunner(bin, timeoutMs) {
  return (method, path, body) =>
    new Promise((resolve) => {
      const args = body === undefined ? [method, path] : [method, path, body]
      let stdout = ""
      let timedOut = false
      let child
      try {
        child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
      } catch (err) {
        resolve({ stdout: "", exitCode: null, timedOut: false, spawnError: err.message })
        return
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)
      child.stdout.on("data", (c) => (stdout += c))
      child.stderr.on("data", () => {}) // curl's own messages; not logged, they may echo the URL
      child.on("error", (err) => {
        clearTimeout(timer)
        resolve({ stdout, exitCode: null, timedOut: false, spawnError: err.message })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ stdout, exitCode: code, timedOut, spawnError: null })
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
  async function list(collection, filter, sort) {
    const q = new URLSearchParams({ filter, sort, perPage: "200" })
    const out = await call("GET", `/api/collections/${collection}/records?${q}`)
    return (out && out.items) || []
  }
  return {
    listSending: () => list("epos_credit_queue", "status = 'sending'", "created"),
    listDue: (max) =>
      list("epos_credit_queue", `status = 'pending' || (status = 'failed' && attempts < ${Number(max)})`, "created"),
    listNeedsCheck: () => list("epos_credit_queue", "status = 'needs_check'", "created"),
    getCustomer: (id) => call("GET", `/api/collections/customers/records/${encodeURIComponent(id)}`),
    getPrivate: async (customerId) =>
      (await list("customer_private", `customer = '${String(customerId).replace(/[^a-z0-9]/gi, "")}'`, "created"))[0] ||
      null,
    updateCustomer: (id, patch) => call("PATCH", `/api/collections/customers/records/${encodeURIComponent(id)}`, patch),
    updateRow: (id, patch) => call("PATCH", `/api/collections/epos_credit_queue/records/${encodeURIComponent(id)}`, patch),
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
  const release = takeLock(process.env.EPOS_CREDIT_LOCK || join(tmpdir(), "uk.co.ggentertainment.epos-credit-sync.lock"))
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
    })
    const total = counts.done + counts.failed + counts.needs_check + counts.stuck + counts.errors
    if (total > 0 || counts.needs_check_total > 0) {
      log(
        `run: done=${counts.done} failed=${counts.failed} needs_check=${counts.needs_check + counts.stuck} skipped=${counts.errors} waiting_for_check=${counts.needs_check_total}`
      )
    }
    return counts.errors > 0 ? 1 : 0
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
