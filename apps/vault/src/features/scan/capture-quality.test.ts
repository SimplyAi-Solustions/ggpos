import { describe, expect, it } from "vitest"

import {
  createCaptureGuide,
  DEFAULT_THRESHOLDS,
  frameIssue,
  type FrameMetrics,
  laplacianVariance,
  type LumaFrame,
  measureFrame,
  tiltFromFlat,
  toLuma,
} from "./capture-quality"

const W = 40
const H = 56

/** A sharp, mid-grey card: a checkerboard so it has edges and contrast everywhere. */
function checker(lo = 60, hi = 190): LumaFrame {
  const data = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = (x + y) % 2 ? hi : lo
  return { width: W, height: H, data }
}

function flat(value: number): LumaFrame {
  return { width: W, height: H, data: new Uint8Array(W * H).fill(value) }
}

const good: FrameMetrics = {
  brightness: 125,
  sharpness: 900,
  glare: 0,
  glareNumberZone: 0,
  numberZoneContrast: 60,
  motion: 1,
}

describe("toLuma", () => {
  it("weights green above red above blue", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
    expect(Array.from(toLuma(rgba, 3, 1).data)).toEqual([76, 149, 29])
  })
})

describe("measureFrame", () => {
  it("scores a flat frame as soft and a checkerboard as sharp", () => {
    expect(laplacianVariance(flat(120))).toBe(0)
    expect(laplacianVariance(checker())).toBeGreaterThan(DEFAULT_THRESHOLDS.minSharpness)
  })

  it("counts blown-out pixels in the number strip separately", () => {
    const frame = checker()
    const stripStart = Math.floor(H * (1 - DEFAULT_THRESHOLDS.numberZone))
    for (let y = stripStart; y < H; y++) for (let x = 0; x < 10; x++) frame.data[y * W + x] = 255
    const m = measureFrame(frame, null)
    expect(m.glareNumberZone).toBeCloseTo(10 / W)
    expect(m.glare).toBeLessThan(m.glareNumberZone)
  })

  it("reads motion against the previous frame only", () => {
    expect(measureFrame(flat(100), null).motion).toBeNull()
    expect(measureFrame(flat(110), flat(100)).motion).toBe(10)
  })
})

describe("frameIssue", () => {
  it("passes a good frame", () => {
    expect(frameIssue(good, 3)).toBeNull()
  })

  it("reports the first problem in the order a person can fix them", () => {
    const everything: FrameMetrics = {
      brightness: 30,
      sharpness: 10,
      glare: 0.5,
      glareNumberZone: 0.5,
      numberZoneContrast: 2,
      motion: 40,
    }
    expect(frameIssue(everything, 45)).toBe("dark")
    expect(frameIssue({ ...everything, brightness: 125 }, 45)).toBe("moving")
    expect(frameIssue({ ...everything, brightness: 125, motion: 1 }, 45)).toBe("tilted")
    expect(frameIssue({ ...everything, brightness: 125, motion: 1 }, null)).toBe("glare")
  })

  it("treats a washed-out number strip as glare even with nothing blown out", () => {
    expect(frameIssue({ ...good, numberZoneContrast: 5 }, null)).toBe("glare")
  })

  it("flags a soft frame", () => {
    expect(frameIssue({ ...good, sharpness: 100 }, null)).toBe("blurry")
  })
})

describe("tiltFromFlat", () => {
  it("takes the larger of the two axes and ignores a missing sensor", () => {
    expect(tiltFromFlat(-4, 15)).toBe(15)
    expect(tiltFromFlat(null, 3)).toBeNull()
  })
})

describe("createCaptureGuide", () => {
  it("only goes ready after enough good frames in a row, and keeps the sharpest", () => {
    const guide = createCaptureGuide<string>()
    expect(guide.push(good, null, "a")).toEqual({ kind: "steadying" })
    expect(guide.push({ ...good, sharpness: 1500 }, null, "b")).toEqual({ kind: "steadying" })
    expect(guide.push(good, null, "c")).toEqual({ kind: "steadying" })
    expect(guide.push(good, null, "d")).toEqual({ kind: "ready" })
    expect(guide.bestFrame()).toBe("b")
  })

  it("starts again after a bad frame", () => {
    const guide = createCaptureGuide<string>()
    for (const f of ["a", "b", "c"]) guide.push(good, null, f)
    expect(guide.push({ ...good, motion: 20 }, null, "x")).toEqual({ kind: "issue", issue: "moving" })
    expect(guide.bestFrame()).toBeNull()
    expect(guide.push(good, null, "y")).toEqual({ kind: "steadying" })
  })
})
