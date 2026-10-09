/**
 * The week: Monday to Sunday side by side from 900px, one under another on
 * a phone. Each day lists its bookings and events in time order, a row
 * each with the time, where, who and how many; tap one to open it, tap the
 * day to go to its day view.
 */
import { cn } from "cn"
import { shopClock } from "@gg/shared"

import { MicroLabel } from "@/components/ui/micro-label"
import { dateOf, dayLabel, isLive, partyWords, statusWord } from "@/features/bookings/model"
import type { Booking, EventView } from "@/lib/api/bookings"

export function WeekView({
  days,
  today,
  bookings,
  events,
  onDay,
  onOpen,
  onOpenEvent,
}: {
  /** Monday to Sunday, shop-time dates. */
  days: string[]
  today: string
  bookings: readonly Booking[]
  events: readonly EventView[]
  onDay: (date: string) => void
  onOpen: (booking: Booking) => void
  onOpenEvent: (event: EventView) => void
}) {
  return (
    <ol
      data-testid="week"
      className="grid grid-cols-1 gap-x-3 gap-y-8 border-t border-hairline-soft pt-6 min-[900px]:grid-cols-7"
    >
      {days.map((day) => {
        // Bookings and events in one list, in time order: the day as it runs.
        const rows = [
          ...bookings
            .filter((row) => row.kind === "resource" && dateOf(row.starts_at) === day && row.status !== "cancelled")
            .map((booking) => ({ at: booking.starts_at, booking, event: null })),
          ...events
            .filter((event) => dateOf(event.starts_at) === day && event.status !== "cancelled")
            .map((event) => ({ at: event.starts_at, booking: null, event })),
        ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        const empty = rows.length === 0
        return (
          <li key={day} className="min-w-0" data-testid="week-day" data-date={day}>
            <button
              type="button"
              onClick={() => onDay(day)}
              aria-current={day === today ? "date" : undefined}
              className="group/day relative mb-3 flex w-full items-baseline justify-between gap-2 pb-1 text-left outline-none"
            >
              <span className="text-[15px] font-medium text-foreground">{dayLabel(day)}</span>
              {day === today ? <MicroLabel tone="ink">Today</MicroLabel> : null}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-0 -bottom-px h-px origin-left bg-foreground transition-transform duration-150 ease-gg",
                  "scale-x-0 group-hover/day:scale-x-100 group-focus-visible/day:scale-x-100"
                )}
              />
            </button>
            {empty ? (
              <p className="text-[13px] text-muted-foreground-2">Nothing booked.</p>
            ) : (
              <ul className="flex flex-col">
                {rows.map(({ booking, event }) =>
                  event ? (
                  <li key={event.id} className="border-b border-hairline-soft first:border-t">
                    <button
                      type="button"
                      onClick={() => onOpenEvent(event)}
                      className="flex min-h-12 w-full flex-col items-start gap-0.5 py-2 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                    >
                      <span className="tnum font-mono text-[13px] text-muted-foreground">
                        {shopClock(event.starts_at)} Event
                      </span>
                      <span className="w-full truncate text-[14px] font-medium text-foreground">{event.name}</span>
                    </button>
                  </li>
                  ) : booking ? (
                  <li key={booking.id} className="border-b border-hairline-soft first:border-t">
                    <button
                      type="button"
                      data-testid="week-booking"
                      onClick={() => onOpen(booking)}
                      className="flex min-h-12 w-full flex-col items-start gap-0.5 py-2 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                    >
                      <span className="tnum w-full truncate font-mono text-[13px] text-muted-foreground">
                        {shopClock(booking.starts_at)} {booking.resource?.name ?? ""}
                      </span>
                      <span
                        className={cn(
                          "w-full truncate text-[14px] text-foreground",
                          !isLive(booking) && "text-muted-foreground-2"
                        )}
                      >
                        {booking.name}
                      </span>
                      <span className="w-full truncate text-[13px] text-muted-foreground-2">
                        {partyWords(booking.party_size)}
                        {booking.status === "confirmed" ? "" : `, ${statusWord(booking.status).toLowerCase()}`}
                      </span>
                    </button>
                  </li>
                  ) : null
                )}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}
