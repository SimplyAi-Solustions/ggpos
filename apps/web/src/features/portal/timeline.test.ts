import { describe, expect, it } from "vitest"

import { needsAnswer, quoteTimeline } from "@/features/portal/timeline"
import type { QuoteStatus } from "@/lib/api/types"

const formatDate = () => "27 Sep 2026"

function steps(status: QuoteStatus, extra: Record<string, unknown> = {}) {
  return quoteTimeline({ status, ...extra }, { formatDate })
}

describe("quoteTimeline", () => {
  it("marks the step the quote is on, and only that one", () => {
    const result = steps("reviewing")
    expect(result.map((step) => step.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ])
  })

  it("starts at sent for a quote that has just gone in", () => {
    const [first] = steps("submitted")
    expect(first!.state).toBe("current")
    expect(first!.detail).toContain("look at them shortly")
  })

  it("names the expiry date on an open offer", () => {
    const result = steps("offered", { offer_expires_at: "2026-09-27T12:00:00Z" })
    const current = result.find((step) => step.state === "current")
    expect(current?.label).toBe("Offer made")
    expect(current?.detail).toBe("This offer stands until 27 Sep 2026.")
  })

  it("stops the path when a quote closes, rather than carrying on past it", () => {
    const result = steps("declined", { offer_total: 4200 })
    expect(result.at(-1)).toMatchObject({ label: "Closed", state: "stopped" })
    expect(result.some((step) => step.label === "Paid" && step.state === "done")).toBe(
      false
    )
  })

  it("does not claim an offer was made when a quote closed before one", () => {
    // The shop can cancel a quote from `submitted` with a note, which the
    // server also records as `declined`. Drawing "Offer made" as done there
    // would be a history that did not happen.
    const result = steps("declined")
    expect(result.some((step) => step.label === "Offer made")).toBe(false)
    expect(result.map((step) => step.label)).toEqual([
      "Sent",
      "Being looked at",
      "Closed",
    ])
    expect(result.at(-1)).toMatchObject({ label: "Closed", state: "stopped" })
  })

  it("counts an offer with no total but an expiry as having been made", () => {
    const result = steps("declined", { offer_expires_at: "2026-09-27T12:00:00Z" })
    expect(result.find((step) => step.label === "Offer made")?.state).toBe("done")
  })

  it("words a closed quote for either side, and says what to do next", () => {
    expect(steps("declined").at(-1)!.detail).toBe(
      "This quote was closed. Send new photos any time."
    )
  })

  it("marks the items as received and waits on payment", () => {
    const result = steps("received")
    const current = result.find((step) => step.state === "current")
    expect(current?.label).toBe("Items received")
    expect(current?.detail).toContain("Payment follows")
    expect(result.find((step) => step.label === "Accepted")?.state).toBe("done")
  })

  it("asks for an answer on an offer with no expiry rather than a date", () => {
    const result = steps("offered")
    const current = result.find((step) => step.state === "current")
    expect(current?.detail).toBe("Accept or decline below.")
  })

  it("says when an expired offer ran out, and what to do next", () => {
    const result = steps("expired", { offer_expires_at: "2026-09-27T12:00:00Z" })
    expect(result.at(-1)!.detail).toBe(
      "This offer expired on 27 Sep 2026. Ask for a new one."
    )
  })

  it("has every step done and the last one current when it is paid", () => {
    const result = steps("completed")
    expect(result.at(-1)).toMatchObject({ label: "Paid", state: "current" })
    expect(result.slice(0, -1).every((step) => step.state === "done")).toBe(true)
  })

  it("draws the plain path for a status it does not know", () => {
    const result = quoteTimeline({ status: "queued" as QuoteStatus }, { formatDate })
    expect(result).toHaveLength(6)
    expect(result.every((step) => step.state === "upcoming")).toBe(true)
  })

  it("puts the one sentence under the current step and nowhere else", () => {
    const withDetail = steps("accepted").filter((step) => step.detail !== null)
    expect(withDetail).toHaveLength(1)
    expect(withDetail[0]!.label).toBe("Accepted")
  })
})

describe("needsAnswer", () => {
  const now = new Date("2026-09-20T09:00:00Z")

  it("is true for an offer that is still live", () => {
    expect(
      needsAnswer({ status: "offered", offer_expires_at: "2026-09-27T12:00:00Z" }, now)
    ).toBe(true)
  })

  it("is false once the offer has run out", () => {
    expect(
      needsAnswer({ status: "offered", offer_expires_at: "2026-09-19T12:00:00Z" }, now)
    ).toBe(false)
  })

  it("is false for any other status", () => {
    expect(needsAnswer({ status: "accepted" }, now)).toBe(false)
    expect(needsAnswer({ status: "submitted" }, now)).toBe(false)
  })

  it("treats an offer with no expiry as still open", () => {
    expect(needsAnswer({ status: "offered" }, now)).toBe(true)
  })
})
