import { buildCode, formatGBP, normaliseCode } from "@gg/shared"

import type {
  CreditLedgerRecord,
  CustomerPatch,
  CustomerPrivateRecord,
  CustomerProfile,
  CustomerRecord,
  CustomerSummary,
  IdCheckPayload,
  IdStatus,
  NewCustomerInput,
} from "@/lib/api/types"

/**
 * The demo shop's customer book, in memory.
 *
 * Four people, chosen so every branch of the customers area and the buy-in
 * wizard has something real to show: one with a verified ID and store credit,
 * one with no email (so "Email card" and "Email receipt" hide themselves),
 * one flagged `no_cash` (so the offer step refuses cash with a reason), and
 * one who shares a phone number with another, so the duplicate notice and the
 * merge dialog are reachable.
 *
 * Nothing here is persisted: a reload starts the demo shop over.
 */

const DAY = 86_400_000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function yearsAhead(years: number): string {
  const date = new Date()
  date.setFullYear(date.getFullYear() + years)
  return date.toISOString().slice(0, 10)
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export interface DemoCustomer {
  customer: CustomerRecord
  private: CustomerPrivateRecord
}

function seed(
  id: string,
  body: string,
  customer: Omit<CustomerRecord, "id" | "code" | "qr_token">,
  priv: Omit<CustomerPrivateRecord, "id" | "customer">
): DemoCustomer {
  return {
    customer: {
      id,
      code: buildCode("customer", body).encoded,
      qr_token: `demo-${body.toLowerCase()}-token`,
      ...customer,
    },
    private: { id: `${id}_priv`, customer: id, ...priv },
  }
}

/** The demo shop's four people, in the order they were carded. */
export const DEMO_CUSTOMERS: DemoCustomer[] = [
  seed(
    "cust_demo_1",
    "4K7M2",
    {
      name: "Jasmine Okafor",
      email: "jasmine.okafor@example.co.uk",
      phone: "07700 900123",
      marketing_consent: true,
      source: "counter",
      created: daysAgo(412),
    },
    {
      address: "12 Castle Street, Bolsover, S44 6PP",
      dob: "1994-03-18",
      flags: [],
      id_status: "verified",
      id_type: "Passport",
      id_expiry: yearsAhead(4),
      id_ref_last4: "4471",
      id_verified_by: "staff_demo",
      id_verified_at: daysAgo(96),
      credit_balance: 4500,
      points_balance: 2180,
      tier: "tier_regular",
      notes: "Collects Scarlet & Violet promos. Happy to be called about new stock.",
    }
  ),
  seed(
    "cust_demo_2",
    "9QB3X",
    {
      name: "Tom Bradbury",
      phone: "07700 900456",
      marketing_consent: false,
      source: "counter",
      created: daysAgo(203),
    },
    {
      address: "4 Sherwood Lodge Drive, Chesterfield, S41 9AB",
      flags: [],
      id_status: "none",
      credit_balance: 0,
      points_balance: 340,
      tier: "tier_member",
    }
  ),
  seed(
    "cust_demo_3",
    "T6D1N",
    {
      name: "Callum Reeve",
      email: "c.reeve@example.com",
      phone: "07700 900789",
      marketing_consent: false,
      source: "counter",
      created: daysAgo(61),
    },
    {
      address: "",
      flags: ["no_cash"],
      id_status: "none",
      credit_balance: 1250,
      points_balance: 90,
      tier: "tier_member",
      notes: "Store credit only, agreed with Richard on 4 June.",
    }
  ),
  seed(
    "cust_demo_4",
    "H2V8R",
    {
      name: "T Bradbury",
      email: "tom.bradbury@example.co.uk",
      // The same number as Tom above: this is the duplicate to merge.
      phone: "07700 900456",
      marketing_consent: false,
      source: "portal",
      created: daysAgo(19),
    },
    {
      address: "",
      flags: [],
      id_status: "none",
      credit_balance: 0,
      points_balance: 0,
    }
  ),
]

export const demoCreditLedger: CreditLedgerRecord[] = [
  {
    id: "credit_demo_1",
    customer: "cust_demo_1",
    amount: 6000,
    reason: "trade_in",
    ref: "GG-BI-000042",
    balance_after: 6000,
    created: daysAgo(96),
  },
  {
    id: "credit_demo_2",
    customer: "cust_demo_1",
    amount: -1500,
    reason: "sale",
    ref: "GG-S-000310",
    balance_after: 4500,
    created: daysAgo(31),
  },
  {
    id: "credit_demo_3",
    customer: "cust_demo_3",
    amount: 1250,
    reason: "trade_in",
    ref: "GG-BI-000051",
    balance_after: 1250,
    created: daysAgo(61),
  },
]

/** Last completed trade-in per customer, filled in by the trade-in store. */
export const demoLastVisit = new Map<string, string>([
  ["cust_demo_1", daysAgo(31)],
  ["cust_demo_2", daysAgo(203)],
  ["cust_demo_3", daysAgo(61)],
])

export function findDemoCustomer(idOrCode: string): DemoCustomer | null {
  // `normaliseCode` applies Crockford's decode rules, so a code typed or
  // scanned with an I, an L or an O finds the card it was printed from.
  const needle = normaliseCode(idOrCode)
  return (
    demoCustomers.find(
      (entry) => entry.customer.id === idOrCode || entry.customer.code === needle
    ) ?? null
  )
}

export function toSummary(entry: DemoCustomer): CustomerSummary {
  return {
    id: entry.customer.id,
    name: entry.customer.name,
    code: entry.customer.code,
    phone: entry.customer.phone ?? "",
    email: entry.customer.email ?? "",
    idStatus: (entry.private.id_status ?? "none") as IdStatus,
    creditBalance: entry.private.credit_balance ?? 0,
    lastVisit: demoLastVisit.get(entry.customer.id) ?? null,
    flags: entry.private.flags ?? [],
  }
}

/** Digits only, so "07700 900456" and "07700900456" are the same number. */
export function normalisePhone(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "")
}

function normaliseEmail(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase()
}

export function demoDuplicatesFor(entry: DemoCustomer): CustomerSummary[] {
  const phone = normalisePhone(entry.customer.phone)
  const email = normaliseEmail(entry.customer.email)
  return demoCustomers
    .filter((other) => other.customer.id !== entry.customer.id)
    .filter(
      (other) =>
        (phone.length >= 6 && normalisePhone(other.customer.phone) === phone) ||
        (email.length > 0 && normaliseEmail(other.customer.email) === email)
    )
    .map(toSummary)
}

export function demoSearchCustomers(query: string): CustomerSummary[] {
  const raw = query.trim()
  if (!raw) return demoCustomers.map(toSummary)

  const needle = raw.toLowerCase()
  const digits = normalisePhone(raw)
  const code = normaliseCode(raw)

  return demoCustomers
    .filter((entry) => {
      const { name, email, phone } = entry.customer
      if (name.toLowerCase().includes(needle)) return true
      if ((email ?? "").toLowerCase().includes(needle)) return true
      if (digits.length >= 3 && normalisePhone(phone).includes(digits)) return true
      if (code.length >= 3 && entry.customer.code.includes(code)) return true
      return false
    })
    .map(toSummary)
}

export function demoGetCustomer(idOrCode: string): CustomerProfile | null {
  const entry = findDemoCustomer(idOrCode)
  if (!entry) return null
  return {
    customer: { ...entry.customer },
    private: { ...entry.private },
    lastVisit: demoLastVisit.get(entry.customer.id) ?? null,
    duplicates: demoDuplicatesFor(entry),
    verifiedByName: entry.private.id_verified_by ? "Demo Counter" : null,
  }
}

export function demoCreateCustomer(input: NewCustomerInput): CustomerRecord {
  const id = randomId("cust")
  const body = Array.from({ length: 5 }, () => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    return alphabet[Math.floor(Math.random() * alphabet.length)]
  }).join("")
  const entry: DemoCustomer = {
    customer: {
      id,
      name: input.name.trim(),
      email: input.email?.trim() || undefined,
      phone: input.phone?.trim() || undefined,
      code: buildCode("customer", body).encoded,
      qr_token: randomId("token"),
      marketing_consent: input.marketingConsent ?? false,
      source: "counter",
      created: new Date().toISOString(),
    },
    private: {
      id: `${id}_priv`,
      customer: id,
      flags: [],
      id_status: "none",
      credit_balance: 0,
      points_balance: 0,
    },
  }
  demoCustomers.unshift(entry)
  return { ...entry.customer }
}

export function demoUpdateCustomer(
  id: string,
  patch: CustomerPatch
): CustomerProfile {
  const entry = findDemoCustomer(id)
  if (!entry) throw new Error("Customer not found in the demo shop.")

  if (patch.name !== undefined) entry.customer.name = patch.name
  if (patch.phone !== undefined) entry.customer.phone = patch.phone || undefined
  if (patch.email !== undefined) entry.customer.email = patch.email || undefined
  if (patch.marketingConsent !== undefined) {
    entry.customer.marketing_consent = patch.marketingConsent
  }
  if (patch.address !== undefined) entry.private.address = patch.address
  if (patch.notes !== undefined) entry.private.notes = patch.notes
  if (patch.flags !== undefined) entry.private.flags = patch.flags

  return demoGetCustomer(entry.customer.id) as CustomerProfile
}

/**
 * What a merge would move, counted the way the server counts it, so the
 * done line reads the same in both modes. The demo book holds credit rows
 * and trade-ins; everything else it does not model reads as zero and is
 * left out of the sentence rather than shown as "0 sales".
 */
export function demoMergeCounts(mergeId: string): Record<string, number> {
  const credit = demoCreditLedger.filter((row) => row.customer === mergeId).length
  const counts: Record<string, number> = {}
  if (credit > 0) counts.credit_ledger = credit
  return counts
}

export function demoMergeCustomers(keepId: string, mergeId: string): CustomerProfile {
  const keep = findDemoCustomer(keepId)
  const merge = findDemoCustomer(mergeId)
  if (!keep || !merge) throw new Error("Customer not found in the demo shop.")

  for (const row of demoCreditLedger) {
    if (row.customer === merge.customer.id) row.customer = keep.customer.id
  }
  // The route recomputes the cached balances from the moved ledger rows
  // rather than adding the two cached numbers, so this does the same.
  keep.private.credit_balance = demoCreditLedger
    .filter((row) => row.customer === keep.customer.id)
    .reduce((sum, row) => sum + row.amount, 0)
  keep.private.points_balance =
    (keep.private.points_balance ?? 0) + (merge.private.points_balance ?? 0)
  // Flags are a union: a `no_cash` on either card has to survive a merge.
  keep.private.flags = [
    ...new Set([...(keep.private.flags ?? []), ...(merge.private.flags ?? [])]),
  ]
  if (!keep.customer.email && merge.customer.email) {
    keep.customer.email = merge.customer.email
  }
  if (!keep.customer.phone && merge.customer.phone) {
    keep.customer.phone = merge.customer.phone
  }
  if (!keep.private.address && merge.private.address) {
    keep.private.address = merge.private.address
  }
  // ID details move only into a card that has none of its own: the kept
  // customer's own verification is never overwritten by an older one.
  if (keep.private.id_status !== "verified" && merge.private.id_status === "verified") {
    keep.private.id_status = merge.private.id_status
    keep.private.id_type = merge.private.id_type
    keep.private.id_expiry = merge.private.id_expiry
    keep.private.id_ref_last4 = merge.private.id_ref_last4
    keep.private.id_verified_by = merge.private.id_verified_by
    keep.private.id_verified_at = merge.private.id_verified_at
    if (!keep.private.dob) keep.private.dob = merge.private.dob
  }
  const mergedVisit = demoLastVisit.get(merge.customer.id)
  const keptVisit = demoLastVisit.get(keep.customer.id)
  if (mergedVisit && (!keptVisit || mergedVisit > keptVisit)) {
    demoLastVisit.set(keep.customer.id, mergedVisit)
  }
  demoLastVisit.delete(merge.customer.id)

  const index = demoCustomers.indexOf(merge)
  if (index >= 0) demoCustomers.splice(index, 1)

  return demoGetCustomer(keep.customer.id) as CustomerProfile
}

export function demoCreditLedgerFor(customerId: string): CreditLedgerRecord[] {
  return demoCreditLedger
    .filter((row) => row.customer === customerId)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
}

/** Posts a credit row and moves the cached balance, as the server route does. */
export function demoPostCredit(
  customerId: string,
  amount: number,
  ref: string
): number {
  const entry = findDemoCustomer(customerId)
  if (!entry) throw new Error("Customer not found in the demo shop.")
  const balance = (entry.private.credit_balance ?? 0) + amount
  entry.private.credit_balance = balance
  demoCreditLedger.unshift({
    id: randomId("credit"),
    customer: customerId,
    amount,
    reason: "trade_in",
    ref,
    balance_after: balance,
    created: new Date().toISOString(),
  })
  return balance
}

export function demoAddPoints(customerId: string, points: number): number {
  const entry = findDemoCustomer(customerId)
  if (!entry) return 0
  const balance = (entry.private.points_balance ?? 0) + points
  entry.private.points_balance = balance
  return balance
}

export function demoRecordVisit(customerId: string, at: string) {
  demoLastVisit.set(customerId, at)
}

/** The ID check route's effect on `customer_private`, in memory. */
export function demoVerifyId(customerId: string, check: IdCheckPayload) {
  const entry = findDemoCustomer(customerId)
  if (!entry) throw new Error("Customer not found in the demo shop.")
  const labels: Record<string, string> = {
    passport: "Passport",
    driving_licence: "Driving licence",
    other: "Other",
  }
  entry.private.id_status = "verified"
  entry.private.id_type = labels[check.id_type] ?? check.id_type
  entry.private.id_expiry = check.id_expiry
  entry.private.id_ref_last4 = check.id_ref_last4
  entry.private.dob = check.dob
  entry.private.address = check.address
  entry.private.id_verified_by = "staff_demo"
  entry.private.id_verified_at = new Date().toISOString()
}

/**
 * Erasure, mirroring what `POST /api/vault/customers/:id/erase` does: the
 * record is anonymised, the ID details go, and the numbered trade-ins keep
 * their seller snapshot. The route refuses while store credit remains, so
 * the demo book refuses in the same words rather than letting a demo do
 * something the counter cannot.
 */
export function demoEraseCustomer(customerId: string): CustomerProfile {
  const entry = findDemoCustomer(customerId)
  if (!entry) throw new Error("Customer not found in the demo shop.")
  const credit = entry.private.credit_balance ?? 0
  if (credit > 0) {
    throw new Error(
      `This customer still has ${formatGBP(credit)} store credit. Pay it out or write it off first.`
    )
  }
  entry.customer.name = "Erased customer"
  entry.customer.email = undefined
  entry.customer.phone = undefined
  entry.customer.marketing_consent = false
  entry.private.address = ""
  entry.private.notes = ""
  entry.private.dob = ""
  entry.private.id_status = "none"
  entry.private.id_type = ""
  entry.private.id_expiry = ""
  entry.private.id_ref_last4 = ""
  entry.private.id_verified_by = ""
  entry.private.id_verified_at = ""
  entry.private.flags = []
  // Points stay: the ledger is kept as long as the record is, and the route
  // does not touch it. The QR token rotates, so a printed card stops
  // opening a portal that is no longer anybody's.
  entry.customer.qr_token = randomId("token")
  return demoGetCustomer(customerId) as CustomerProfile
}

/**
 * Mutable: the demo session adds to, edits and merges these. The array is
 * seeded from `DEMO_CUSTOMERS`, which stays as written so the Sell screen
 * and this book can never name two different people under one id.
 */
export const demoCustomers: DemoCustomer[] = DEMO_CUSTOMERS
