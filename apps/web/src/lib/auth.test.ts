import { afterEach, describe, expect, it } from "vitest"

import { pb } from "@/lib/pb"
import { readLiveSession } from "@/lib/auth"

/**
 * A token the SDK will call valid: `isValid` only checks that the payload
 * decodes to a non-empty object with no `exp` in the past, never a real
 * signature, so any base64url-encoded JSON does.
 */
function fakeToken(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.signature`
}

afterEach(() => {
  pb.authStore.clear()
})

describe("readLiveSession", () => {
  it("is null for a record from another collection, such as a customer", () => {
    pb.authStore.save(fakeToken({ id: "cust_1" }), {
      id: "cust_1",
      collectionId: "customers",
      collectionName: "customers",
      email: "shopper@example.com",
      name: "A Shopper",
    })

    expect(readLiveSession()).toBeNull()
  })

  it("is null, and clears the store, for an inactive staff record", () => {
    pb.authStore.save(fakeToken({ id: "staff_1" }), {
      id: "staff_1",
      collectionId: "staff",
      collectionName: "staff",
      email: "leaver@ggentertainment.co.uk",
      name: "Leaver",
      role: "staff",
      active: false,
    })

    expect(readLiveSession()).toBeNull()
    expect(pb.authStore.record).toBeNull()
    expect(pb.authStore.token).toBe("")
  })

  it("returns the mapped staff member for an active staff record", () => {
    pb.authStore.save(fakeToken({ id: "staff_2" }), {
      id: "staff_2",
      collectionId: "staff",
      collectionName: "staff",
      email: "manager@ggentertainment.co.uk",
      name: "Manager Person",
      role: "admin",
      active: true,
    })

    expect(readLiveSession()).toEqual({
      id: "staff_2",
      email: "manager@ggentertainment.co.uk",
      name: "Manager Person",
      role: "admin",
      active: true,
    })
  })

  it("is null with no record in the store", () => {
    expect(readLiveSession()).toBeNull()
  })
})
