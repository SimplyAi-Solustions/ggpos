import { describe, expect, it } from "vitest"

import {
  candidateReason,
  differenceLine,
  minutesApart,
  salesForTransaction,
  transactionsForSale,
} from "@/features/cash/reconcile"
import type { SumUpSale, SumUpTransaction } from "@/lib/api/types"

function transaction(
  id: string,
  amount: number,
  timestamp: string
): SumUpTransaction {
  return { id, sumup_id: `TXN-${id}`, transaction_code: id, amount, timestamp, status: "SUCCESSFUL" }
}

function sale(id: string, cardShare: number, created: string, total = cardShare): SumUpSale {
  return { id, number: `GG-S-${id}`, total, card_share: cardShare, created, payment: "sumup_card" }
}

describe("how far apart two rows are", () => {
  it("counts whole minutes either way round", () => {
    expect(minutesApart("2026-09-20T09:00:00Z", "2026-09-20T09:03:00Z")).toBe(3)
    expect(minutesApart("2026-09-20T09:03:00Z", "2026-09-20T09:00:00Z")).toBe(3)
  })

  it("is infinite when one side has no time on file", () => {
    expect(minutesApart("", "2026-09-20T09:00:00Z")).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("candidates for an unmatched SumUp transaction", () => {
  const target = transaction("t1", 1999, "2026-09-20T11:00:00Z")

  it("puts the same amount first, whatever the time", () => {
    const ranked = salesForTransaction(target, [
      sale("near", 500, "2026-09-20T11:01:00Z"),
      sale("exact", 1999, "2026-09-20T15:40:00Z"),
    ])
    expect(ranked.map((row) => row.id)).toEqual(["exact", "near"])
  })

  it("orders same-amount candidates by how close in time they are", () => {
    const ranked = salesForTransaction(target, [
      sale("far", 1999, "2026-09-20T13:00:00Z"),
      sale("close", 1999, "2026-09-20T11:02:00Z"),
    ])
    expect(ranked.map((row) => row.id)).toEqual(["close", "far"])
  })

  it("falls back to nearest in time, then to the smallest gap in amount", () => {
    const ranked = salesForTransaction(target, [
      sale("later", 2500, "2026-09-20T11:30:00Z"),
      sale("sooner", 900, "2026-09-20T11:05:00Z"),
    ])
    expect(ranked.map((row) => row.id)).toEqual(["sooner", "later"])
  })

  it("compares a mixed sale's card share, never its total", () => {
    // A £30.00 sale with £19.99 on the card is an exact match for a £19.99
    // transaction; its total is not.
    const ranked = salesForTransaction(target, [
      sale("whole-total", 3000, "2026-09-20T11:00:30Z", 3000),
      sale("card-share", 1999, "2026-09-20T12:00:00Z", 3000),
    ])
    expect(ranked[0]?.id).toBe("card-share")
  })

  it("leaves the list it was given alone", () => {
    const rows = [sale("a", 500, "2026-09-20T11:01:00Z"), sale("b", 1999, "2026-09-20T15:00:00Z")]
    salesForTransaction(target, rows)
    expect(rows.map((row) => row.id)).toEqual(["a", "b"])
  })
})

describe("candidates for an unmatched card sale", () => {
  it("ranks transactions the same way round", () => {
    const ranked = transactionsForSale(sale("s1", 1200, "2026-09-20T11:17:00Z"), [
      transaction("t-far", 1200, "2026-09-20T16:00:00Z"),
      transaction("t-close", 1200, "2026-09-20T11:18:00Z"),
      transaction("t-other", 500, "2026-09-20T11:17:10Z"),
    ])
    expect(ranked.map((row) => row.id)).toEqual(["t-close", "t-far", "t-other"])
  })
})

describe("why a candidate is offered", () => {
  const target = { amount: 1999, at: "2026-09-20T11:00:00Z" }

  it("says so when the amount is the same", () => {
    expect(candidateReason(target, { amount: 1999, at: "2026-09-20T15:00:00Z" })).toBe(
      "Same amount"
    )
  })

  it("says how far apart otherwise, in plain words", () => {
    expect(candidateReason(target, { amount: 500, at: "2026-09-20T11:01:00Z" })).toBe(
      "1 minute apart"
    )
    expect(candidateReason(target, { amount: 500, at: "2026-09-20T11:04:00Z" })).toBe(
      "4 minutes apart"
    )
    expect(candidateReason(target, { amount: 500, at: "2026-09-20T11:00:20Z" })).toBe(
      "Same minute"
    )
  })

  it("says when there is no time to go on", () => {
    expect(candidateReason(target, { amount: 500, at: "" })).toBe("No time on file")
  })
})

describe("the difference between the two sides", () => {
  it("says which way round it falls, and never calls it an error", () => {
    expect(differenceLine(2499, 2499)).toBe("The two sides agree.")
    expect(differenceLine(2499, 1999)).toBe("SumUp took more than the Vault has on file.")
    expect(differenceLine(1999, 2499)).toBe(
      "The Vault has more card sales than SumUp took."
    )
  })
})
