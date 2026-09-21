import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { useReducedMotionGuard } from "@/design/motion"
import type { QuotePhoto } from "@/lib/api/types"

/**
 * The photos a customer sent, one at a time.
 *
 * A scroll-snap track rather than a carousel library: a swipe is the
 * browser's own scroll, which is why it feels right on a phone, and the
 * image keeps `pan-x pinch-zoom` so two fingers still zoom it while one
 * finger moves between photos. The arrows and the thumbnails are the same
 * movement for a counter PC with a mouse.
 *
 * There is no lightbox. DESIGN.md has no dark surfaces in it at all: the
 * photo sits on the paper canvas inside a hairline, large at 1440 and full
 * width on a phone, and the page around it stays readable.
 */
export function PhotoViewer({ photos }: { photos: QuotePhoto[] }) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [index, setIndex] = React.useState(0)
  const still = useReducedMotionGuard()

  const count = photos.length

  const go = React.useCallback(
    (next: number) => {
      const track = trackRef.current
      if (!track || count === 0) return
      const clamped = Math.max(0, Math.min(count - 1, next))
      track.scrollTo({
        left: clamped * track.clientWidth,
        behavior: still ? "auto" : "smooth",
      })
      setIndex(clamped)
    },
    [count, still]
  )

  // The index follows the scroll rather than the other way about, so a
  // swipe, an arrow and a thumbnail all end up saying the same thing.
  function onScroll() {
    const track = trackRef.current
    if (!track || track.clientWidth === 0) return
    const next = Math.round(track.scrollLeft / track.clientWidth)
    setIndex(Math.max(0, Math.min(count - 1, next)))
  }

  if (count === 0) {
    return (
      <p className="text-[15px] leading-[1.5] text-muted-foreground-2">
        No photos came with this quote. Ask for one in the thread below.
      </p>
    )
  }

  return (
    <div data-testid="quote-photos">
      <div
        ref={trackRef}
        role="group"
        tabIndex={0}
        aria-label={`Photos, ${count} in all`}
        onScroll={onScroll}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault()
            go(index + 1)
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            go(index - 1)
          }
        }}
        // The track takes focus so the arrow keys work, so it has to show
        // it: the house ring, 2px volt at 2px offset.
        className="flex snap-x snap-mandatory overflow-x-auto outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {photos.map((photo, at) => (
          <div
            key={photo.name}
            className="flex w-full shrink-0 snap-center items-center justify-center"
          >
            <img
              src={photo.url}
              alt={`Photo ${at + 1} of ${count} from this quote`}
              // A set height rather than a maximum, so a photo of any size
              // fills the same frame and the page does not jump between one
              // photo and the next. Two fingers zoom, one finger moves on.
              className="h-[280px] w-auto max-w-full border border-hairline-soft bg-background object-contain touch-[pan-x_pinch-zoom] sm:h-[380px] min-[900px]:h-[460px]"
              loading={at === 0 ? "eager" : "lazy"}
            />
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between gap-6">
        <MicroLabel aria-live="polite">
          Photo {index + 1} of {count}
        </MicroLabel>
        {count > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost-icon"
              type="button"
              aria-label="Previous photo"
              disabled={index === 0}
              onClick={() => go(index - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              variant="ghost-icon"
              type="button"
              aria-label="Next photo"
              disabled={index === count - 1}
              onClick={() => go(index + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
      </div>

      {count > 1 ? (
        <ul className="mt-5 flex flex-wrap gap-3">
          {photos.map((photo, at) => (
            <li key={photo.name}>
              <button
                type="button"
                onClick={() => go(at)}
                aria-current={at === index ? "true" : undefined}
                aria-label={`Show photo ${at + 1}`}
                className="block size-14 border border-hairline-soft p-0.5 outline-none transition-colors duration-150 ease-gg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt aria-[current]:border-foreground"
              >
                <img
                  src={photo.url}
                  alt=""
                  loading="lazy"
                  className="size-full object-contain"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
