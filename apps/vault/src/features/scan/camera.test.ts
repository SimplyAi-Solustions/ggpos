import { describe, expect, it } from "vitest"

import { coverCrop, fitLongEdge } from "./camera"

describe("coverCrop", () => {
  it("maps the on-screen guide onto the video's pixels under object-fit cover", () => {
    // 1920x1080 video in a 390x780 box: scaled to fill the height, cropped at the sides.
    const crop = coverCrop({ width: 1920, height: 1080 }, { width: 390, height: 780 }, { x: 45, y: 150, width: 300, height: 419 })
    const scale = 780 / 1080
    const offsetX = (390 - 1920 * scale) / 2
    expect(crop.x).toBeCloseTo((45 - offsetX) / scale)
    expect(crop.y).toBeCloseTo(150 / scale)
    expect(crop.width).toBeCloseTo(300 / scale)
    expect(crop.height).toBeCloseTo(419 / scale)
  })
})

describe("fitLongEdge", () => {
  it("shrinks to the long edge and never enlarges", () => {
    expect(fitLongEdge({ width: 3024, height: 4032 }, 1400)).toEqual({ width: 1050, height: 1400 })
    expect(fitLongEdge({ width: 600, height: 800 }, 1400)).toEqual({ width: 600, height: 800 })
  })
})
