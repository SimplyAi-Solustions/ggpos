/**
 * Events and tournaments, soonest first (`GET /api/vault/events`): when,
 * what, the game and format, the places and the fees. Tap one for its
 * entries, its waitlist and check-in; "New event" is the screen's block on
 * this tab.
 */
import { shopClock } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { StickerRing } from "@/components/ui/sticker"
import { dateOf, dayLabel, feeWords, placesWords } from "@/features/bookings/model"
import type { EventView } from "@/lib/api/bookings"

const STATUS_WORDS: Record<EventView["status"], string> = {
  draft: "Draft",
  published: "Published",
  cancelled: "Cancelled",
  finished: "Finished",
}

export function EventsView({
  events,
  onOpen,
}: {
  events: readonly EventView[]
  onOpen: (event: EventView) => void
}) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-start gap-6 py-10" data-testid="events-empty">
        <StickerRing className="size-14 text-muted-foreground-2" aria-hidden="true" />
        <p className="max-w-[46ch] text-base leading-[1.5] text-muted-foreground">
          No events coming up. Set up the next league night or tournament with New event.
        </p>
      </div>
    )
  }
  return (
    <ul className="border-t border-hairline-soft" data-testid="events">
      {events.map((event) => (
        <li key={event.id} className="border-b border-hairline-soft">
          <button
            type="button"
            data-testid="event-row"
            onClick={() => onOpen(event)}
            className="flex min-h-16 w-full flex-col gap-1 py-4 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover min-[640px]:flex-row min-[640px]:items-center min-[640px]:gap-6"
          >
            <span className="tnum shrink-0 font-mono text-[13px] text-muted-foreground min-[640px]:w-40">
              {dayLabel(dateOf(event.starts_at))}, {shopClock(event.starts_at)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-medium text-foreground">{event.name}</span>
              <span className="block truncate text-[13px] text-muted-foreground-2">
                {[event.game?.name, event.format, placesWords(event).toLowerCase()].filter(Boolean).join(", ")}
                {event.waitlist > 0 ? `, ${event.waitlist} waiting` : ""}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              {event.status !== "published" ? <Badge variant="outline">{STATUS_WORDS[event.status]}</Badge> : null}
              {event.repeat_weekly || event.repeat_of ? <Badge variant="outline">Weekly</Badge> : null}
              <span className="tnum text-[15px] text-foreground">{feeWords(event)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
