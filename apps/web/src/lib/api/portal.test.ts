import { describe, expect, it } from "vitest"
import { ClientResponseError } from "pocketbase"

import { signInMessage } from "@/lib/api/portal"

function refusal(status: number, message = ""): ClientResponseError {
  return new ClientResponseError({ status, response: { message }, url: "/x" })
}

describe("signInMessage", () => {
  it("says a code did not match, and what to do next", () => {
    expect(signInMessage(refusal(400))).toBe(
      "That code does not match, or it has run out. Send another."
    )
  })

  it("says to wait when the shop has been asked too often", () => {
    expect(signInMessage(refusal(429))).toBe(
      "Too many tries. Wait a minute and ask for another code."
    )
  })

  it("shows the server's own sentence when it wrote one", () => {
    expect(signInMessage(refusal(403, "This card has been closed."))).toBe(
      "This card has been closed."
    )
  })

  it("does not repeat a server error that has nothing to say to a customer", () => {
    expect(signInMessage(refusal(500, "sql: no rows"))).toBe(
      "We could not reach the shop. Check your connection and try again."
    )
  })

  it("blames the connection for anything that is not a refusal at all", () => {
    expect(signInMessage(new TypeError("Failed to fetch"))).toBe(
      "We could not reach the shop. Check your connection and try again."
    )
  })

  it("never ends in an exclamation mark", () => {
    for (const error of [refusal(400), refusal(429), refusal(500), new Error("x")]) {
      expect(signInMessage(error)).not.toContain("!")
    }
  })
})
