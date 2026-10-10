/**
 * How long everything lasts. One place, so the composition's length and
 * the scenes inside it always agree.
 */
export const FPS = 30

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Step {
  image: string
  caption: string
  section: string | null
  chapter: string
  target: Box | null
  action: "click" | "type" | "press" | "highlight" | "none"
  value: string | null
  zoom: boolean
  hold: number | null
}

export interface Manifest {
  slug: string
  number: number
  title: string
  subtitle: string
  outline: string[]
  next?: string | null
  viewport: { width: number; height: number }
  scale: number
  steps: Step[]
}

export const INTRO = 5 * FPS
export const OUTRO = 6 * FPS
export const SECTION = Math.round(2.2 * FPS)

export function outlineFrames(m: Manifest): number {
  return Math.round((2.6 + 0.7 * m.outline.length) * FPS)
}

/** Reading time for a caption, plus time to watch the pointer and the screen change. */
export function stepFrames(step: Step): number {
  if (step.hold) return Math.round(step.hold * FPS)
  const words = step.caption.trim().split(/\s+/).length
  let seconds = 1.9 + words * 0.3
  if (step.action === "type" && step.value) seconds += 0.6 + step.value.length * 0.06
  if (step.target && step.action !== "highlight" && step.action !== "none") seconds += 0.5
  return Math.round(Math.min(9, Math.max(3.4, seconds)) * FPS)
}

export interface Segment {
  kind: "intro" | "outline" | "section" | "step" | "outro"
  from: number
  frames: number
  step?: Step
  index?: number
  title?: string
  sectionNumber?: number
}

/** The whole running order with each part's start frame. */
export function layout(m: Manifest): { segments: Segment[]; total: number } {
  const segments: Segment[] = []
  let at = 0
  const push = (s: Omit<Segment, "from">) => {
    segments.push({ ...s, from: at })
    at += s.frames
  }
  push({ kind: "intro", frames: INTRO })
  push({ kind: "outline", frames: outlineFrames(m) })
  let sectionNumber = 0
  m.steps.forEach((step, index) => {
    if (step.section) {
      sectionNumber += 1
      push({ kind: "section", frames: SECTION, title: step.section, sectionNumber })
    }
    push({ kind: "step", frames: stepFrames(step), step, index })
  })
  push({ kind: "outro", frames: OUTRO })
  return { segments, total: at }
}
