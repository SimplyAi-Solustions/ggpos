/**
 * Bookings at the counter (`/counter/bookings`; docs/api-contract-launch.md,
 * section 4, "Web (BW)"): tables, PC and console stations, the party room
 * and events, for Richard's "easy to use, easy to navigate around".
 *
 * Three tabs. The day: the stations strip, then the day view with a block
 * per booking; tap a free slot to book it, tap a booking to check it in or
 * out, move it, cancel it or take payment, drag a booking to move it. The
 * week: seven days of who is coming. Events: the league nights and
 * tournaments, their entries, waitlist and check-in.
 *
 * Taking payment puts the booking on the till's ticket and opens the till,
 * where it is paid like anything else. The day and the tab are in the
 * address, so coming back from the till lands where it left.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { addDays, type ResourceKind } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCounterDock } from "@/app/counter-dock"
import { OverrideCancelled } from "@/features/lock/override"
import { BookSheet, type BookSheetStart } from "@/features/bookings/BookSheet"
import { BookingSheet, type PaymentRequest } from "@/features/bookings/BookingSheet"
import { DayView, type MoveTarget } from "@/features/bookings/DayView"
import { EventSheet } from "@/features/bookings/EventSheet"
import { EventsView } from "@/features/bookings/EventsView"
import { NewEventSheet } from "@/features/bookings/NewEventSheet"
import { StationsStrip } from "@/features/bookings/Stations"
import { WeekView } from "@/features/bookings/WeekView"
import {
  dateOf,
  dayLabel,
  kindLabel,
  lineTitle,
  relativeDay,
  shopToday,
  timeRange,
  weekOf,
  whatOf,
} from "@/features/bookings/model"
import { attachBookingCustomer, bookingLine, putOnTicket } from "@/features/bookings/till-line"
import { useNow } from "@/features/bookings/use-now"
import {
  getAvailability,
  listBookings,
  listEvents,
  listResources,
  listStations,
  moveBooking,
  type Booking,
  type BookingCheckedOut,
  type EventView,
} from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

export type BookingsView = "day" | "week" | "events"

const KIND_ORDER: ResourceKind[] = ["table", "pc", "console", "room"]

function useInvalidateBookings() {
  const queryClient = useQueryClient()
  return React.useCallback(() => {
    for (const key of [
      ["bookings"],
      ["bookings-availability"],
      ["booking-stations"],
      ["booking-events"],
      ["booking-entries"],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }, [queryClient])
}

export function BookingsScreen({
  date: asked,
  view,
  onNavigate,
}: {
  /** A shop-time date, or undefined for today. */
  date?: string
  view: BookingsView
  onNavigate: (next: { date?: string; view?: BookingsView }) => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const invalidate = useInvalidateBookings()
  const dock = useCounterDock()
  const now = useNow(30_000)
  const today = shopToday(new Date(now))
  const date = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today

  const [kind, setKind] = React.useState<ResourceKind | "all">("all")
  const [notice, setNotice] = React.useState<{ text: string; problem: boolean } | null>(null)
  const [booking, setBooking] = React.useState<Booking | null>(null)
  const [bookStart, setBookStart] = React.useState<BookSheetStart | null>(null)
  const [bookOpen, setBookOpen] = React.useState(false)
  const [event, setEvent] = React.useState<EventView | null>(null)
  const [newEventOpen, setNewEventOpen] = React.useState(false)

  // ---- Reads: shop days, as BK's list routes take them ---------------------
  const week = weekOf(date)
  const from = view === "week" ? (week[0] ?? date) : date
  const to = view === "week" ? (week[6] ?? date) : date

  // The till, My Vault and the website change bookings too (a payment, an
  // online booking), so coming back to this screen always reads them again.
  const resources = useQuery({ queryKey: ["booking-resources"], queryFn: listResources, staleTime: 60_000 })
  const availability = useQuery({
    queryKey: ["bookings-availability", date, ""],
    queryFn: () => getAvailability(date),
    staleTime: 15_000,
    refetchOnMount: "always",
  })
  const bookings = useQuery({
    queryKey: ["bookings", from, to],
    queryFn: () => listBookings(from, to),
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnMount: "always",
  })
  const stations = useQuery({
    queryKey: ["booking-stations"],
    queryFn: listStations,
    enabled: view === "day" && date === today,
    staleTime: 10_000,
    refetchInterval: 60_000,
    refetchOnMount: "always",
  })
  const events = useQuery({
    queryKey: ["booking-events", view === "events" ? today : from, view === "events" ? "" : to],
    queryFn: () => (view === "events" ? listEvents(today) : listEvents(from, to)),
    staleTime: 30_000,
    refetchOnMount: "always",
  })

  const resourceRefs = React.useMemo(
    () => (resources.data ?? []).map((row) => ({ id: row.id, name: row.name, kind: row.kind })),
    [resources.data]
  )
  const shownBookings = React.useMemo(
    () => (bookings.data ?? []).filter((row) => row.status !== "cancelled"),
    [bookings.data]
  )
  const kinds = KIND_ORDER.filter((value) =>
    (availability.data?.resources ?? []).some((row) => row.resource.kind === value)
  )
  const shown = availability.data
    ? {
        ...availability.data,
        resources: availability.data.resources.filter((row) => kind === "all" || row.resource.kind === kind),
      }
    : undefined

  // ---- Paying at the till ------------------------------------------------
  const takePayment = React.useCallback(
    (target: Booking, payment: PaymentRequest) => {
      const line = bookingLine({
        bookingId: target.id,
        title: lineTitle(target, whatOf(target), payment.key),
        amount: payment.amount,
      })
      const problem = putOnTicket(line)
      setBooking(null)
      setEvent(null)
      if (problem) {
        setNotice({ text: problem, problem: true })
        return
      }
      void attachBookingCustomer(target.customer?.code).finally(() => {
        void navigate({ to: "/counter/till" })
      })
    },
    [navigate, setBooking, setEvent, setNotice]
  )

  // ---- Moving by drag, shown where it lands before the server answers ------
  const move = useMutation({
    mutationFn: ({ target, to: place }: { target: Booking; to: MoveTarget }) =>
      moveBooking(target.id, { starts_at: place.starts_at, ends_at: place.ends_at, resource: place.resourceId }),
    onMutate: async ({ target, to: place }) => {
      const key = ["bookings", from, to]
      await queryClient.cancelQueries({ queryKey: key })
      const before = queryClient.getQueryData<Booking[]>(key)
      const onto = resourceRefs.find((row) => row.id === place.resourceId) ?? target.resource
      queryClient.setQueryData<Booking[]>(key, (rows) =>
        (rows ?? []).map((row) =>
          row.id === target.id
            ? { ...row, resource: onto, starts_at: place.starts_at, ends_at: place.ends_at }
            : row
        )
      )
      return { key, before }
    },
    onSuccess: (moved) =>
      setNotice({
        text: `${moved.name} moved to ${moved.resource?.name ?? "the new place"}, ${timeRange(moved)}.`,
        problem: false,
      }),
    onError: (error, _input, context) => {
      if (context?.before) queryClient.setQueryData(context.key, context.before)
      setNotice({
        text:
          error instanceof OverrideCancelled
            ? "The booking stayed where it was. A manager needs to approve the move."
            : refusalOrFallback(error, "That booking could not be moved. Try again."),
        problem: true,
      })
    },
    onSettled: () => invalidate(),
  })

  // ---- Changes from the sheets -------------------------------------------
  const changed = React.useCallback(
    (message: string) => {
      setNotice({ text: message, problem: false })
      invalidate()
    },
    [invalidate, setNotice]
  )

  /** A station stopped: its balance goes on the till's ticket. */
  const sessionStopped = (stopped: BookingCheckedOut) => {
    invalidate()
    if (stopped.charge.balance <= 0) {
      setNotice({ text: `${whatOf(stopped)} is free. Nothing is left to pay.`, problem: false })
      return
    }
    takePayment(stopped, { key: "session", amount: stopped.charge.balance })
  }

  // ---- The screen ----------------------------------------------------------
  const go = (next: { date?: string; view?: BookingsView }) => {
    setNotice(null)
    onNavigate(next)
  }
  const step = view === "week" ? 7 : 1

  const primary =
    view === "events" ? (
      <Button trailingArrow onClick={() => setNewEventOpen(true)} data-testid="new-event">
        New event
      </Button>
    ) : (
      <Button
        trailingArrow
        data-testid="new-booking"
        onClick={() => {
          setBookStart(null)
          setBookOpen(true)
        }}
        disabled={!availability.data}
      >
        New booking
      </Button>
    )

  return (
    <section className="pt-16 sm:pt-24" data-testid="bookings">
      <PageTitle>Bookings</PageTitle>
      <Lede>Tables, PCs, the party room and events, by the day.</Lede>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
        <Tabs value={view} onValueChange={(next) => go({ view: next as BookingsView })}>
          <TabsList>
            <TabsTrigger value="day" className="min-h-12">
              Day
            </TabsTrigger>
            <TabsTrigger value="week" className="min-h-12">
              Week
            </TabsTrigger>
            <TabsTrigger value="events" className="min-h-12">
              Events
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="hidden min-[900px]:block">{primary}</div>
      </div>

      {view !== "events" ? (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <Button
              variant="ghost-icon"
              className="size-12"
              aria-label={view === "week" ? "The week before" : "The day before"}
              onClick={() => go({ date: addDays(date, -step) })}
            >
              <ChevronLeftIcon />
            </Button>
            <h2
              className="min-w-[9.5rem] text-center text-[18px] leading-tight font-medium text-foreground"
              data-testid="bookings-date"
            >
              {view === "week"
                ? `${dayLabel(week[0] ?? date)} to ${dayLabel(week[6] ?? date)}`
                : date === today
                  ? `Today, ${dayLabel(date)}`
                  : relativeDay(date, today) === dayLabel(date)
                    ? dayLabel(date)
                    : `${relativeDay(date, today)}, ${dayLabel(date)}`}
            </h2>
            <Button
              variant="ghost-icon"
              className="size-12"
              aria-label={view === "week" ? "The week after" : "The day after"}
              onClick={() => go({ date: addDays(date, step) })}
            >
              <ChevronRightIcon />
            </Button>
            {date !== today ? (
              <Button variant="text" className="ml-2 min-h-12" onClick={() => go({ date: today })}>
                Today
              </Button>
            ) : null}
            <Input
              type="date"
              aria-label="Go to a date"
              containerClassName="ml-4 w-40 max-sm:hidden"
              value={date}
              onChange={(change) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(change.target.value)) go({ date: change.target.value })
              }}
            />
          </div>
          {view === "day" && kinds.length > 1 ? (
            <ChipGroup
              aria-label="Show"
              value={[kind]}
              onValueChange={(next: string[]) => setKind((next[0] as ResourceKind | "all") ?? "all")}
            >
              <Chip value="all">Everything</Chip>
              {kinds.map((value) => (
                <Chip key={value} value={value}>
                  {kindLabel(value)}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
        </div>
      ) : null}

      <p
        aria-live="polite"
        data-testid="bookings-notice"
        className={
          notice?.problem
            ? "mt-3 min-h-5 max-w-[64ch] text-[13px] leading-[1.45] text-destructive"
            : "mt-3 min-h-5 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground"
        }
      >
        {notice?.text ?? ""}
      </p>

      {view === "day" ? (
        <div className="mt-3 flex flex-col gap-8">
          {date === today && (stations.data?.length ?? 0) > 0 ? (
            <StationsStrip
              stations={stations.data ?? []}
              onStarted={(started) => {
                invalidate()
                setNotice({
                  text: `${whatOf(started)} is on the clock for ${started.name}.`,
                  problem: false,
                })
              }}
              onStopped={sessionStopped}
            />
          ) : null}

          <div className="flex flex-col">
            {availability.isError ? (
              <p className="text-[15px] text-destructive">
                {refusalOrFallback(availability.error, "The day would not load. Check the connection and try again.")}
              </p>
            ) : !shown || bookings.isPending ? (
              <Skeleton className="h-[480px] rounded-[var(--radius)]" />
            ) : (
              <DayView
                availability={shown}
                bookings={shownBookings}
                events={events.data ?? []}
                now={now}
                onBook={(resourceId, startsAt) => {
                  setBookStart({ resourceId, startsAt })
                  setBookOpen(true)
                }}
                onOpen={setBooking}
                onOpenEvent={setEvent}
                onMove={(target, to) => move.mutate({ target, to })}
              />
            )}
          </div>
        </div>
      ) : view === "week" ? (
        <div className="mt-6">
          {bookings.isPending ? (
            <Skeleton className="h-[320px] rounded-[var(--radius)]" />
          ) : (
            <WeekView
              days={week}
              today={today}
              bookings={shownBookings}
              events={events.data ?? []}
              onDay={(day) => go({ date: day, view: "day" })}
              onOpen={setBooking}
              onOpenEvent={setEvent}
            />
          )}
        </div>
      ) : (
        <div className="mt-6">
          {events.isPending ? (
            <Skeleton className="h-[240px] rounded-[var(--radius)]" />
          ) : (
            <EventsView events={events.data ?? []} onOpen={setEvent} />
          )}
        </div>
      )}

      <BookSheet
        open={bookOpen}
        onOpenChange={setBookOpen}
        date={date}
        availability={availability.data}
        start={bookStart}
        onBooked={(made) => {
          setBookOpen(false)
          invalidate()
          const day = dateOf(made.starts_at)
          setNotice({
            text: `${whatOf(made)} booked for ${made.name}, ${day === today ? "today" : dayLabel(day)}, ${timeRange(made)}.`,
            problem: false,
          })
        }}
      />
      <BookingSheet
        booking={booking}
        resources={resourceRefs}
        onOpenChange={(open) => {
          if (!open) setBooking(null)
        }}
        onChanged={changed}
        onPay={(target, payment) => takePayment(target, payment)}
      />
      <EventSheet
        event={event}
        onOpenChange={(open) => {
          if (!open) setEvent(null)
        }}
        onChanged={changed}
        onPay={takePayment}
      />
      <NewEventSheet
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        date={date}
        resources={resourceRefs}
        onCreated={(created) => {
          setNewEventOpen(false)
          invalidate()
          setNotice({
            text:
              created.status === "published"
                ? `${created.name} is published for ${dayLabel(dateOf(created.starts_at))}.`
                : `${created.name} is saved as a draft.`,
            problem: false,
          })
        }}
      />

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden [&_[data-slot=button]]:w-full">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}
