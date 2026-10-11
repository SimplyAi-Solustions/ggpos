/** A caption from the video, and the second it comes up. */
export interface TutorialStep {
  caption: string
  start: number
}

/** A part of the video, from its chapter card, with the steps in it. */
export interface TutorialChapter {
  title: string
  start: number
  steps: TutorialStep[]
}

/**
 * One tutorial video. `video` and `poster` are addresses under /tutorials/
 * with a version taken from the file's contents; times are in seconds.
 */
export interface Tutorial {
  slug: string
  number: number
  title: string
  subtitle: string
  video: string
  poster: string
  duration: number
  chapters: TutorialChapter[]
}
