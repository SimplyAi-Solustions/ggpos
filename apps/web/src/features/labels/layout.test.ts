import { describe, expect, it } from "vitest"

import {
  LABEL_SPECS,
  labelLayout,
  pxToMm,
  qrTextFor,
  textWidthMm,
} from "@/features/labels/layout"
import { templateForItem } from "@/lib/api/item-shape"
import type { LabelJobDetail } from "@/lib/api/types"

function job(over: Partial<LabelJobDetail> = {}): LabelJobDetail {
  return {
    id: "label_1",
    status: "queued",
    copies: 1,
    template: "toploader_40x20",
    itemId: "item_1",
    code: "GGS7F3K2B",
    title: "Charizard ex",
    detail: "SV151 199/165 Holo",
    condition: "NM",
    price: 32499,
    requestedAt: "2026-09-20T09:10:00.000Z",
    ...over,
  }
}

describe("which label a thing gets", () => {
  it("puts singles, graded cards and loose retro on the 40 x 20 top loader", () => {
    expect(templateForItem("single")).toBe("toploader_40x20")
    expect(templateForItem("graded")).toBe("toploader_40x20")
    expect(templateForItem("retro", "loose")).toBe("toploader_40x20")
    expect(templateForItem("sealed")).toBe("toploader_40x20")
  })

  it("puts boxed and complete retro on the 50 x 30", () => {
    expect(templateForItem("retro", "boxed")).toBe("retro_50x30")
    expect(templateForItem("retro", "cib")).toBe("retro_50x30")
  })

  it("puts a small accessory on the 25 x 15 sleeve", () => {
    expect(templateForItem("accessory")).toBe("sleeve_25x15")
  })
})

describe("the pixel table at 203 dpi", () => {
  it("matches docs/label-spec.md", () => {
    expect(LABEL_SPECS.toploader_40x20).toMatchObject({
      widthPx: 320,
      heightPx: 160,
      qrPx: 110,
    })
    expect(LABEL_SPECS.sleeve_25x15).toMatchObject({ widthPx: 200, heightPx: 120 })
    expect(LABEL_SPECS.retro_50x30).toMatchObject({ widthPx: 400, heightPx: 240 })
    expect(LABEL_SPECS.customer_card_80x50).toMatchObject({
      widthPx: 640,
      heightPx: 400,
      qrPx: 260,
    })
  })

  it("converts dots back to the millimetres the page prints in", () => {
    expect(pxToMm(320)).toBeCloseTo(40, 1)
    expect(pxToMm(LABEL_SPECS.sleeve_25x15.qrPx)).toBeCloseTo(11, 1)
  })
})

describe("the text on a label", () => {
  it("gives a top loader the title, the set line, the condition and the price", () => {
    const layout = labelLayout(job())
    expect(layout.lines.map((row) => row.role)).toEqual([
      "title",
      "detail",
      "condition",
      "price",
    ])
    expect(layout.lines.map((row) => row.text)).toEqual([
      "Charizard ex",
      "SV151 199/165 Holo",
      "NM",
      "£324.99",
    ])
    expect(layout.showMark).toBe(true)
  })

  it("leaves out a line the item has nothing for", () => {
    const layout = labelLayout(job({ detail: "", condition: "" }))
    expect(layout.lines.map((row) => row.role)).toEqual(["title", "price"])
  })

  it("gives a sleeve the code and nothing else, because 25 x 15 has no room", () => {
    const layout = labelLayout(job({ template: "sleeve_25x15" }))
    expect(layout.lines).toEqual([{ role: "code", text: "GGS-7F3K2B" }])
    expect(layout.showMark).toBe(false)
  })

  it("sets bigger type on the 50 x 30 than on the 40 x 20", () => {
    const small = labelLayout(job())
    const big = labelLayout(job({ template: "retro_50x30" }))
    expect(big.titleMm).toBeGreaterThan(small.titleMm)
    expect(big.priceMm).toBeGreaterThan(small.priceMm)
    expect(big.qrMm).toBeGreaterThan(small.qrMm)
  })

  it("gives a customer card the name, the code and the tier", () => {
    const layout = labelLayout(
      job({
        template: "customer_card_80x50",
        title: "Ash Ketchum",
        code: "GGC4K7M2S",
        detail: "Regular",
      })
    )
    expect(layout.lines).toEqual([
      { role: "title", text: "Ash Ketchum" },
      { role: "code", text: "GGC-4K7M2S" },
      { role: "tier", text: "Regular" },
    ])
  })
})

describe("what the QR encodes", () => {
  it("carries the bare code on an item label, so the scan listener routes it", () => {
    expect(qrTextFor(job(), "https://vault.ggentertainment.co.uk")).toBe("GGS7F3K2B")
    expect(labelLayout(job()).qrText).toBe("GGS7F3K2B")
  })

  it("carries the portal link on a customer card, so a phone camera opens it", () => {
    const layout = labelLayout(
      job({ template: "customer_card_80x50", code: "tok_abc123" }),
      "https://vault.ggentertainment.co.uk/"
    )
    expect(layout.qrText).toBe("https://vault.ggentertainment.co.uk/c/tok_abc123")
  })
})

describe("a title that does not fit", () => {
  it("shrinks rather than clipping, because a cut name is no use at the counter", () => {
    const short = labelLayout(job({ title: "Pikachu" }))
    const long = labelLayout(job({ title: "Mabel, Heir to Cragflame" }))
    expect(short.titleMm).toBe(2.6)
    expect(long.titleMm).toBeLessThan(short.titleMm)
    expect(long.titleMm).toBeGreaterThanOrEqual(1.6)
  })

  it("never shrinks past the floor, whatever the title", () => {
    const silly = labelLayout(job({ title: "A".repeat(200) }))
    expect(silly.titleMm).toBe(1.6)
  })

  it("leaves the text column beside the QR", () => {
    expect(textWidthMm(LABEL_SPECS.toploader_40x20)).toBeCloseTo(21.74, 1)
    expect(textWidthMm(LABEL_SPECS.retro_50x30)).toBeCloseTo(26.73, 1)
  })
})
