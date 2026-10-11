/**
 * The tutorial videos and the small sums the Tutorials page does with them.
 * The list itself is catalogue.gen.ts, written by videos/publish-to-app.mjs.
 */
import { TUTORIALS } from "./catalogue.gen"
import type { Tutorial } from "./types"

export { TUTORIALS }

/** The tutorial a link names, or the first one when it names none we have. */
export function findTutorial(slug: string | undefined, list: Tutorial[] = TUTORIALS): Tutorial | undefined {
  return list.find((t) => t.slug === slug) ?? list[0]
}

/** Which chapter is playing at `time`: the last one started, -1 before the first. */
export function chapterAt(tutorial: Tutorial, time: number): number {
  let current = -1
  tutorial.chapters.forEach((chapter, index) => {
    if (time >= chapter.start) current = index
  })
  return current
}

/** The start of the step on screen at `time`, -1 before the first. */
export function stepAt(tutorial: Tutorial, time: number): number {
  let current = -1
  for (const chapter of tutorial.chapters) {
    for (const step of chapter.steps) {
      if (time >= step.start) current = step.start
    }
  }
  return current
}

/** A time as the player shows it: 0:08, 4:29, 1:02:03. */
export function formatClock(time: number): string {
  const whole = Math.max(0, Math.floor(time))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = String(whole % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`
}
