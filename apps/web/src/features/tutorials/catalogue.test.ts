import { describe, expect, it } from "vitest"

import { chapterAt, findTutorial, formatClock, stepAt, TUTORIALS } from "./catalogue"
import type { Tutorial } from "./types"

const sample: Tutorial = {
  slug: "sample",
  number: 1,
  title: "Sample",
  subtitle: "A sample.",
  video: "/tutorials/01-sample.mp4?v=1",
  poster: "/tutorials/01-sample.jpg?v=1",
  duration: 60,
  chapters: [
    { title: "One", start: 10, steps: [{ caption: "a", start: 12 }, { caption: "b", start: 18 }] },
    { title: "Two", start: 30, steps: [{ caption: "c", start: 32 }] },
  ],
}

describe("formatClock", () => {
  it("writes minutes and two-digit seconds", () => {
    expect(formatClock(0)).toBe("0:00")
    expect(formatClock(8.9)).toBe("0:08")
    expect(formatClock(269)).toBe("4:29")
    expect(formatClock(3723)).toBe("1:02:03")
    expect(formatClock(-3)).toBe("0:00")
  })
})

describe("chapterAt and stepAt", () => {
  it("say nothing is playing before the first chapter", () => {
    expect(chapterAt(sample, 0)).toBe(-1)
    expect(stepAt(sample, 11)).toBe(-1)
  })

  it("follow the last chapter and step started", () => {
    expect(chapterAt(sample, 10)).toBe(0)
    expect(chapterAt(sample, 29.9)).toBe(0)
    expect(chapterAt(sample, 45)).toBe(1)
    expect(stepAt(sample, 20)).toBe(18)
    expect(stepAt(sample, 31)).toBe(18)
    expect(stepAt(sample, 59)).toBe(32)
  })
})

describe("findTutorial", () => {
  it("finds by slug and falls back to the first", () => {
    const second = { ...sample, slug: "second", number: 2 }
    expect(findTutorial("second", [sample, second])).toBe(second)
    expect(findTutorial("missing", [sample, second])).toBe(sample)
    expect(findTutorial(undefined, [sample, second])).toBe(sample)
    expect(findTutorial("sample", [])).toBeUndefined()
  })
})

describe("the published catalogue", () => {
  it("numbers the tutorials once each, in order", () => {
    expect(TUTORIALS.length).toBeGreaterThan(0)
    expect(TUTORIALS.map((t) => t.number)).toEqual(TUTORIALS.map((_, i) => i + 1))
    expect(new Set(TUTORIALS.map((t) => t.slug)).size).toBe(TUTORIALS.length)
  })

  it("times every chapter and step inside its video, in order", () => {
    for (const tutorial of TUTORIALS) {
      const times = tutorial.chapters.flatMap((c) => [c.start, ...c.steps.map((s) => s.start)])
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(times.every((t) => t >= 0 && t < tutorial.duration)).toBe(true)
      expect(tutorial.chapters.every((c) => c.steps.length > 0)).toBe(true)
    }
  })

  // e2e/tutorials.spec.ts asks the built app for every one of these files.
  it("addresses every video and poster under /tutorials/ with a version", () => {
    for (const tutorial of TUTORIALS) {
      expect(tutorial.video).toMatch(/^\/tutorials\/[\w-]+\.mp4\?v=[0-9a-f]{12}$/)
      expect(tutorial.poster).toMatch(/^\/tutorials\/[\w-]+\.jpg\?v=[0-9a-f]{12}$/)
    }
  })
})
