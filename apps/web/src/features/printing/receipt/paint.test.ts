import { describe, expect, it } from "vitest"

import { thresholdPixels } from "./paint"

/** One RGBA pixel. */
function px(r: number, g: number, b: number, a = 255): number[] {
  return [r, g, b, a]
}

function run(...pixels: number[][]): number[][] {
  const data = new Uint8ClampedArray(pixels.flat())
  thresholdPixels(data)
  const out: number[][] = []
  for (let i = 0; i < data.length; i += 4) out.push(Array.from(data.subarray(i, i + 4)))
  return out
}

describe("thresholdPixels", () => {
  it("turns every pixel pure black or pure white and fully opaque", () => {
    const out = run(px(0, 0, 0), px(255, 255, 255), px(30, 40, 50), px(200, 210, 220), px(128, 128, 128))
    for (const pixel of out) {
      expect([0, 255]).toContain(pixel[0])
      expect(pixel[1]).toBe(pixel[0])
      expect(pixel[2]).toBe(pixel[0])
      expect(pixel[3]).toBe(255)
    }
  })

  it("counts a dark antialiased edge as ink and a light one as paper", () => {
    const [dark, mid, light] = run(px(60, 60, 60), px(150, 150, 150), px(190, 190, 190))
    expect(dark?.[0]).toBe(0)
    // Just under the cutoff still prints, so a thin stroke of a small Jost survives.
    expect(mid?.[0]).toBe(0)
    expect(light?.[0]).toBe(255)
  })

  it("judges a colour by how bright it looks, so yellow is paper and blue is ink", () => {
    const [yellow, blue] = run(px(255, 255, 0), px(0, 0, 255))
    expect(yellow?.[0]).toBe(255)
    expect(blue?.[0]).toBe(0)
  })

  it("treats a see-through pixel as paper, whatever colour is hiding in it", () => {
    const [clear, faint] = run(px(0, 0, 0, 0), px(0, 0, 0, 20))
    expect(clear?.[0]).toBe(255)
    expect(faint?.[0]).toBe(255)
  })

  it("leaves an empty image alone", () => {
    expect(run()).toEqual([])
  })
})
