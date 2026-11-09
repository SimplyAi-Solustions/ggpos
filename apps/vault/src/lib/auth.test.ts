import { afterEach, describe, expect, it } from "vitest"

import { initials, readSession } from "@/lib/auth"
import { pb } from "@/lib/pb"

// A token whose payload expires far in the future, so the SDK calls it valid.
function token(): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  return `${b64({ alg: "HS256" })}.${b64({ exp: 4102444800, type: "auth" })}.sig`
}

afterEach(() => pb.authStore.clear())

describe("readSession", () => {
  it("is null when signed out", () => {
    expect(readSession()).toBeNull()
  })

  it("accepts a staff record and never grants more than staff for an unknown role", () => {
    pb.authStore.save(token(), {
      id: "s1",
      collectionId: "c",
      collectionName: "staff",
      email: "rich@example.com",
      name: "Richard Green",
      role: "owner",
      active: true,
    })
    expect(readSession()).toEqual({ id: "s1", email: "rich@example.com", name: "Richard Green", role: "staff" })
  })

  it("ignores a customer token from the /account pages", () => {
    pb.authStore.save(token(), { id: "c1", collectionId: "c", collectionName: "customers" })
    expect(readSession()).toBeNull()
  })

  it("drops a deactivated staff member's token", () => {
    pb.authStore.save(token(), { id: "s2", collectionId: "c", collectionName: "staff", active: false })
    expect(readSession()).toBeNull()
    expect(pb.authStore.token).toBe("")
  })
})

describe("initials", () => {
  it("takes first and last", () => {
    expect(initials("Richard Green")).toBe("RG")
    expect(initials("Gandalf")).toBe("GA")
    expect(initials("")).toBe("GG")
  })
})
