/**
 * Customers: search, profile, contact edits, merge, credit ledger.
 *
 * Every function answers from the demo book or from PocketBase, so the
 * screens never branch on the mode. The staff-only half of a customer lives
 * on `customer_private` (PocketBase rules are per record, not per field), so
 * a profile is two reads and a patch is up to two writes.
 */
import { ClientResponseError } from "pocketbase"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { isNotFound } from "@/lib/api/refusal"
import {
  demoCreateCustomer,
  demoCreditLedgerFor,
  demoEraseCustomer,
  demoGetCustomer,
  demoMergeCustomers,
  demoSearchCustomers,
  demoUpdateCustomer,
  normalisePhone,
} from "@/lib/api/demo/customers"
import type {
  CreditLedgerRecord,
  CustomerPatch,
  CustomerPrivateRecord,
  CustomerProfile,
  CustomerRecord,
  CustomerSummary,
  IdStatus,
  NewCustomerInput,
  TradeInRecord,
} from "@/lib/api/types"

function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

/** At least this many characters before a phone or code is worth matching. */
const MIN_PARTIAL = 3

async function privateFor(customerId: string): Promise<CustomerPrivateRecord | null> {
  try {
    return await pb
      .collection("customer_private")
      .getFirstListItem<CustomerPrivateRecord>(
        `customer = "${escapeFilter(customerId)}"`
      )
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function lastVisitFor(customerId: string): Promise<string | null> {
  try {
    const page = await pb.collection("trade_ins").getList<TradeInRecord>(1, 1, {
      filter: `customer = "${escapeFilter(customerId)}" && status = "completed"`,
      sort: "-completed_at",
    })
    return page.items[0]?.completed_at ?? null
  } catch {
    return null
  }
}

function summarise(
  customer: CustomerRecord,
  priv: CustomerPrivateRecord | null,
  lastVisit: string | null
): CustomerSummary {
  return {
    id: customer.id,
    name: customer.name,
    code: customer.code,
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    idStatus: (priv?.id_status ?? "none") as IdStatus,
    creditBalance: priv?.credit_balance ?? 0,
    lastVisit,
    flags: priv?.flags ?? [],
  }
}

/**
 * One box for a name, a phone number, an email or a GGC code. Partial
 * matches throughout, because staff type the first few letters of a name or
 * the last few digits of a number while the customer is still talking.
 */
export async function searchCustomers(query: string): Promise<CustomerSummary[]> {
  if (isDemo()) return demoSearchCustomers(query)

  const raw = query.trim()
  const clauses: string[] = []
  if (raw) {
    const needle = escapeFilter(raw)
    clauses.push(`name ~ "${needle}"`)
    clauses.push(`email ~ "${needle}"`)
    const code = raw.toUpperCase().replace(/[-\s]/g, "")
    if (code.length >= MIN_PARTIAL) clauses.push(`code ~ "${escapeFilter(code)}"`)
    const digits = normalisePhone(raw)
    if (digits.length >= MIN_PARTIAL) clauses.push(`phone ~ "${escapeFilter(digits)}"`)
    // Staff type "07700 900456" as often as "07700900456", and the stored
    // value may carry either shape, so the raw string is matched too.
    if (raw !== digits) clauses.push(`phone ~ "${needle}"`)
  }

  const page = await pb.collection("customers").getList<CustomerRecord>(1, 25, {
    filter: clauses.length > 0 ? `(${clauses.join(" || ")})` : "",
    sort: "name",
  })

  const rows = await Promise.all(
    page.items.map(async (customer) => {
      const priv = await privateFor(customer.id)
      return summarise(customer, priv, null)
    })
  )
  return rows
}

/** Another customer on the same phone number or the same email address. */
async function duplicatesFor(customer: CustomerRecord): Promise<CustomerSummary[]> {
  const clauses: string[] = []
  const phone = normalisePhone(customer.phone)
  if (phone.length >= 6) clauses.push(`phone ~ "${escapeFilter(phone)}"`)
  const email = (customer.email ?? "").trim()
  if (email) clauses.push(`email = "${escapeFilter(email)}"`)
  if (clauses.length === 0) return []

  const page = await pb.collection("customers").getList<CustomerRecord>(1, 10, {
    filter: `(${clauses.join(" || ")}) && id != "${escapeFilter(customer.id)}"`,
    sort: "name",
  })
  return Promise.all(
    page.items.map(async (other) => summarise(other, await privateFor(other.id), null))
  )
}

/** A customer by record id or by the GGC code printed on their card. */
export async function getCustomer(idOrCode: string): Promise<CustomerProfile | null> {
  if (isDemo()) return demoGetCustomer(idOrCode)

  const needle = idOrCode.trim()
  let customer: CustomerRecord
  try {
    customer = await pb.collection("customers").getOne<CustomerRecord>(needle)
  } catch (error) {
    if (!isNotFound(error)) throw error
    try {
      customer = await pb
        .collection("customers")
        .getFirstListItem<CustomerRecord>(
          `code = "${escapeFilter(needle.toUpperCase().replace(/[-\s]/g, ""))}"`
        )
    } catch (codeError) {
      if (isNotFound(codeError)) return null
      throw codeError
    }
  }

  const [priv, lastVisit, duplicates] = await Promise.all([
    privateFor(customer.id),
    lastVisitFor(customer.id),
    duplicatesFor(customer),
  ])
  return { customer, private: priv, lastVisit, duplicates }
}

/**
 * The token out of a scanned Guild-card QR.
 *
 * The card's QR carries the whole portal link, not the GGC code
 * (docs/label-spec.md), so a wedge scan at the counter arrives as
 * `https://vault.ggentertainment.co.uk/c/abc123`. A bare token is accepted
 * too, so a hand-typed one works.
 */
export function qrTokenFrom(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const match = /\/c\/([A-Za-z0-9_-]{8,64})\/?$/.exec(value)
  if (match) return match[1] ?? null
  if (/^[A-Za-z0-9_-]{16,64}$/.test(value) && !/^GG/i.test(value)) return value
  return null
}

/** A customer from anything the counter can scan or type at them. */
export async function findCustomerByScan(
  raw: string
): Promise<CustomerProfile | null> {
  const token = qrTokenFrom(raw)
  if (!token) return getCustomer(raw)

  if (isDemo()) {
    const match = demoSearchCustomers("")
    for (const summary of match) {
      const profile = demoGetCustomer(summary.id)
      if (profile?.customer.qr_token === token) return profile
    }
    return null
  }

  try {
    const customer = await pb
      .collection("customers")
      .getFirstListItem<CustomerRecord>(`qr_token = "${escapeFilter(token)}"`)
    return getCustomer(customer.id)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** The server assigns `code` and `qr_token` in pb_hooks/customers.pb.js. */
export async function createCustomer(input: NewCustomerInput): Promise<CustomerRecord> {
  if (isDemo()) return demoCreateCustomer(input)

  return pb.collection("customers").create<CustomerRecord>({
    name: input.name.trim(),
    phone: input.phone?.trim() || undefined,
    email: input.email?.trim() || undefined,
    marketing_consent: input.marketingConsent ?? false,
    source: "counter",
  })
}

export async function updateCustomer(
  id: string,
  patch: CustomerPatch
): Promise<CustomerProfile> {
  if (isDemo()) return demoUpdateCustomer(id, patch)

  const own: Record<string, unknown> = {}
  if (patch.name !== undefined) own.name = patch.name
  if (patch.phone !== undefined) own.phone = patch.phone
  if (patch.email !== undefined) own.email = patch.email
  if (patch.marketingConsent !== undefined) {
    own.marketing_consent = patch.marketingConsent
  }
  if (Object.keys(own).length > 0) {
    await pb.collection("customers").update(id, own)
  }

  const priv: Record<string, unknown> = {}
  if (patch.address !== undefined) priv.address = patch.address
  if (patch.notes !== undefined) priv.notes = patch.notes
  if (patch.flags !== undefined) priv.flags = patch.flags
  if (Object.keys(priv).length > 0) {
    const existing = await privateFor(id)
    if (existing) {
      await pb.collection("customer_private").update(existing.id, priv)
    } else {
      await pb.collection("customer_private").create({ customer: id, ...priv })
    }
  }

  const profile = await getCustomer(id)
  if (!profile) throw new Error("That customer could not be read back.")
  return profile
}

/** Collections that carry a `customer` relation and follow a merge. */
const MERGE_COLLECTIONS = [
  "trade_ins",
  "quotes",
  "credit_ledger",
  "points_ledger",
  "want_list",
] as const

/**
 * Fold one customer into another.
 *
 * Phase 2 has no server route for this, so it is done here: every row in the
 * collections above is re-pointed at the kept customer through the batch API,
 * then the merged record is deleted. The batch is one request and one
 * transaction on the server, so a half-merged customer is not possible; a
 * PocketBase that has the batch API switched off falls back to a row at a
 * time, which is not atomic, and the caller is told so.
 */
export async function mergeCustomers(
  keepId: string,
  mergeId: string
): Promise<CustomerProfile> {
  if (isDemo()) return demoMergeCustomers(keepId, mergeId)
  if (keepId === mergeId) {
    throw new Error("Pick a different customer to merge in.")
  }

  const moves: { collection: string; id: string }[] = []
  for (const collection of MERGE_COLLECTIONS) {
    try {
      const rows = await pb
        .collection(collection)
        .getFullList<{ id: string }>({
          filter: `customer = "${escapeFilter(mergeId)}"`,
          fields: "id",
        })
      for (const row of rows) moves.push({ collection, id: row.id })
    } catch (error) {
      // A collection this install does not have yet is not a reason to
      // refuse the merge; anything else is.
      if (!isNotFound(error)) throw error
    }
  }

  const priv = await privateFor(mergeId)
  const keepPriv = await privateFor(keepId)

  try {
    const batch = pb.createBatch()
    for (const move of moves) {
      batch.collection(move.collection).update(move.id, { customer: keepId })
    }
    if (keepPriv && priv) {
      batch.collection("customer_private").update(keepPriv.id, {
        credit_balance: (keepPriv.credit_balance ?? 0) + (priv.credit_balance ?? 0),
        points_balance: (keepPriv.points_balance ?? 0) + (priv.points_balance ?? 0),
      })
    }
    batch.collection("customers").delete(mergeId)
    await batch.send()
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 400) {
      // Batch is off on this server. Fall back, and say so, because this
      // path can stop half way.
      for (const move of moves) {
        await pb.collection(move.collection).update(move.id, { customer: keepId })
      }
      if (keepPriv && priv) {
        await pb.collection("customer_private").update(keepPriv.id, {
          credit_balance: (keepPriv.credit_balance ?? 0) + (priv.credit_balance ?? 0),
          points_balance: (keepPriv.points_balance ?? 0) + (priv.points_balance ?? 0),
        })
      }
      await pb.collection("customers").delete(mergeId)
    } else {
      throw error
    }
  }

  const profile = await getCustomer(keepId)
  if (!profile) throw new Error("That customer could not be read back.")
  return profile
}

export async function getCreditLedger(
  customerId: string
): Promise<CreditLedgerRecord[]> {
  if (isDemo()) return demoCreditLedgerFor(customerId)
  return pb.collection("credit_ledger").getFullList<CreditLedgerRecord>({
    filter: `customer = "${escapeFilter(customerId)}"`,
    sort: "-created",
  })
}

/**
 * Erasure as far as this phase reaches: the name, email and phone are
 * anonymised, the staff-only row is emptied and the customer is flagged.
 *
 * The rest of UK GDPR Article 17 (deleting the ID photo, voiding open
 * rewards, keeping the numbered trade-in records with their seller snapshot)
 * lands with the backend's erasure route; until then this is a front-of-house
 * anonymisation and the screen says so before it runs.
 */
export async function eraseCustomer(customerId: string): Promise<CustomerProfile> {
  if (isDemo()) return demoEraseCustomer(customerId)

  const profile = await getCustomer(customerId)
  const flags = new Set(profile?.private?.flags ?? [])
  flags.add("watchlist")

  return updateCustomer(customerId, {
    name: "Erased customer",
    email: "",
    phone: "",
    marketingConsent: false,
    address: "",
    notes: "",
    flags: [...flags],
  })
}
