import { describe, expect, it } from "vitest"

import {
  SIGNATURE_PAPER,
  exportSignature,
  isSamePoint,
  pointIn,
  type SignatureCanvas,
  type SignatureContext,
} from "@/features/tradein/signature"

/**
 * jsdom has a `<canvas>` element but no drawing context and no encoder, so
 * the pad is given a stand-in with the two things `exportSignature` actually
 * reads: its size, and what `toDataURL` hands back.
 */
interface Painted {
  canvas: SignatureCanvas
  /** What was painted behind the ink, in the order it happened. */
  painted: { fill: string; mode: string; box: number[] }[]
}

function fakePad(overrides: Partial<SignatureCanvas> = {}): Painted {
  const painted: Painted["painted"] = []
  const context: SignatureContext = {
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    fillRect: (x, y, width, height) =>
      painted.push({
        fill: String(context.fillStyle),
        mode: String(context.globalCompositeOperation),
        box: [x, y, width, height],
      }),
    save: () => {},
    restore: () => {},
  }
  return {
    painted,
    canvas: {
      width: 640,
      height: 200,
      toDataURL: () => "data:image/png;base64,iVBORw0KGgo=",
      getContext: () => context,
      ...overrides,
    },
  }
}

function fakeCanvas(overrides: Partial<SignatureCanvas> = {}): SignatureCanvas {
  return fakePad(overrides).canvas
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

  it("paints white paper behind the ink, so the PNG is never transparent", () => {
    const pad = fakePad()
    exportSignature(pad.canvas, true)
    expect(pad.painted).toEqual([
      {
        fill: SIGNATURE_PAPER,
        // Behind the strokes, not over them.
        mode: "destination-over",
        box: [0, 0, 640, 200],
      },
    ])
  })

  it("paints the same paper whatever the screen is set to", () => {
    // The pad strokes in a fixed ink and flattens onto a fixed paper, so
    // night mode cannot produce a signature that prints blank.
    const light = fakePad()
    const dark = fakePad()
    exportSignature(light.canvas, true)
    exportSignature(dark.canvas, true)
    expect(light.painted).toEqual(dark.painted)
  })

  it("paints nothing at all when there is no ink to protect", () => {
    const pad = fakePad()
    exportSignature(pad.canvas, false)
    expect(pad.painted).toEqual([])
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
