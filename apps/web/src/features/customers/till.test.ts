import { describe, expect, it } from "vitest"

import { eposLinkSentence } from "./till"

const base = { status: "" as const, eposCustomerId: "", attempts: 0, error: "", syncedAt: "" }

describe("eposLinkSentence", () => {
  it("names the Epos Now customer once linked", () => {
    expect(eposLinkSentence({ ...base, status: "linked", eposCustomerId: "781204" })).toBe(
      "On the till as Epos Now customer 781204."
    )
  })

  it("says a queued link is being retried, and how often it has tried", () => {
    expect(eposLinkSentence({ ...base, status: "queued" })).toBe("Waiting to be added to the till.")
    expect(eposLinkSentence({ ...base, status: "queued", attempts: 1 })).toMatch(/1 try so far/)
    expect(eposLinkSentence({ ...base, status: "queued", attempts: 3 })).toMatch(/3 tries so far/)
  })

  it("says what to do after Epos Now refused it for good", () => {
    const sentence = eposLinkSentence({
      ...base,
      status: "failed",
      attempts: 12,
      error: "Epos Now answered 401 to POST v4/Customer.",
    })
    expect(sentence).toMatch(/after 12 tries/)
    expect(sentence).toMatch(/Check the Epos Now API token, then link again\.$/)
  })

  it("says what an unlinked customer cannot do", () => {
    expect(eposLinkSentence(base)).toMatch(/will not scan at Epos Now/)
  })
})
