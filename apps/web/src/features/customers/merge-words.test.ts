import { describe, expect, it } from "vitest"

import { movedSentence } from "@/features/customers/merge-words"

describe("movedSentence", () => {
  it("names one kind on its own", () => {
    expect(movedSentence({ trade_ins: 1 })).toBe("Moved 1 trade-in.")
  })

  it("pluralises what it counts", () => {
    expect(movedSentence({ trade_ins: 3 })).toBe("Moved 3 trade-ins.")
  })

  it("joins two kinds with an and", () => {
    expect(movedSentence({ trade_ins: 3, credit_ledger: 1 })).toBe(
      "Moved 3 trade-ins and 1 credit entry."
    )
  })

  it("joins three kinds with commas and an and", () => {
    expect(movedSentence({ trade_ins: 2, sales: 1, want_list: 4 })).toBe(
      "Moved 2 trade-ins, 1 sale and 4 want list rows."
    )
  })

  it("leaves out anything that moved nothing", () => {
    expect(movedSentence({ trade_ins: 2, sales: 0 })).toBe("Moved 2 trade-ins.")
  })

  it("says so plainly when there was nothing to move", () => {
    expect(movedSentence({})).toBe(
      "The two cards are now one. There was nothing to move."
    )
  })

  it("falls back to the collection's own name for anything new", () => {
    expect(movedSentence({ push_subscriptions: 2 })).toBe(
      "Moved 2 push subscriptions."
    )
  })
})
