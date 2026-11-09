import { describe, expect, it } from "vitest"

import { DEFAULT_GRADING, feeFor, gradingOutcome, summariseGraded, type GradedPoint } from "./grading"

const NOW = new Date("2026-11-09T12:00:00Z")

function point(over: Partial<GradedPoint>): GradedPoint {
  return { at: "2026-11-01", pence: 10_000, source: "ebay_uk_asking", grader: "PSA", grade: "10", ...over }
}

describe("summariseGraded", () => {
  it("takes the median of recent UK sold comps over a listing read", () => {
    const slabs = summariseGraded(
      [
        point({ at: "2026-11-08", pence: 50_000 }),
        point({ at: "2026-10-01", pence: 30_000, source: "uk_sold_manual" }),
        point({ at: "2026-10-20", pence: 36_000, source: "uk_sold_manual" }),
        point({ at: "2026-10-28", pence: 32_000, source: "uk_sold_manual" }),
      ],
      NOW
    )
    expect(slabs).toHaveLength(1)
    expect(slabs[0]).toMatchObject({ grader: "PSA", grade: "10", pence: 32_000, source: "uk_sold_manual", count: 4, fromSales: true, at: "2026-10-28" })
  })

  it("rounds an even median half up and uses the newest listing when sales are old", () => {
    const even = summariseGraded([point({ at: "2026-11-01", pence: 101, source: "uk_sold_manual" }), point({ at: "2026-11-02", pence: 102, source: "uk_sold_manual" })], NOW)
    expect(even[0]!.pence).toBe(102)
    const old = summariseGraded([point({ at: "2026-01-01", pence: 90_000, source: "uk_sold_manual" }), point({ at: "2026-11-01", pence: 40_000 }), point({ at: "2026-10-01", pence: 45_000 })], NOW)
    expect(old[0]).toMatchObject({ pence: 40_000, source: "ebay_uk_asking", fromSales: false, count: 3 })
  })

  it("keeps slabs apart and drops ungraded or zero rows", () => {
    const slabs = summariseGraded([point({}), point({ grader: "ACE", pence: 8_000 }), point({ grade: "", pence: 1 }), point({ grade: "9", pence: 0 })], NOW)
    expect(slabs.map((s) => `${s.grader} ${s.grade}`).sort()).toEqual(["ACE 10", "PSA 10"])
  })
})

describe("feeFor", () => {
  it("adds post to the grader's own fee", () => {
    expect(feeFor("ACE", DEFAULT_GRADING)).toBe(2300)
    expect(feeFor("PSA", DEFAULT_GRADING)).toBe(3300)
  })
})

describe("gradingOutcome", () => {
  const slabs = (psa10: number | null, psa9: number | null, ace10: number | null) =>
    [
      psa10 != null ? { grader: "PSA", grade: "10", pence: psa10 } : null,
      psa9 != null ? { grader: "PSA", grade: "9", pence: psa9 } : null,
      ace10 != null ? { grader: "ACE", grade: "10", pence: ace10 } : null,
    ]
      .filter((s): s is { grader: string; grade: string; pence: number } => s !== null)
      .map((s) => ({ ...s, at: "2026-11-01", source: "uk_sold_manual", count: 1, fromSales: true }))

  it("is unknown without a raw price or any 10", () => {
    expect(gradingOutcome(null, slabs(50_000, null, null), DEFAULT_GRADING).verdict).toBe("unknown")
    expect(gradingOutcome(10_000, slabs(null, 8_000, null), DEFAULT_GRADING).verdict).toBe("unknown")
    expect(gradingOutcome(10_000, [], DEFAULT_GRADING).reason).toBe("No graded sales recorded yet.")
  })

  it("works the rows out in pence: multiple, fee and profit", () => {
    const out = gradingOutcome(10_000, slabs(50_000, 12_000, 30_000), DEFAULT_GRADING)
    const psa10 = out.rows[0]!
    expect(psa10.multiple).toBe(5)
    expect(psa10.fee).toBe(3300)
    expect(psa10.profit).toBe(50_000 - 10_000 - 3300)
    expect(out.rows[1]!.profit).toBe(12_000 - 10_000 - 3300)
    expect(out.rows[2]!.profit).toBe(30_000 - 10_000 - 2300)
  })

  it("says worth grading when the 10 pays and the 9 breaks even", () => {
    const out = gradingOutcome(10_000, slabs(50_000, 14_000, null), DEFAULT_GRADING)
    expect(out.verdict).toBe("worth")
    expect(out.best?.slab).toEqual({ grader: "PSA", grade: "10" })
    expect(out.reason).toContain("PSA 9 still breaks even")
  })

  it("says marginal when the 9 loses money or the 10 clears under the minimum", () => {
    expect(gradingOutcome(10_000, slabs(50_000, 12_000, null), DEFAULT_GRADING).verdict).toBe("marginal")
    expect(gradingOutcome(10_000, slabs(14_000, null, null), DEFAULT_GRADING).verdict).toBe("marginal")
  })

  it("says not worth it when a 10 cannot cover raw plus fees", () => {
    const out = gradingOutcome(10_000, slabs(12_000, 9_000, 11_000), DEFAULT_GRADING)
    expect(out.verdict).toBe("not_worth")
    expect(out.best?.slab.grader).toBe("PSA")
  })

  it("rests the verdict on the better 10, so an ACE 10 can carry it without a PSA 9", () => {
    const out = gradingOutcome(10_000, slabs(20_000, 9_000, 30_000), DEFAULT_GRADING)
    expect(out.best?.slab).toEqual({ grader: "ACE", grade: "10" })
    expect(out.verdict).toBe("worth")
  })
})
