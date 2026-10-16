/**
 * Tutorials: short videos of the jobs at the counter, made from the demo shop
 * (videos/README.md). The chosen one plays at the top; its chapters jump the
 * video to that part, every step can be read and jumped to as text, and the
 * list underneath picks another. `?t=<slug>` links straight to one.
 *
 * The videos carry their own captions and no voice, so the steps list is the
 * same words the picture shows, for anybody who would rather read or skim.
 *
 * The files are in apps/web/public/tutorials, written by
 * videos/publish-to-app.mjs with the catalogue. On the shop's server they are
 * mounted beside the app rather than built into it (deploy/docker-compose.yml).
 */
import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { chapterAt, findTutorial, formatClock, stepAt, TUTORIALS } from "@/features/tutorials/catalogue"
import type { Tutorial } from "@/features/tutorials/types"

const pad = (n: number) => String(n).padStart(2, "0")

function scrollTo(element: HTMLElement | null) {
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  element?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" })
}

/** A time that moves the video when pressed, and the chapter or step it starts. */
function JumpButton({
  time,
  current,
  onJump,
  children,
  className,
}: {
  time: number
  current: boolean
  onJump: (time: number) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={() => onJump(time)}
      className={cn(
        "group flex min-h-12 w-full items-baseline gap-5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
        className
      )}
    >
      <span className="tnum w-12 shrink-0 font-mono text-[13px] text-muted-foreground-2">{formatClock(time)}</span>
      <span
        className={cn(
          "text-[15px] leading-[1.45] group-hover:text-foreground",
          current ? "font-medium text-foreground" : "text-muted-foreground"
        )}
      >
        {children}
      </span>
    </button>
  )
}

/**
 * The video, its title, its chapters and its steps. Keyed on the tutorial, so
 * choosing another starts it from the top with the steps folded away.
 */
function TutorialView({ tutorial, playWhenReadyRef }: { tutorial: Tutorial; playWhenReadyRef: React.RefObject<boolean> }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const [time, setTime] = React.useState(0)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [showSteps, setShowSteps] = React.useState(false)

  const playingChapter = chapterAt(tutorial, time)
  const playingStep = stepAt(tutorial, time)

  const jump = (to: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = to
    setTime(to)
    video.play().catch(() => undefined)
  }

  return (
    <>
      <div data-testid="tutorial-player">
        <video
          ref={videoRef}
          src={tutorial.video}
          poster={tutorial.poster}
          controls
          playsInline
          preload="metadata"
          aria-label={tutorial.title}
          className="block aspect-video w-full rounded-[var(--radius)] border border-hairline-soft bg-secondary"
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onSeeked={(event) => setTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            setProblem(null)
            if (!playWhenReadyRef.current) return
            playWhenReadyRef.current = false
            // Picked from the list, so it starts; a browser that wants its
            // own press first keeps the play button for it instead.
            event.currentTarget.play().catch(() => undefined)
          }}
          onError={(event) =>
            setProblem(
              // The file arrived and this browser cannot play it: no amount
              // of reloading fixes that, so say what does.
              event.currentTarget.error?.code === 4
                ? "This browser cannot play the video. Open GG Vault in Chrome, Edge or Safari."
                : "This video did not load. Check the connection, then reload the page."
            )
          }
        />
        {problem ? (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-2">
          <MicroLabel>
            Tutorial {pad(tutorial.number)} · {formatClock(tutorial.duration)}
          </MicroLabel>
          <h2 className="text-[20px] leading-[1.3] font-medium text-foreground">{tutorial.title}</h2>
          <p className="max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">{tutorial.subtitle}</p>
        </div>
      </div>

      <SectionHeading className="mt-16">In this video</SectionHeading>
      <ol data-testid="tutorial-chapters" className="flex flex-col">
        {tutorial.chapters.map((chapter, index) => (
          <li key={chapter.start} className="border-b border-hairline-soft first:border-t">
            <JumpButton time={chapter.start} current={index === playingChapter} onJump={jump}>
              {chapter.title}
            </JumpButton>
          </li>
        ))}
      </ol>

      <div className="mt-8">
        <Button variant="text" aria-expanded={showSteps} onClick={() => setShowSteps((open) => !open)}>
          {showSteps ? "Hide the steps" : "Show every step"}
        </Button>
      </div>
      {showSteps ? (
        <div data-testid="tutorial-steps" className="mt-8 flex flex-col gap-8">
          {tutorial.chapters.map((chapter) => (
            <div key={chapter.start}>
              <MicroLabel tone="ink">{chapter.title}</MicroLabel>
              <ol className="mt-2 flex flex-col">
                {chapter.steps.map((step) => (
                  <li key={step.start}>
                    <JumpButton time={step.start} current={step.start === playingStep} onJump={jump} className="py-2">
                      {step.caption}
                    </JumpButton>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function TutorialsScreen() {
  const navigate = useNavigate()
  const search = useSearch({ from: "/counter/tutorials" })
  const tutorial = findTutorial(search.t)
  const playerRef = React.useRef<HTMLDivElement | null>(null)
  const playWhenReadyRef = React.useRef(false)

  if (!tutorial) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Tutorials</PageTitle>
        <Lede>No tutorials are installed on this till yet.</Lede>
      </section>
    )
  }

  const choose = (next: Tutorial) => {
    if (next.slug !== tutorial.slug) {
      playWhenReadyRef.current = true
      void navigate({ to: "/counter/tutorials", search: { t: next.slug } })
    }
    scrollTo(playerRef.current)
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Tutorials</PageTitle>
      <Lede>Short videos of the jobs you do at the counter.</Lede>

      <div ref={playerRef} className="mt-10 scroll-mt-24">
        <TutorialView key={tutorial.slug} tutorial={tutorial} playWhenReadyRef={playWhenReadyRef} />
      </div>

      <SectionHeading className="mt-24">All tutorials</SectionHeading>
      <ul data-testid="tutorial-list" className="flex flex-col">
        {TUTORIALS.map((entry) => {
          const current = entry.slug === tutorial.slug
          return (
            <li key={entry.slug} className="border-b border-hairline-soft first:border-t">
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => choose(entry)}
                className="group flex w-full items-center gap-5 py-5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-8"
              >
                <img
                  src={entry.poster}
                  alt=""
                  width={1280}
                  height={720}
                  loading="lazy"
                  className="aspect-video w-28 shrink-0 rounded-[var(--radius)] border border-hairline-soft object-cover sm:w-44"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <MicroLabel tone="hint">
                    Tutorial {pad(entry.number)} · {formatClock(entry.duration)}
                  </MicroLabel>
                  <span
                    className={cn(
                      "text-[16px] leading-[1.4] text-foreground",
                      current ? "font-medium" : "group-hover:underline group-hover:underline-offset-4"
                    )}
                  >
                    {entry.title}
                  </span>
                  <span className="hidden text-[13px] leading-[1.45] text-muted-foreground-2 sm:block">
                    {entry.subtitle}
                  </span>
                </span>
                {current ? <Hint className="shrink-0 max-sm:hidden">On screen</Hint> : null}
              </button>
            </li>
          )
        })}
      </ul>

      <p className="mt-8 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        Filmed on the demo shop, so every customer, item and price in them is an example.
      </p>
    </section>
  )
}
