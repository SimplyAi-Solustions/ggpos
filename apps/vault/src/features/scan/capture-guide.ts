/**
 * The vault's glue around capture-quality.ts (ported unchanged from
 * apps/web/src/lib/scanning): what the guide line says and in which tone,
 * when the tilt check applies, and when auto-capture fires.
 */
import { CAPTURE_COPY, tiltFromFlat, type CaptureState } from "./capture-quality"

export type GuideTone = "neutral" | "warn" | "ready"

export interface GuideLine {
  text: string
  tone: GuideTone
}

/** The one line shown over the card guide for a capture state. */
export function guideLine(state: CaptureState | null): GuideLine {
  if (!state) return { text: "Line the card up inside the frame", tone: "neutral" }
  if (state.kind === "ready") return { text: CAPTURE_COPY.ready, tone: "ready" }
  if (state.kind === "steadying") return { text: CAPTURE_COPY.steadying, tone: "neutral" }
  return { text: CAPTURE_COPY[state.issue], tone: "warn" }
}

/**
 * Tilt from flat, but only while the phone is pointing down at a card on the
 * counter. Past 45 degrees the card is being held up in the hand, where
 * "Hold level" would never clear, so the check is skipped (null).
 */
export function counterTilt(beta: number | null, gamma: number | null): number | null {
  const tilt = tiltFromFlat(beta, gamma)
  if (tilt == null || tilt > 45) return null
  return tilt
}

/** How long the guide has to stay green before auto-capture takes the shot. */
export const AUTO_CAPTURE_HOLD_MS = 700

/** True once the guide has been ready, unbroken, for the hold time. */
export function shouldAutoCapture(readySince: number | null, now: number, holdMs = AUTO_CAPTURE_HOLD_MS): boolean {
  return readySince != null && now - readySince >= holdMs
}
