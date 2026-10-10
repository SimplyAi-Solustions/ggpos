import { beforeEach, describe, expect, it } from "vitest"

import { customerAuthId, pbCustomer } from "@/lib/pb-customer"
import { pb } from "@/lib/pb"

/**
 * The two sessions have to be able to coexist in one browser: a staff member
 * signed in at the counter, and a customer signed in to My Vault on the same
 * machine. These assert the separation the portal is built on, and that the
 * customer store keeps the token and nothing else.
 */

/** A well-formed unexpired token for `id`, which is all `getTokenPayload` reads. */
function token(id: string, collectionId = "customers_col"): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = btoa(
    JSON.stringify({
      id,
      type: "auth",
      collectionId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  )
  return `${header}.${payload}.signature`
}

/** Enough of a `RecordModel` for the store; the SDK only reads a few keys. */
function record(id: string, collectionName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    collectionId: `${collectionName}_col`,
    collectionName,
    ...extra,
  } as unknown as Parameters<typeof pbCustomer.authStore.save>[1]
}

const CUSTOMER = record("cust_1", "customers", {
  email: "jasmine@example.co.uk",
  name: "Jasmine Okafor",
})
const STAFF = record("staff_1", "staff")

beforeEach(() => {
  localStorage.clear()
  pbCustomer.authStore.clear()
  pb.authStore.clear()
  localStorage.clear()
})

describe("the customer auth store", () => {
  it("writes to gg_customer_auth and to nothing else", () => {
    pbCustomer.authStore.save(token("cust_1"), CUSTOMER)
    expect(Object.keys(localStorage)).toEqual(["gg_customer_auth"])
  })

  it("keeps the token alone, never the record beside it", () => {
    pbCustomer.authStore.save(token("cust_1"), CUSTOMER)
    const stored = localStorage.getItem("gg_customer_auth") ?? ""
    expect(stored).toBe(pbCustomer.authStore.token)
    expect(stored).not.toContain("Jasmine")
    expect(stored).not.toContain("example.co.uk")
  })

  it("leaves the counter's own store untouched when a customer signs in", () => {
    pb.authStore.save(token("staff_1", "staff_col"), STAFF)
    const staffToken = pb.authStore.token

    pbCustomer.authStore.save(token("cust_1"), CUSTOMER)

    expect(pb.authStore.token).toBe(staffToken)
    expect(pb.authStore.record?.id).toBe("staff_1")
  })

  it("leaves the counter signed in when the customer signs out", () => {
    pb.authStore.save(token("staff_1", "staff_col"), STAFF)
    pbCustomer.authStore.save(token("cust_1"), CUSTOMER)

    pbCustomer.authStore.clear()

    expect(pbCustomer.authStore.token).toBe("")
    expect(localStorage.getItem("gg_customer_auth")).toBeNull()
    expect(pb.authStore.record?.id).toBe("staff_1")
  })
})

describe("customerAuthId", () => {
  it("is null with no session at all", () => {
    expect(customerAuthId()).toBeNull()
  })

  it("is the customer's id once they are signed in", () => {
    pbCustomer.authStore.save(token("cust_1"), CUSTOMER)
    expect(customerAuthId()).toBe("cust_1")
  })

  it("refuses a staff record, even in the portal's own store", () => {
    pbCustomer.authStore.save(token("staff_1", "staff_col"), STAFF)
    expect(customerAuthId()).toBeNull()
  })

  it("reads the id off the token when the record has not been fetched back", () => {
    // What a reload looks like: the token persisted, the record did not.
    pbCustomer.authStore.save(token("cust_7"))
    expect(pbCustomer.authStore.record).toBeNull()
    expect(customerAuthId()).toBe("cust_7")
  })
})
