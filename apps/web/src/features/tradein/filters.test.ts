import { describe, expect, it } from "vitest"

import { applyFilters } from "@/features/tradein/filters"
import type { TradeInSummary } from "@/lib/api"

const NOW = new Date("2026-09-20T14:00:00Z")

function row(patch: Partial<TradeInSummary> = {}): TradeInSummary {
  return {
    id: "t1",
    number: "GG-BI-000001",
    status: "completed",
    customerId: "c1",
    customerName: "Jasmine Okafor",
    customerCode: "GGC4K7M2Z",
    payoutType: "credit",
    totalMarket: 11_000,
    totalOffer: 6000,
    payoutCash: 0,
    payoutCredit: 6000,
    staffName: "Demo Counter",
    at: NOW.toISOString(),
    ...patch,
  }
}

describe("applyFilters", () => {
  const today = row({ id: "today" })
  const thisWeek = row({ id: "week", at: "2026-09-16T10:00:00Z" })
  const lastMonth = row({ id: "old", at: "2026-08-01T10:00:00Z" })
  const draft = row({ id: "draft", status: "draft", at: "2026-07-01T10:00:00Z" })
  const all = [today, thisWeek, lastMonth, draft]

  it("shows everything when no chip is pressed", () => {
    expect(applyFilters(all, [], NOW)).toHaveLength(4)
  })

  it("narrows to today", () => {
    expect(applyFilters(all, ["today"], NOW).map((r) => r.id)).toEqual(["today"])
  })

  it("narrows to the last seven days", () => {
    expect(applyFilters(all, ["week"], NOW).map((r) => r.id)).toEqual([
      "today",
      "week",
    ])
  })

  it("finds drafts however old they are", () => {
    expect(applyFilters(all, ["drafts"], NOW).map((r) => r.id)).toEqual(["draft"])
  })

  it("treats several chips as an or, not an and", () => {
    expect(applyFilters(all, ["today", "drafts"], NOW).map((r) => r.id)).toEqual([
      "today",
      "draft",
    ])
  })

  it("leaves a row with no date out of a date filter", () => {
    expect(applyFilters([row({ id: "nodate", at: "" })], ["today"], NOW)).toHaveLength(
      0
    )
  })
})
