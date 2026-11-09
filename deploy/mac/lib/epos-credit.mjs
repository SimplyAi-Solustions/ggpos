/**
 * Epos Now store-credit sync: the testable part.
 *
 * Everything here is either pure (pence to pounds, parsing the `epos`
 * command's output, deciding what an outcome means) or takes its PocketBase
 * and Epos Now access as injected functions, so the tests can run the whole
 * row lifecycle against mocks. deploy/mac/epos-credit-sync.mjs wires in the
 * real ones.
 *
 * The money rule, because a retry can double a customer's credit:
 *  - a row is set to `sending` and that write is confirmed BEFORE the
 *    balance call;
 *  - HTTP 200 -> done;
 *  - a definite failure (a 4xx, or the request never left the Mac) ->
 *    failed, retried on a later run up to MAX_ATTEMPTS;
 *  - anything else (5xx, timeout, connection dropped after sending, a
 *    reply that cannot be read) -> needs_check, never retried by the worker;
 *  - a row found in `sending` when a run starts -> needs_check.
 */
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
// The shared money helpers, as the generated CommonJS copy the hooks use
// (packages/shared/src/money.ts, built by `pnpm --filter @gg/shared build:hooks`).
const money = require("../../../pb/pb_hooks/lib/shared/money.js")

export const MAX_ATTEMPTS = 5
export const NOTES = "Created by GG Vault"

// curl exit codes (from `epos`, which runs curl -sS under set -e) that mean
// the request was never written to the network: bad usage or URL, the
// script failing before curl (no token: 1, 2, or the keychain's 44), DNS,
// proxy, connection refused, or a TLS handshake that never completed.
const NOT_SENT_EXIT_CODES = new Set([1, 2, 3, 5, 6, 7, 35, 44, 51, 53, 54, 58, 59, 60, 77, 83])

/** Pence to the decimal-pounds string Epos Now takes, via the shared helper. */
export function penceToPounds(pence) {
  if (!Number.isSafeInteger(pence) || pence <= 0) throw new Error(`Credit must be whole pence above 0, got ${pence}`)
  return money.penceToDecimal(pence)
}

/**
 * A pounds amount from Epos Now (a JSON number or a string) to pence.
 * Read through the decimal text, so 63.24 is 6324 exactly; a value with
 * more than two decimals is rounded half-up on its text. null if unusable.
 */
export function poundsToPence(value) {
  if (value === null || value === undefined || value === "") return null
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value).trim()
  if (/e/i.test(text)) text = Number(text).toFixed(4)
  const exact = money.parseDecimalToMinor(text)
  if (exact !== null) return exact
  const m = /^(-?)(\d+)\.(\d+)$/.exec(text)
  if (!m) return null
  const whole = Number(m[2]) * 100 + Number(m[3].slice(0, 2).padEnd(2, "0"))
  const up = Number(m[3][2] || "0") >= 5 ? 1 : 0
  return (m[1] ? -1 : 1) * (whole + up)
}

/** The balance call's body, built as text so the amount is never a float. */
export function balanceBody(eposCustomerId, pence) {
  if (!Number.isSafeInteger(eposCustomerId) || eposCustomerId <= 0) throw new Error("No Epos customer id")
  return `{"CustomerId":${eposCustomerId},"BalanceToAdd":${penceToPounds(pence)}}`
}

/**
 * Parse what `epos METHOD PATH [BODY]` printed: the response body, then
 * `HTTP <code>` on its own last line. Returns { code, body, json } where
 * code is null when no HTTP line was printed or it read HTTP 000.
 */
export function parseEposOutput(stdout) {
  const text = String(stdout || "").replace(/\s+$/, "")
  const nl = text.lastIndexOf("\n")
  const last = (nl === -1 ? text : text.slice(nl + 1)).trim()
  const m = /^HTTP (\d{3})$/.exec(last)
  let code = null
  let body = text
  if (m) {
    body = nl === -1 ? "" : text.slice(0, nl)
    code = Number(m[1]) || null
  }
  let json
  try {
    json = body.trim() ? JSON.parse(body) : undefined
  } catch {
    json = undefined
  }
  return { code, body, json }
}

/**
 * What a finished `epos` run means for a request that moves money.
 * `run` is what the injected runner returns:
 *   { stdout, exitCode, timedOut, spawnError }
 * Returns { outcome: "ok" | "rejected" | "not_sent" | "unknown", code, body, json, detail }.
 */
export function classify(run) {
  if (run.spawnError) {
    return { outcome: "not_sent", code: null, detail: `could not start epos: ${run.spawnError}` }
  }
  const parsed = parseEposOutput(run.stdout)
  if (run.timedOut) return { ...parsed, outcome: "unknown", detail: "timed out waiting for Epos Now" }
  if (parsed.code === 200) return { ...parsed, outcome: "ok", detail: "HTTP 200" }
  if (parsed.code !== null && parsed.code >= 400 && parsed.code < 500) {
    return { ...parsed, outcome: "rejected", detail: `HTTP ${parsed.code}` }
  }
  if (parsed.code !== null) return { ...parsed, outcome: "unknown", detail: `HTTP ${parsed.code}` }
  if (NOT_SENT_EXIT_CODES.has(run.exitCode)) {
    return { ...parsed, outcome: "not_sent", detail: `request not sent (exit ${run.exitCode})` }
  }
  return { ...parsed, outcome: "unknown", detail: `no HTTP status (exit ${run.exitCode})` }
}

/** The first record in an Epos reply that may be one object or an array. */
function first(json) {
  if (Array.isArray(json)) return json.length > 0 ? json[0] : null
  return json && typeof json === "object" ? json : null
}

function idOf(rec) {
  const id = rec && (rec.Id ?? rec.CustomerId ?? rec.CustomerID)
  const n = Number(id)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** "Jo Bloggs Smith" -> { Forename: "Jo", Surname: "Bloggs Smith" }. */
export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { Forename: "GG Vault", Surname: "Customer" }
  if (parts.length === 1) return { Forename: parts[0], Surname: "" }
  return { Forename: parts[0], Surname: parts.slice(1).join(" ") }
}

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i

/**
 * customer_private.address is one free-text field. Split it on commas and
 * new lines: a UK postcode anywhere is the PostCode, the first part is
 * AddressLine1, the last remaining part is the Town, and anything between
 * is AddressLine2. null when there is no address.
 */
export function parseAddress(text) {
  let raw = String(text || "").trim()
  if (!raw) return null
  let postCode = ""
  const pc = POSTCODE.exec(raw)
  if (pc) {
    postCode = `${pc[1]} ${pc[2]}`.toUpperCase()
    raw = raw.replace(pc[0], "")
  }
  const parts = raw
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0 && !postCode) return null
  const line1 = parts.shift() || ""
  const town = parts.length > 0 ? parts.pop() : ""
  return { AddressLine1: line1, AddressLine2: parts.join(", "), Town: town, County: "", PostCode: postCode }
}

export function customerBody(customer) {
  return JSON.stringify([
    {
      ...splitName(customer.name),
      ContactNumber: customer.phone || "",
      EmailAddress: customer.email || "",
      Notes: NOTES,
    },
  ])
}

export function addressBody(eposCustomerId, address) {
  return JSON.stringify([{ CustomerId: eposCustomerId, Name: "Main", ...address, IsMainAddress: true }])
}

/** Keep anything that looks like an email or a long number out of last_error. */
export function redact(text) {
  return String(text || "")
    .replace(/[^\s@"']+@[^\s@"']+/g, "[email]")
    .replace(/\+?\d[\d\s]{7,}\d/g, "[number]")
    .slice(0, 300)
}

class RowError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message)
    this.permanent = permanent
  }
}

/**
 * Find or create the customer's Epos Now id. Saves a newly found or created
 * id on the Vault customer straight away, so a later failure never creates
 * a second Epos customer for them. Throws RowError on any failure; none of
 * these calls moves money.
 */
async function resolveEposCustomer(row, deps) {
  const customer = await deps.pb.getCustomer(row.customer)
  if (!customer) throw new RowError("The Vault customer no longer exists.", { permanent: true })
  const known = Number(customer.epos_customer_id) || 0
  if (known > 0) return { id: known, how: "linked" }

  if (customer.email) {
    const r = classify(await deps.epos("GET", `v4/Customer/GetByEmail?email=${encodeURIComponent(customer.email)}`))
    const empty = r.json === null || r.json === undefined || (Array.isArray(r.json) && r.json.length === 0)
    if (r.outcome === "ok" && !empty) {
      if (Array.isArray(r.json) && r.json.length > 1) {
        throw new RowError(
          "Several Epos Now customers share this email. Set epos_customer_id on the Vault customer by hand.",
          { permanent: true }
        )
      }
      const id = idOf(first(r.json))
      if (!id) throw new RowError("Epos Now found the email but returned no customer id.")
      await deps.pb.updateCustomer(customer.id, { epos_customer_id: id })
      return { id, how: "email" }
    }
    if (!(r.outcome === "ok" || r.code === 404)) {
      throw new RowError(`Epos Now customer lookup failed: ${r.detail} ${redact(r.body)}`.trim())
    }
  }

  const created = classify(await deps.epos("POST", "v4/Customer", customerBody(customer)))
  if (created.code !== 200 && created.code !== 201) {
    // A create whose outcome is unknown may have made the customer; trying
    // again would make a duplicate, so it waits for a person.
    const unknown = created.outcome === "unknown"
    throw new RowError(
      unknown
        ? `Epos Now customer create may have gone through (${created.detail}). Find the customer in Epos Now, set epos_customer_id on the Vault customer, then set this row to pending.`
        : `Epos Now customer create failed: ${created.detail} ${redact(created.body)}`.trim(),
      { permanent: unknown }
    )
  }
  const id = idOf(first(created.json))
  if (!id) throw new RowError("Epos Now created the customer but returned no id. Check Epos Now for a duplicate.")
  await deps.pb.updateCustomer(customer.id, { epos_customer_id: id })

  // The address is a nice-to-have: a failure here is logged, not fatal.
  const priv = await deps.pb.getPrivate(customer.id)
  const address = parseAddress(priv && priv.address)
  if (address) {
    const a = classify(await deps.epos("POST", "v4/CustomerAddress", addressBody(id, address)))
    if (a.code !== 200 && a.code !== 201) deps.log(`  customer=${customer.id} address not added to Epos Now (${a.detail})`)
  }
  return { id, how: "created" }
}

async function setRow(deps, row, patch) {
  // A PocketBase write is safe to repeat; try a few times before giving up.
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      return await deps.pb.updateRow(row.id, patch)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * Take one due row (pending, or failed with attempts left) through to its
 * next state. Returns { status, line } for the log.
 */
export async function processRow(row, deps) {
  const amount = Number(row.amount)
  const attempts = (Number(row.attempts) || 0) + 1
  const tag = `row=${row.id} customer=${row.customer} amount=${Number.isSafeInteger(amount) ? money.formatGBP(amount) : "?"}`

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await setRow(deps, row, { status: "failed", attempts: MAX_ATTEMPTS, last_error: "The amount is not whole pence above 0." })
    return { status: "failed", line: `${tag} failed: bad amount` }
  }

  let epos
  try {
    epos = await resolveEposCustomer(row, deps)
  } catch (err) {
    const permanent = err instanceof RowError && err.permanent
    const message = err instanceof RowError ? err.message : `Worker error before sending: ${redact(err.message)}`
    await setRow(deps, row, {
      status: "failed",
      attempts: permanent ? Math.max(attempts, MAX_ATTEMPTS) : attempts,
      last_error: message,
    })
    return { status: "failed", line: `${tag} failed before sending (attempt ${attempts}): ${message.split(":")[0]}` }
  }

  // The guard: `sending` must be stored before the balance call. If this
  // write fails, nothing is sent.
  const body = balanceBody(epos.id, amount)
  const marked = await setRow(deps, row, {
    status: "sending",
    epos_customer_id: epos.id,
    attempts,
    last_error: "",
  })
  if (!marked || marked.status !== "sending") {
    throw new Error(`row ${row.id} did not save as sending; nothing was sent`)
  }

  const r = classify(await deps.epos("PUT", "v4/Customer/balance", body))
  const now = deps.now().toISOString()

  if (r.outcome === "ok") {
    const balance = poundsToPence(first(r.json)?.CurrentBalance)
    const patch = { status: "done", sent_at: now, last_error: "" }
    if (balance !== null) patch.epos_balance_after = balance
    else patch.last_error = "Epos Now confirmed the credit but sent no CurrentBalance."
    try {
      await setRow(deps, row, patch)
    } catch (err) {
      // The credit is in Epos Now; the row stays `sending`, so the next run
      // moves it to needs_check rather than sending it again.
      return {
        status: "sending",
        line: `${tag} SENT to Epos customer ${epos.id} but the row could not be marked done (${redact(err.message)}); it will show as needs_check`,
      }
    }
    const after = balance !== null ? ` balance_after=${money.formatGBP(balance)}` : ""
    return { status: "done", line: `${tag} done epos_customer=${epos.id} (${epos.how})${after}` }
  }

  if (r.outcome === "rejected" || r.outcome === "not_sent") {
    const message = `Epos Now did not add the credit: ${r.detail} ${redact(r.body)}`.trim()
    await setRow(deps, row, { status: "failed", last_error: message })
    return { status: "failed", line: `${tag} failed (attempt ${attempts}): ${r.detail}` }
  }

  await setRow(deps, row, {
    status: "needs_check",
    last_error: `Outcome unknown (${r.detail}). Check the customer's balance in Epos Now Back Office before retrying.`,
  })
  return { status: "needs_check", line: `${tag} NEEDS CHECK epos_customer=${epos.id}: ${r.detail}` }
}

/**
 * One run of the worker. deps:
 *   pb.listSending(), pb.listDue(maxAttempts), pb.listNeedsCheck(),
 *   pb.getCustomer(id), pb.getPrivate(customerId), pb.updateCustomer(id, patch),
 *   pb.updateRow(id, patch) -> the saved row
 *   epos(method, path, body?) -> { stdout, exitCode, timedOut, spawnError }
 *   log(line), now() -> Date
 * Returns counts by result.
 */
export async function runOnce(deps) {
  const counts = { done: 0, failed: 0, needs_check: 0, stuck: 0, errors: 0 }

  for (const row of await deps.pb.listSending()) {
    await setRow(deps, row, {
      status: "needs_check",
      last_error: "Found in sending when the worker started: the balance call may have gone through. Check Epos Now Back Office.",
    })
    counts.stuck++
    deps.log(`row=${row.id} customer=${row.customer} amount=${money.formatGBP(Number(row.amount) || 0)} NEEDS CHECK: was left in sending`)
  }

  for (const row of await deps.pb.listDue(MAX_ATTEMPTS)) {
    try {
      const res = await processRow(row, deps)
      if (res.status === "done") counts.done++
      else if (res.status === "failed") counts.failed++
      else counts.needs_check++
      deps.log(res.line)
    } catch (err) {
      counts.errors++
      deps.log(`row=${row.id} customer=${row.customer} skipped: ${redact(err.message)}`)
    }
  }

  const waiting = await deps.pb.listNeedsCheck()
  if (waiting.length > 0) {
    deps.log(
      `NEEDS CHECK: ${waiting.length} Epos credit row(s) need a person to check Epos Now Back Office: ${waiting.map((r) => r.id).join(", ")}. See deploy/mac/README.md.`
    )
  }
  return { ...counts, needs_check_total: waiting.length }
}
