import { describe, expect, it } from "vitest"
import { ClientResponseError } from "pocketbase"

import {
  isNotFound,
  refusalMessage,
  refusalOrFallback,
} from "@/lib/api/refusal"

function response(status: number, body: Record<string, unknown>) {
  return new ClientResponseError({ status, response: body })
}

describe("refusalMessage", () => {
  it("shows a 422 business rule as the server wrote it", () => {
    const error = response(422, {
      code: 422,
      message: "Cash is capped at £8,000.00 per buy-in.",
      data: {},
    })
    expect(refusalMessage(error)).toBe("Cash is capped at £8,000.00 per buy-in.")
  })

  it("shows a 409 state conflict as the server wrote it", () => {
    const error = response(409, {
      code: 409,
      message: "This trade-in is already completed.",
      data: {},
    })
    expect(refusalMessage(error)).toBe("This trade-in is already completed.")
  })

  it("prefers the field message on a 400, where the top line is generic", () => {
    const error = response(400, {
      code: 400,
      message: "Failed to create record.",
      data: { phone: { code: "validation_max", message: "That number is too long." } },
    })
    expect(refusalMessage(error)).toBe("That number is too long.")
  })

  it("shows a 502 from a lookup, which staff can act on", () => {
    // "IGDB did not answer. Try again, or add the title manually." is a
    // sentence with something to do in it, unlike a 500.
    const error = response(502, {
      code: 502,
      message: "IGDB did not answer. Try again, or add the title manually.",
      data: {},
    })
    expect(refusalMessage(error)).toBe(
      "IGDB did not answer. Try again, or add the title manually."
    )
    expect(refusalOrFallback(error, "Try again.")).toBe(
      "IGDB did not answer. Try again, or add the title manually."
    )
  })

  it("says nothing about a 500, which has nothing staff can act on", () => {
    expect(refusalMessage(response(500, { code: 500, message: "boom" }))).toBeNull()
  })

  it("says nothing about a dropped connection", () => {
    expect(refusalMessage(new TypeError("Failed to fetch"))).toBeNull()
  })
})

describe("refusalOrFallback", () => {
  it("falls back when there is nothing to show", () => {
    expect(refusalOrFallback(new TypeError("Failed to fetch"), "Try again.")).toBe(
      "Try again."
    )
  })

  it("shows a sentence this app wrote, such as the demo step-up refusal", () => {
    expect(
      refusalOrFallback(
        new Error("That password is not right. Try again."),
        "Try again."
      )
    ).toBe("That password is not right. Try again.")
  })

  it("keeps a half-written message out of the counter's way", () => {
    expect(refusalOrFallback(new Error("ECONNRESET"), "Try again.")).toBe(
      "Try again."
    )
  })
})

describe("isNotFound", () => {
  it("knows a plain 404", () => {
    expect(isNotFound(response(404, { code: 404, message: "" }))).toBe(true)
    expect(isNotFound(response(403, { code: 403, message: "" }))).toBe(false)
  })
})
