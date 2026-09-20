import { describe, expect, it } from "vitest"

import {
  exportSignature,
  isSamePoint,
  pointIn,
  type SignatureCanvas,
} from "@/features/tradein/signature"

/**
 * jsdom has a `<canvas>` element but no drawing context and no encoder, so
 * the pad is given a stand-in with the two things `exportSignature` actually
 * reads: its size, and what `toDataURL` hands back.
 */
function fakeCanvas(
  overrides: Partial<SignatureCanvas> = {}
): SignatureCanvas {
  return {
    width: 640,
    height: 200,
    toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
    ...overrides,
  }
}

describe("exportSignature", () => {
  it("exports a PNG data URL from a signed pad", () => {
    const signature = exportSignature(fakeCanvas(), true)
    expect(signature).toMatch(/^data:image\/png;base64,/)
  })

  it("exports nothing when nobody has drawn on it", () => {
    expect(exportSignature(fakeCanvas(), false)).toBeNull()
  })

  it("exports nothing when there is no pad at all", () => {
    expect(exportSignature(null, true)).toBeNull()
  })

  it("refuses a pad too small to have a signature on it", () => {
    expect(exportSignature(fakeCanvas({ width: 40, height: 20 }), true)).toBeNull()
  })

  it("refuses anything that is not a PNG, rather than sending it on", () => {
    const tainted = fakeCanvas({ toDataURL: () => "data:," })
    expect(exportSignature(tainted, true)).toBeNull()
  })
})

describe("pointIn", () => {
  const rect = { left: 20, top: 40, width: 320, height: 100 }
  const canvas = { width: 640, height: 200 }

  it("scales a CSS pixel to the canvas pixel under it", () => {
    expect(pointIn(rect, canvas, { clientX: 20, clientY: 40 })).toEqual({ x: 0, y: 0 })
    expect(pointIn(rect, canvas, { clientX: 180, clientY: 90 })).toEqual({
      x: 320,
      y: 100,
    })
  })

  it("survives a pad that has not been laid out yet", () => {
    const point = pointIn(
      { left: 0, top: 0, width: 0, height: 0 },
      canvas,
      { clientX: 5, clientY: 7 }
    )
    expect(point).toEqual({ x: 5, y: 7 })
  })
})

describe("isSamePoint", () => {
  it("ignores a move too small to draw", () => {
    expect(isSamePoint({ x: 10, y: 10 }, { x: 10.2, y: 10.1 })).toBe(true)
  })

  it("draws a real move", () => {
    expect(isSamePoint({ x: 10, y: 10 }, { x: 12, y: 10 })).toBe(false)
  })
})
