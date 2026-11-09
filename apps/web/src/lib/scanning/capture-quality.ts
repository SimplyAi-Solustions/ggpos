/**
 * Live capture guide for the card scanner.
 *
 * Runs on every preview frame, on the phone, before a photo is taken. It
 * tells the person holding the phone what is wrong with the shot (too dark,
 * moving, tilted, glare, out of focus) and only goes green when the frame is
 * worth sending to the card ID model. Nothing here calls a server.
 *
 * Why: the 09/11/2026 model bake-off (RESEARCH/CARD_ID_BAKEOFF_RESULTS.md)
 * lost cards to toploader glare over the collector number and to blur, not
 * to the models. A better photo is cheaper than a second model call.
 *
 * Every check works on a small greyscale copy of the frame inside the card
 * guide (about 160 px wide), so one pass costs well under a millisecond on a
 * phone. Thresholds live in `DEFAULT_THRESHOLDS`; tune them there, not at
 * the call site. They are provisional: the bake-off photos are whole-scene
 * shots rather than frames cropped to the card guide, so they only gave a
 * rough floor for sharpness (the two misread blurred photos scored lowest).
 * Calibrate on the counter phone with real preview frames before launch.
 */

/** A greyscale frame: one byte of luma per pixel, row by row. */
export interface LumaFrame {
  width: number
  height: number
  data: Uint8Array
}

export interface FrameMetrics {
  /** Mean luma, 0 to 255. */
  brightness: number
  /** Variance of the Laplacian. Higher is sharper. */
  sharpness: number
  /** Share of the card area that is blown out (luma at or above `glareLuma`), 0 to 1. */
  glare: number
  /** Share of the bottom strip, where the set code and number sit, that is blown out. */
  glareNumberZone: number
  /**
   * Standard deviation of luma in the number strip. Toploader and sleeve glare
   * is mostly a pale haze rather than a blown-out patch: it washes the small
   * print out without saturating it, so low contrast here catches what the
   * blown-out count misses (the angled Yamper in the bake-off).
   */
  numberZoneContrast: number
  /** Mean absolute luma change from the previous frame, 0 to 255. Null on the first frame. */
  motion: number | null
}

export interface CaptureThresholds {
  /** Mean luma below this is too dark to read a collector number. */
  minBrightness: number
  /** Laplacian variance below this is too soft to read small print. */
  minSharpness: number
  /** Luma at or above this counts as a blown-out highlight. */
  glareLuma: number
  /** Most of the card that may be blown out. */
  maxGlare: number
  /** Most of the number strip that may be blown out. Tighter, because that is the text we need. */
  maxGlareNumberZone: number
  /** Least luma spread in the number strip before small print counts as washed out. */
  minNumberZoneContrast: number
  /** Most frame-to-frame change allowed while holding still. */
  maxMotion: number
  /** Most tilt from flat, in degrees, when the card is lying on the counter. */
  maxTiltDeg: number
  /** Height of the number strip as a share of the card, measured from the bottom. */
  numberZone: number
  /** Consecutive good frames needed before the guide goes green. */
  steadyFrames: number
}

export const DEFAULT_THRESHOLDS: CaptureThresholds = {
  minBrightness: 60,
  minSharpness: 300,
  glareLuma: 245,
  maxGlare: 0.06,
  maxGlareNumberZone: 0.03,
  minNumberZoneContrast: 18,
  maxMotion: 6,
  maxTiltDeg: 12,
  numberZone: 0.12,
  steadyFrames: 4,
}

/**
 * What the guide says, in the order it is checked: the first problem wins,
 * because there is no point asking someone to fix glare while the phone is
 * still moving.
 */
export type CaptureIssue = "dark" | "moving" | "tilted" | "glare" | "blurry"

export type CaptureState =
  | { kind: "issue"; issue: CaptureIssue }
  | { kind: "steadying" }
  | { kind: "ready" }

/** Screen copy for each state. Brand voice: short, no exclamation marks. */
export const CAPTURE_COPY: Record<CaptureIssue | "steadying" | "ready", string> = {
  dark: "Find better light",
  moving: "Hold still",
  tilted: "Hold level",
  glare: "Too much glare. Tilt the card away from the light",
  blurry: "Move a little further back to focus",
  steadying: "Hold still",
  ready: "Ready to scan",
}

/** Rec. 601 luma from RGBA pixels, as a canvas `getImageData` gives them. */
export function toLuma(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): LumaFrame {
  const data = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    data[p] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000
  }
  return { width, height, data }
}

/** Variance of the 4-neighbour Laplacian over the interior of the frame. */
export function laplacianVariance(frame: LumaFrame): number {
  const { width, height, data } = frame
  if (width < 3 || height < 3) return 0
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      const v = data[i - width] + data[i + width] + data[i - 1] + data[i + 1] - 4 * data[i]
      sum += v
      sumSq += v * v
      n++
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

export function measureFrame(
  frame: LumaFrame,
  previous: LumaFrame | null,
  thresholds: CaptureThresholds = DEFAULT_THRESHOLDS,
): FrameMetrics {
  const { width, height, data } = frame
  const zoneStart = Math.floor(height * (1 - thresholds.numberZone)) * width

  let total = 0
  let blown = 0
  let blownZone = 0
  let zoneSum = 0
  let zoneSumSq = 0
  for (let i = 0; i < data.length; i++) {
    total += data[i]
    if (i >= zoneStart) {
      zoneSum += data[i]
      zoneSumSq += data[i] * data[i]
    }
    if (data[i] >= thresholds.glareLuma) {
      blown++
      if (i >= zoneStart) blownZone++
    }
  }

  let motion: number | null = null
  if (previous && previous.width === width && previous.height === height) {
    let diff = 0
    for (let i = 0; i < data.length; i++) diff += Math.abs(data[i] - previous.data[i])
    motion = diff / data.length
  }

  const zonePixels = data.length - zoneStart
  const zoneMean = zonePixels > 0 ? zoneSum / zonePixels : 0
  return {
    brightness: total / data.length,
    sharpness: laplacianVariance(frame),
    glare: blown / data.length,
    glareNumberZone: zonePixels > 0 ? blownZone / zonePixels : 0,
    numberZoneContrast: zonePixels > 0 ? Math.sqrt(Math.max(0, zoneSumSq / zonePixels - zoneMean * zoneMean)) : 0,
    motion,
  }
}

/**
 * Degrees from flat, from a `DeviceOrientationEvent`'s beta and gamma. Only
 * meaningful when the card is lying on the counter and the phone is held
 * over it; pass null when the card is held in the hand.
 */
export function tiltFromFlat(beta: number | null, gamma: number | null): number | null {
  if (beta == null || gamma == null) return null
  return Math.max(Math.abs(beta), Math.abs(gamma))
}

/** The first problem with this frame, or null when it is good to send. */
export function frameIssue(
  metrics: FrameMetrics,
  tiltDeg: number | null,
  thresholds: CaptureThresholds = DEFAULT_THRESHOLDS,
): CaptureIssue | null {
  if (metrics.brightness < thresholds.minBrightness) return "dark"
  if (metrics.motion != null && metrics.motion > thresholds.maxMotion) return "moving"
  if (tiltDeg != null && tiltDeg > thresholds.maxTiltDeg) return "tilted"
  if (
    metrics.glare > thresholds.maxGlare ||
    metrics.glareNumberZone > thresholds.maxGlareNumberZone ||
    metrics.numberZoneContrast < thresholds.minNumberZoneContrast
  ) {
    return "glare"
  }
  if (metrics.sharpness < thresholds.minSharpness) return "blurry"
  return null
}

/**
 * Debounces per-frame verdicts so the guide does not flicker, and only says
 * "ready" after `steadyFrames` good frames in a row. Keeps the sharpest good
 * frame seen in the current steady run, so the shutter (or auto-capture)
 * sends the best of the last few frames rather than whichever came last.
 */
export function createCaptureGuide<T>(thresholds: CaptureThresholds = DEFAULT_THRESHOLDS) {
  let run = 0
  let best: { sharpness: number; frame: T } | null = null

  return {
    /** Feed one frame's metrics and the frame itself; returns what to show. */
    push(metrics: FrameMetrics, tiltDeg: number | null, frame: T): CaptureState {
      const issue = frameIssue(metrics, tiltDeg, thresholds)
      if (issue) {
        run = 0
        best = null
        return { kind: "issue", issue }
      }
      run++
      if (!best || metrics.sharpness > best.sharpness) best = { sharpness: metrics.sharpness, frame }
      return run >= thresholds.steadyFrames ? { kind: "ready" } : { kind: "steadying" }
    },
    /** The sharpest frame of the current good run, or null if there is none. */
    bestFrame(): T | null {
      return best ? best.frame : null
    },
    reset() {
      run = 0
      best = null
    },
  }
}
