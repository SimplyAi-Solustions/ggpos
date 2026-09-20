import { describe, expect, it } from "vitest"
import { buildCode } from "@gg/shared"

import {
  bulkCodes,
  bulkProblem,
  bulkSelector,
  emptyBulkForm,
  queueOutcome,
  tradeInNumber,
  type BulkForm,
} from "@/features/labels/bulk"

const CARD = buildCode("single", "7F3K2")
const OTHER = buildCode("single", "T4M9P")

function form(patch: Partial<BulkForm> = {}): BulkForm {
  return { ...emptyBulkForm(), ...patch }
}

describe("by buy-in number", () => {
  it("asks for the number when there is none", () => {
    expect(bulkProblem(form())).toBe(
      "Scan or type the buy-in number, for example GG-BI-000123."
    )
  })

  it("says what a buy-in number looks like when it is given something else", () => {
    expect(bulkProblem(form({ tradeIn: "GGS-7F3K2Q" }))).toBe(
      "GGS-7F3K2Q is not a buy-in number. They look like GG-BI-000123."
    )
  })

  it("takes a scanned number however it was typed", () => {
    const filled = form({ tradeIn: " gg-bi-000123 " })
    expect(bulkProblem(filled)).toBeNull()
    expect(tradeInNumber(filled)).toBe("GG-BI-000123")
  })

  it("sends the id the counter looked the number up with", () => {
    expect(
      bulkSelector(form({ tradeIn: "GG-BI-000123" }), { tradeInId: "trade_1" })
    ).toEqual({ trade_in: "trade_1" })
  })
})

describe("by the dates stock came in", () => {
  it("wants at least one of the two dates", () => {
    expect(bulkProblem(form({ mode: "dates" }))).toBe(
      "Give the dates the stock came in between."
    )
  })

  it("refuses a range that runs backwards", () => {
    expect(
      bulkProblem(form({ mode: "dates", from: "2026-09-20", to: "2026-09-01" }))
    ).toBe("The first date is after the second one.")
  })

  it("takes one date on its own", () => {
    expect(bulkProblem(form({ mode: "dates", from: "2026-09-20" }))).toBeNull()
  })

  it("carries the location, the kind and the game when they are set", () => {
    expect(
      bulkSelector(
        form({
          mode: "dates",
          from: "2026-09-01",
          to: "2026-09-20",
          location: "loc_binder_a",
          kind: "single",
          game: "game_pokemon",
        })
      )
    ).toEqual({
      acquired_from: "2026-09-01",
      acquired_to: "2026-09-20",
      location: "loc_binder_a",
      kind: "single",
      game: "game_pokemon",
    })
  })

  it("leaves out what was not filled in", () => {
    expect(bulkSelector(form({ mode: "dates", from: "2026-09-01" }))).toEqual({
      acquired_from: "2026-09-01",
    })
  })
})

describe("by a run of scanned codes", () => {
  it("reads commas, spaces and new lines alike, and drops repeats", () => {
    const filled = form({
      mode: "codes",
      codes: `${CARD.display}, ${OTHER.display}\n${CARD.display}`,
    })
    expect(bulkCodes(filled)).toEqual([CARD.encoded, OTHER.encoded])
  })

  it("asks for a code when the box is empty", () => {
    expect(bulkProblem(form({ mode: "codes" }))).toBe(
      "Scan the labels, or type the codes with commas between."
    )
  })

  it("names the code that is not a GG code", () => {
    expect(bulkProblem(form({ mode: "codes", codes: "GGS-1234567" }))).toBe(
      "GGS1234567 is not a GG code. Check the label and type it again."
    )
  })

  it("sends the item ids the codes were looked up as", () => {
    expect(
      bulkSelector(form({ mode: "codes", codes: CARD.display }), {
        itemIds: ["item_demo_1"],
      })
    ).toEqual({ items: ["item_demo_1"] })
  })
})

describe("printing one that is already waiting", () => {
  it("is off unless it is asked for", () => {
    expect(bulkSelector(form({ tradeIn: "GG-BI-000123" }), { tradeInId: "t1" })).toEqual({
      trade_in: "t1",
    })
    expect(
      bulkSelector(form({ tradeIn: "GG-BI-000123", includeQueued: true }), {
        tradeInId: "t1",
      })
    ).toEqual({ trade_in: "t1", include_queued: true })
  })
})

describe("what came back", () => {
  it("counts what was queued", () => {
    expect(queueOutcome({ queued: 12, skipped: 0, job_ids: [] })).toBe("12 labels queued.")
    expect(queueOutcome({ queued: 1, skipped: 0, job_ids: [] })).toBe("1 label queued.")
  })

  it("says what was passed over as well", () => {
    expect(queueOutcome({ queued: 1, skipped: 2, job_ids: [] })).toBe(
      "1 label queued. 2 labels were already waiting."
    )
    expect(queueOutcome({ queued: 3, skipped: 1, job_ids: [] })).toBe(
      "3 labels queued. 1 label was already waiting."
    )
  })

  it("says so plainly when there was nothing new to do", () => {
    expect(queueOutcome({ queued: 0, skipped: 2, job_ids: [] })).toBe(
      "Nothing new to print. 2 labels are already waiting."
    )
    expect(queueOutcome({ queued: 0, skipped: 1, job_ids: [] })).toBe(
      "Nothing new to print. 1 label is already waiting."
    )
    expect(queueOutcome({ queued: 0, skipped: 0, job_ids: [] })).toBe(
      "Nothing matched that, so nothing was queued."
    )
  })
})
