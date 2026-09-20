import { buildCode } from "@gg/shared"

import type {
  CreditLedgerRecord,
  CustomerFlag,
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

/** Mutable: the demo session adds, edits and merges these. */
export const demoCustomers: DemoCustomer[] = [
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
  const needle = idOrCode.trim().toUpperCase()
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
  const code = raw.toUpperCase().replace(/[-\s]/g, "")

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

export function demoMergeCustomers(keepId: string, mergeId: string): CustomerProfile {
  const keep = findDemoCustomer(keepId)
  const merge = findDemoCustomer(mergeId)
  if (!keep || !merge) throw new Error("Customer not found in the demo shop.")

  for (const row of demoCreditLedger) {
    if (row.customer === merge.customer.id) row.customer = keep.customer.id
  }
  keep.private.credit_balance =
    (keep.private.credit_balance ?? 0) + (merge.private.credit_balance ?? 0)
  keep.private.points_balance =
    (keep.private.points_balance ?? 0) + (merge.private.points_balance ?? 0)
  if (!keep.customer.email && merge.customer.email) {
    keep.customer.email = merge.customer.email
  }
  if (!keep.private.address && merge.private.address) {
    keep.private.address = merge.private.address
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

/** Erasure, as far as the app can go without the backend: anonymise and flag. */
export function demoEraseCustomer(customerId: string): CustomerProfile {
  const entry = findDemoCustomer(customerId)
  if (!entry) throw new Error("Customer not found in the demo shop.")
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
  const flags = new Set<CustomerFlag>(entry.private.flags ?? [])
  flags.add("watchlist")
  entry.private.flags = [...flags]
  return demoGetCustomer(customerId) as CustomerProfile
}
