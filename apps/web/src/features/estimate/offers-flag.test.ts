import { describe, expect, it } from "vitest"

import { offersEnabled } from "@/features/estimate/offers-flag"

describe("offersEnabled", () => {
  it("is off unless the build set VITE_CUSTOMER_OFFERS=1", () => {
    expect(offersEnabled(undefined)).toBe(false)
    expect(offersEnabled("")).toBe(false)
    expect(offersEnabled("0")).toBe(false)
    expect(offersEnabled("true")).toBe(false)
    expect(offersEnabled("1")).toBe(true)
  })
})
