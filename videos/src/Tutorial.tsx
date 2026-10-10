import React from "react"
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useVideoConfig } from "remotion"

import { C } from "./brand"
import { Intro, Outline, Outro, SectionCard } from "./scenes"
import { cameraFor, FULL, pointerAfter, StepScene } from "./StepScene"
import { layout, type Manifest } from "./timing"

/** One tutorial: intro, outline, chapters of steps, outro, over the music. */
export const Tutorial: React.FC<{ manifest: Manifest }> = ({ manifest: m }) => {
  const { durationInFrames } = useVideoConfig()
  const { segments } = layout(m)

  let chapter = 0
  let afterSection = true
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <Audio
        src={staticFile("music/bed.wav")}
        loop
        volume={(f) =>
          interpolate(f, [0, 45, durationInFrames - 75, durationInFrames - 5], [0, 0.32, 0.32, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        }
      />
      {segments.map((seg, i) => {
        if (seg.kind === "intro")
          return (
            <Sequence key={i} from={seg.from} durationInFrames={seg.frames} name="Intro">
              <Intro m={m} />
            </Sequence>
          )
        if (seg.kind === "outline")
          return (
            <Sequence key={i} from={seg.from} durationInFrames={seg.frames} name="In this video">
              <Outline m={m} />
            </Sequence>
          )
        if (seg.kind === "section") {
          chapter = seg.sectionNumber ?? chapter
          afterSection = true
          return (
            <Sequence key={i} from={seg.from} durationInFrames={seg.frames} name={`Part: ${seg.title}`}>
              <SectionCard title={seg.title ?? ""} number={seg.sectionNumber ?? 0} />
            </Sequence>
          )
        }
        if (seg.kind === "step" && seg.step && seg.index !== undefined) {
          const index = seg.index
          // After a chapter card the screen comes back whole and fades in on its own.
          const prev = afterSection ? null : m.steps[index - 1] ?? null
          const startCamera = afterSection ? FULL : cameraFor(m.steps[index - 1] ?? null, m)
          const pointerFrom = pointerAfter(m.steps, index - 1, m)
          afterSection = false
          return (
            <Sequence key={i} from={seg.from} durationInFrames={seg.frames} name={`Step ${index + 1}`}>
              <StepScene m={m} step={seg.step} index={index} prev={prev} startCamera={startCamera} pointerFrom={pointerFrom} chapterNumber={chapter} />
            </Sequence>
          )
        }
        return (
          <Sequence key={i} from={seg.from} durationInFrames={seg.frames} name="Outro">
            <Outro m={m} />
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}
