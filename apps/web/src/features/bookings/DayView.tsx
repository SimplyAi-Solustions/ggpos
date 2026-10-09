/**
 * The day view (docs/api-contract-launch.md, section 4, "Web (BW)"): the
 * resources as columns, the shop's hours down the side, and every booking
 * and event as a block in its column with the name, the party and whether
 * it is paid, in words.
 *
 * Touch first. A free slot is a target in its own right: tap it to book.
 * Tap a block to open it. Press and drag a block to move it, to another
 * time or another column (the server refuses a move that does not fit),
 * on the tablet and the Mac alike; the booking sheet's Move does the same
 * for anybody who would rather not drag. The grid scrolls inside itself, both ways, with the
 * names and the hours held in place, so the page never scrolls sideways.
 */
import * as React from "react"
import { PlusIcon } from "lucide-react"
import { cn } from "cn"
import { liveWindow, overlaps, shopClock, type Availability, type Slot } from "@gg/shared"

import { Hint, MicroLabel } from "@/components/ui/micro-label"
import {
  HOUR_PX,
  blockBox,
  dropTarget,
  frameFor,
  frameHeight,
  hourMarks,
  isDrag,
  laneLayout,
  nowTop,
  type DropTarget,
  type Frame,
} from "@/features/bookings/layout"
import {
  capacityWords,
  isLive,
  isWalkIn,
  paidState,
  partyWords,
  statusWord,
  timeRange,
} from "@/features/bookings/model"
import type { Booking, EventView } from "@/lib/api/bookings"

type Column = Availability["resources"][number]

type Block =
  | { type: "booking"; starts_at: string; ends_at: string; booking: Booking }
  | { type: "event"; starts_at: string; ends_at: string; event: EventView }

export interface MoveTarget {
  resourceId: string
  starts_at: string
  ends_at: string
}

const TIME_COLUMN_PX = 56
const COLUMN_MIN_PX = 132

/** A live booking on a resource that can be picked up and dropped elsewhere. */
function movable(booking: Booking): boolean {
  return booking.kind === "resource" && (booking.status === "held" || booking.status === "confirmed")
}

/**
 * A column's blocks: its bookings (a session still running reaching to the
 * end of the slot it is in, as the server counts it, through the shared
 * `liveWindow`) and the published events that take it.
 */
function blocksFor(column: Column, bookings: readonly Booking[], events: readonly EventView[], now: number): Block[] {
  const id = column.resource.id
  return [
    ...bookings
      .filter((row) => row.kind === "resource" && row.resource?.id === id && row.status !== "cancelled")
      .map((booking): Block => {
        const live =
          booking.status === "checked_in" && !booking.checked_out_at
            ? liveWindow(booking, column.resource.slot_minutes, new Date(now))
            : null
        return {
          type: "booking",
          starts_at: live?.starts_at ?? booking.starts_at,
          ends_at: live?.ends_at ?? booking.ends_at,
          booking,
        }
      }),
    ...events
      .filter((event) => event.status === "published" && event.resources.some((res) => res.id === id))
      .map((event): Block => ({ type: "event", starts_at: event.starts_at, ends_at: event.ends_at, event })),
  ]
}

/** A slot nothing live sits on. */
function openSlot(slot: Slot, blocks: readonly Block[]): boolean {
  return !blocks.some((block) => {
    if (block.type === "booking" && !isLive(block.booking)) return false
    return overlaps(slot, block)
  })
}

export function DayView({
  availability,
  bookings,
  events,
  now,
  onBook,
  onOpen,
  onOpenEvent,
  onMove,
}: {
  availability: Availability
  bookings: readonly Booking[]
  events: readonly EventView[]
  now: number
  onBook: (resourceId: string, startsAt: string) => void
  onOpen: (booking: Booking) => void
  onOpenEvent: (event: EventView) => void
  onMove: (booking: Booking, target: MoveTarget) => void
}) {
  const columns = availability.resources
  const frame = frameFor(availability)
  const columnRefs = React.useRef<(HTMLDivElement | null)[]>([])
  const pointer = React.useRef<{
    id: string
    x: number
    y: number
    column: number
    width: number
    dragging: boolean
  } | null>(null)
  const latest = React.useRef<DropTarget | null>(null)
  const suppressClick = React.useRef(false)
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number; target: DropTarget } | null>(
    null
  )

  if (!frame || columns.length === 0) {
    return (
      <p data-testid="day-closed" className="py-10 text-[15px] leading-[1.5] text-muted-foreground">
        Nothing can be booked on this day: the shop is closed, or every table and station is switched off.
      </p>
    )
  }

  const height = frameHeight(frame)
  const marks = hourMarks(frame)
  const nowAt = nowTop(frame, now)

  function pickUp(event: React.PointerEvent<HTMLButtonElement>, booking: Booking, column: number) {
    if (event.button !== 0 || !movable(booking)) return
    const width = columnRefs.current[column]?.getBoundingClientRect().width ?? COLUMN_MIN_PX
    pointer.current = { id: booking.id, x: event.clientX, y: event.clientY, column, width, dragging: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function carry(event: React.PointerEvent<HTMLButtonElement>, booking: Booking, frameNow: Frame) {
    const held = pointer.current
    if (!held || held.id !== booking.id) return
    const dx = event.clientX - held.x
    const dy = event.clientY - held.y
    if (!held.dragging && !isDrag(dx, dy)) return
    held.dragging = true
    const target = dropTarget({
      startMs: Date.parse(booking.starts_at),
      endMs: Date.parse(booking.ends_at),
      columnIndex: held.column,
      columnCount: columns.length,
      columnWidth: held.width,
      dx,
      dy,
      stepMinutes: columns[held.column]?.resource.slot_minutes ?? 60,
      frame: frameNow,
    })
    latest.current = target
    setDrag({ id: booking.id, dx, dy, target })
  }

  function drop(booking: Booking) {
    const held = pointer.current
    pointer.current = null
    const target = latest.current
    latest.current = null
    setDrag(null)
    if (!held?.dragging) return
    suppressClick.current = true
    if (!target || target.same) return
    const column = columns[target.columnIndex]
    if (!column) return
    onMove(booking, {
      resourceId: column.resource.id,
      starts_at: new Date(target.startMs).toISOString(),
      ends_at: new Date(target.endMs).toISOString(),
    })
  }

  function letGo() {
    pointer.current = null
    latest.current = null
    setDrag(null)
  }

  return (
    <div
      data-testid="day-grid"
      className="relative max-h-[min(72svh,900px)] overflow-auto overscroll-contain border-t border-hairline-soft"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${TIME_COLUMN_PX}px repeat(${columns.length}, minmax(${COLUMN_MIN_PX}px, 1fr))`,
          minWidth: TIME_COLUMN_PX + columns.length * COLUMN_MIN_PX,
        }}
      >
        {/* ---- The names along the top, held while the grid scrolls ---- */}
        <div className="sticky top-0 left-0 z-30 border-b border-hairline-soft bg-background" />
        {columns.map((column) => (
          <div
            key={column.resource.id}
            className="sticky top-0 z-20 flex min-w-0 flex-col gap-1 border-b border-hairline-soft bg-background px-2 pt-3 pb-2"
          >
            <MicroLabel tone="ink" className="truncate">
              {column.resource.name}
            </MicroLabel>
            <Hint className="truncate">{capacityWords(column.resource.capacity)}</Hint>
          </div>
        ))}

        {/* ---- The hours down the side ---- */}
        <div className="sticky left-0 z-10 bg-background" style={{ height }} aria-hidden="true">
          {marks.map((mark) => (
            <span
              key={mark.at}
              className="tnum absolute right-2 -translate-y-1/2 font-mono text-[13px] leading-none text-muted-foreground-2 first:translate-y-1"
              style={{ top: mark.top }}
            >
              {mark.label}
            </span>
          ))}
        </div>

        {/* ---- One column per resource ---- */}
        {columns.map((column, columnIndex) => {
          const blocks = blocksFor(column, bookings, events, now)
          const placed = laneLayout(blocks)
          const ghost = drag?.target.columnIndex === columnIndex ? drag : null
          const ghostBooking = ghost ? bookings.find((row) => row.id === ghost.id) : undefined
          return (
            <div
              key={column.resource.id}
              ref={(node) => {
                columnRefs.current[columnIndex] = node
              }}
              className="relative border-l border-hairline-faint"
              style={{ height }}
              data-testid="day-column"
              data-resource={column.resource.name}
            >
              {marks.map((mark) => (
                <span
                  key={mark.at}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 border-t border-hairline-faint"
                  style={{ top: mark.top }}
                />
              ))}

              {column.slots.map((slot) => {
                if (!openSlot(slot, blocks)) return null
                const box = blockBox(slot, frame)
                if (!box) return null
                const time = shopClock(slot.starts_at)
                return (
                  <button
                    key={slot.starts_at}
                    type="button"
                    data-testid="day-slot"
                    data-time={time}
                    aria-label={`Book ${column.resource.name} at ${time}`}
                    onClick={() => onBook(column.resource.id, slot.starts_at)}
                    className="group/slot absolute inset-x-1 flex items-center justify-center rounded-[var(--radius)] outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                    style={{ top: box.top + 1, height: box.height - 2 }}
                  >
                    <PlusIcon
                      aria-hidden="true"
                      className="size-5 stroke-[1.25] text-muted-foreground-2 opacity-0 transition-opacity duration-150 ease-gg group-hover/slot:opacity-100 group-focus-visible/slot:opacity-100"
                    />
                  </button>
                )
              })}

              {placed.map(({ item, lane, lanes }) => {
                const box = blockBox(item, frame)
                if (!box) return null
                const position: React.CSSProperties = {
                  top: box.top + 1,
                  height: Math.max(28, box.height - 2),
                  left: `calc(${(lane / lanes) * 100}% + 3px)`,
                  width: `calc(${100 / lanes}% - 6px)`,
                }
                if (item.type === "event") {
                  const event = item.event
                  return (
                    <button
                      key={`event-${event.id}`}
                      type="button"
                      data-testid="day-event"
                      onClick={() => onOpenEvent(event)}
                      aria-label={`${event.name}, ${timeRange(event)}, event`}
                      className="absolute flex flex-col items-start gap-0.5 overflow-hidden rounded-[var(--radius)] border border-hairline-soft bg-secondary px-2 py-1.5 text-left outline-none transition-colors duration-150 ease-gg hover:border-hairline focus-visible:border-foreground"
                      style={position}
                    >
                      <MicroLabel tone="ink" className="truncate">
                        Event
                      </MicroLabel>
                      <span className="w-full truncate text-[14px] leading-tight font-medium text-foreground">
                        {event.name}
                      </span>
                    </button>
                  )
                }
                const booking = item.booking
                const dragging = drag?.id === booking.id
                const inUse = booking.status === "checked_in"
                const closed = !isLive(booking)
                return (
                  <button
                    key={booking.id}
                    type="button"
                    data-testid="day-block"
                    data-booking={booking.id}
                    data-status={booking.status}
                    aria-label={`${booking.name}, ${column.resource.name}, ${timeRange(booking)}, ${statusWord(booking.status)}, ${paidState(booking)}`}
                    onPointerDown={(event) => pickUp(event, booking, columnIndex)}
                    onPointerMove={(event) => carry(event, booking, frame)}
                    onPointerUp={() => drop(booking)}
                    onPointerCancel={letGo}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false
                        return
                      }
                      onOpen(booking)
                    }}
                    className={cn(
                      "absolute flex flex-col items-start gap-0.5 overflow-hidden rounded-[var(--radius)] border px-2 py-1.5 text-left outline-none select-none",
                      "transition-[border-color,background-color] duration-150 ease-gg focus-visible:border-foreground",
                      movable(booking) && "cursor-grab touch-none active:cursor-grabbing",
                      inUse
                        ? "border-primary bg-primary text-primary-foreground"
                        : booking.status === "held"
                          ? "border-dashed border-hairline bg-background text-foreground hover:border-foreground"
                          : closed
                            ? "border-hairline-soft bg-background text-muted-foreground-2"
                            : "border-hairline bg-background text-foreground hover:border-foreground",
                      dragging && "z-20 border-foreground"
                    )}
                    style={{
                      ...position,
                      ...(dragging && drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : {}),
                    }}
                  >
                    <span className={cn("w-full truncate text-[14px] leading-tight font-medium", booking.status === "no_show" && "line-through")}>
                      {booking.name || "No name"}
                    </span>
                    {box.height >= 40 ? (
                      <span className="w-full truncate text-[13px] leading-tight">
                        {isWalkIn(booking) ? "Walk-in, on the clock" : partyWords(booking.party_size)}
                      </span>
                    ) : null}
                    {box.height >= 60 ? (
                      <span className="tnum w-full truncate text-[13px] leading-tight">
                        {booking.status === "held" || closed || inUse
                          ? statusWord(booking.status)
                          : paidState(booking)}
                      </span>
                    ) : null}
                    {box.height >= 100 && (booking.status === "held" || inUse) && !isWalkIn(booking) ? (
                      <span className="tnum w-full truncate text-[13px] leading-tight">{paidState(booking)}</span>
                    ) : null}
                  </button>
                )
              })}

              {ghost && ghostBooking ? (
                <span
                  aria-hidden="true"
                  data-testid="day-drop"
                  className="pointer-events-none absolute inset-x-1 rounded-[var(--radius)] border border-dashed border-foreground"
                  style={{
                    top: ((ghost.target.startMs - frame.start) / 60_000) * (HOUR_PX / 60),
                    height: ((ghost.target.endMs - ghost.target.startMs) / 60_000) * (HOUR_PX / 60),
                  }}
                />
              ) : null}

              {nowAt !== null ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10 h-px bg-foreground"
                  style={{ top: nowAt }}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
