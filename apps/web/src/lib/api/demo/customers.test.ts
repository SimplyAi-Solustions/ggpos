import { beforeEach, describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import {
  DEMO_CUSTOMERS,
  demoCreditLedger,
  demoEraseCustomer,
  demoGetCustomer,
  demoMergeCounts,
  demoMergeCustomers,
  demoSearchCustomers,
} from "@/lib/api/demo/customers"

/**
 * The demo book stands in for two server routes, so it has to behave like
 * them: a merge moves the ledger and recomputes the balance, an erasure
 * refuses while there is credit to pay out, and a code typed with an I, an
 * L or an O still finds its card.
 */

const seedCustomers = DEMO_CUSTOMERS.map((entry) => ({
  customer: { ...entry.customer },
  private: { ...entry.private },
}))
const seedLedger = demoCreditLedger.map((row) => ({ ...row }))

beforeEach(() => {
  DEMO_CUSTOMERS.length = 0
  for (const entry of seedCustomers) {
    DEMO_CUSTOMERS.push({
      customer: { ...entry.customer },
      private: { ...entry.private },
    })
  }
  demoCreditLedger.length = 0
  for (const row of seedLedger) demoCreditLedger.push({ ...row })
})

describe("finding a customer", () => {
  it("finds a card by its code", () => {
    const code = buildCode("customer", "4K7M2").encoded
    expect(demoGetCustomer(code)?.customer.name).toBe("Jasmine Okafor")
  })

  it("finds a card from a code typed with I, L or O", () => {
    // Crockford reads I and L as 1 and O as 0, so GGC-9QB3XC typed with a
    // letter O in place of the zero still has to land on Tom.
    const real = buildCode("customer", "9QB3X")
    const typed = real.display.replace(/0/g, "O").replace(/1/g, "I")
    expect(demoGetCustomer(typed)?.customer.name).toBe("Tom Bradbury")
  })

  it("matches a partial phone number", () => {
    expect(demoSearchCustomers("900456").map((hit) => hit.name)).toContain(
      "Tom Bradbury"
    )
  })
})

describe("merging", () => {
  it("counts what it is about to move", () => {
    expect(demoMergeCounts("cust_demo_3")).toEqual({ credit_ledger: 1 })
  })

  it("recomputes the balance from the ledger it moved", () => {
    // Callum holds £12.50 in one credit row; folding him into Tom, who
    // holds none, leaves Tom with that row and that balance.
    const profile = demoMergeCustomers("cust_demo_2", "cust_demo_3")
    expect(profile.private?.credit_balance).toBe(1250)
    expect(
      demoCreditLedger.filter((row) => row.customer === "cust_demo_2")
    ).toHaveLength(1)
  })

  it("keeps a flag from either card", () => {
    const profile = demoMergeCustomers("cust_demo_2", "cust_demo_3")
    expect(profile.private?.flags).toContain("no_cash")
  })

  it("moves ID details only into a card that has none", () => {
    // Tom has no ID; Jasmine's moves across with her.
    const profile = demoMergeCustomers("cust_demo_2", "cust_demo_1")
    expect(profile.private?.id_status).toBe("verified")
    expect(profile.private?.id_ref_last4).toBe("4471")
  })

  it("leaves a verified card's own ID alone", () => {
    const profile = demoMergeCustomers("cust_demo_1", "cust_demo_2")
    expect(profile.private?.id_ref_last4).toBe("4471")
  })

  it("takes the contact details the kept card is missing", () => {
    const profile = demoMergeCustomers("cust_demo_2", "cust_demo_4")
    expect(profile.customer.email).toBe("tom.bradbury@example.co.uk")
  })
})

describe("erasing", () => {
  it("refuses while there is store credit to pay out", () => {
    expect(() => demoEraseCustomer("cust_demo_1")).toThrow(
      "This customer still has £45.00 store credit. Pay it out or write it off first."
    )
  })

  it("anonymises a customer who holds nothing", () => {
    const profile = demoEraseCustomer("cust_demo_2")
    expect(profile.customer.name).toBe("Erased customer")
    expect(profile.customer.email).toBeUndefined()
    expect(profile.customer.phone).toBeUndefined()
    expect(profile.private?.address).toBe("")
  })

  it("rotates the QR token, so a printed card stops opening the portal", () => {
    const before = demoGetCustomer("cust_demo_2")?.customer.qr_token
    const after = demoEraseCustomer("cust_demo_2").customer.qr_token
    expect(after).not.toBe(before)
  })

  it("leaves the points ledger alone, as the route does", () => {
    const before = demoGetCustomer("cust_demo_2")?.private?.points_balance
    expect(demoEraseCustomer("cust_demo_2").private?.points_balance).toBe(before)
  })
})
