/**
 * Book, in My Vault (docs/api-contract-launch.md, section 4, "Web (BW)"):
 * a table or a PC by the slot, or a place at an event, for the customer
 * themselves. Pick a day, see what is free, tap a time; members see the
 * Guild price. Nothing is paid here (decision 12): the booking is held and
 * paid at the till, and the screen says so wherever a price is shown.
 *
 * Their own bookings are under it, with Cancel until they start.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MinusIcon, PlusIcon } from "lucide-react"
import {
  addDays,
  bookingPrice,
  entryFee,
  formatGBP,
  shopClock,
  type Availability,
  type ResourceKind,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { FieldError } from "@/components/ui/field"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerRing } from "@/components/ui/sticker"
import { useNow } from "@/features/bookings/use-now"
import { usePortalDock } from "@/features/portal/dock"
import { Note } from "@/features/portal/Note"
import {
  dateOf,
  dayLabel,
  isOpen,
  kindLabel,
  lengthChoices,
  lengthWords,
  partyWords,
  rateWords,
  relativeDay,
  shopToday,
  statusWord,
  timeRange,
  whatOf,
} from "@/features/bookings/model"
import {
  bookOnline,
  cancelMyBooking,
  getPublicAvailability,
  listMyBookings,
  listPublicEvents,
  memberFromMe,
  type Booking,
  type EventView,
} from "@/lib/api/bookings"
import { getMe } from "@/lib/api/portal"
import { refusalOrFallback } from "@/lib/api/refusal"

type What = ResourceKind | "events"

type Choice =
  | { type: "slot"; resourceId: string; startsAt: string }
  | { type: "event"; event: EventView }

const DAYS_AHEAD = 14
const KIND_ORDER: ResourceKind[] = ["table", "pc", "console", "room"]

function Stepper({
  value,
  min = 1,
  max,
  onChange,
}: {
  value: number
  min?: number
  max?: number
  onChange: (next: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost-icon"
        className="size-12"
        aria-label="One fewer player"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <MinusIcon />
      </Button>
      <span className="tnum w-24 text-center text-[16px] text-foreground" data-testid="portal-party">
        {partyWords(value)}
      </span>
      <Button
        variant="ghost-icon"
        className="size-12"
        aria-label="One more player"
        disabled={max !== undefined && value >= max}
        onClick={() => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1)}
      >
        <PlusIcon />
      </Button>
    </div>
  )
}

export function BookScreen() {
  const dock = usePortalDock()
  const queryClient = useQueryClient()
  const now = useNow(60_000)
  const today = shopToday(new Date(now))
  const [date, setDate] = React.useState(today)
  const [what, setWhat] = React.useState<What>("table")
  const [party, setParty] = React.useState(2)
  const [choice, setChoice] = React.useState<Choice | null>(null)
  const [slots, setSlots] = React.useState(1)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  const me = useQuery({ queryKey: ["portal", "me"], queryFn: getMe })
  const kindFilter = what === "events" ? undefined : what

  // Every kind there is to book, for the chips; then the chosen one's slots.
  const everything = useQuery({
    queryKey: ["portal", "availability", date, "all"],
    queryFn: () => getPublicAvailability(date),
    staleTime: 15_000,
  })
  const kinds = KIND_ORDER.filter((kind) =>
    (everything.data?.resources ?? []).some((row) => row.resource.kind === kind)
  )
  const partyFor = what === "table" || what === "room" ? party : 1
  const availability = useQuery({
    queryKey: ["portal", "availability", date, kindFilter ?? "", partyFor],
    queryFn: () => getPublicAvailability(date, { kind: kindFilter, party: partyFor }),
    enabled: what !== "events",
    staleTime: 15_000,
  })
  const events = useQuery({
    queryKey: ["portal", "events", today],
    queryFn: () => listPublicEvents(today),
    staleTime: 30_000,
  })
  const mine = useQuery({
    queryKey: ["portal", "bookings"],
    queryFn: listMyBookings,
    staleTime: 10_000,
    // Paid or moved at the counter since: read them again on each visit.
    refetchOnMount: "always",
  })
  // In the Guild: from their card, or from how BK priced a booking of theirs
  // (each one says whether its customer is a member).
  const member = memberFromMe(me.data) || (mine.data ?? []).some((row) => row.customer?.member === true)

  const resetChoice = () => {
    setChoice(null)
    setSlots(1)
    setProblem(null)
  }

  const chosenResource =
    choice?.type === "slot"
      ? availability.data?.resources.find((row) => row.resource.id === choice.resourceId)
      : undefined
  const runs =
    choice?.type === "slot" && chosenResource
      ? lengthChoices(
          chosenResource.slots.filter((slot) => slot.free),
          choice.startsAt
        )
      : []
  const run = runs[Math.min(slots, runs.length) - 1] ?? []
  const window =
    run.length > 0 ? { starts_at: run[0]?.starts_at ?? "", ends_at: run[run.length - 1]?.ends_at ?? "" } : null

  const quote =
    choice?.type === "slot" && chosenResource && window
      ? bookingPrice(chosenResource.resource, window, member)
      : choice?.type === "event"
        ? { price: entryFee(choice.event, member) * party, deposit: 0, slots: 0 }
        : null
  const fullQuote =
    choice?.type === "slot" && chosenResource && window
      ? bookingPrice(chosenResource.resource, window, false).price
      : choice?.type === "event"
        ? choice.event.entry_fee * party
        : 0
  const guildPrice = Boolean(quote && member && quote.price !== fullQuote)
  const waitlist =
    choice?.type === "event" && choice.event.places_left !== null && party > choice.event.places_left

  const book = useMutation({
    mutationFn: () => {
      if (choice?.type === "event") {
        // Past the places left, the entry asks to wait for one (BK refuses it otherwise).
        return bookOnline({ event: choice.event.id, party_size: party, ...(waitlist ? { waitlist: true } : {}) })
      }
      if (choice?.type === "slot" && window) {
        return bookOnline({
          resource: choice.resourceId,
          starts_at: window.starts_at,
          ends_at: window.ends_at,
          party_size: partyFor,
        })
      }
      throw new Error("Pick a time or an event first.")
    },
    onMutate: () => setProblem(null),
    onSuccess: (booking) => {
      // The same words as the confirmation BK sends them.
      const where = whatOf(booking)
      const day = dayLabel(dateOf(booking.starts_at))
      const pay = booking.price > 0 && !booking.waitlist_position ? ` Pay ${formatGBP(booking.price)} at the till when you arrive.` : ""
      setDone(
        booking.waitlist_position
          ? `You are on the waitlist for ${where} on ${day}. We will tell you if a place comes up.`
          : booking.kind === "event"
            ? `You are entered in ${where} on ${day}, from ${shopClock(booking.starts_at)}.${pay}`
            : `${where} is ${booking.status === "held" ? "held" : "booked"} for you on ${day}, ${timeRange(booking)}.${pay}`
      )
      resetChoice()
      for (const key of [["portal", "bookings"], ["portal", "availability"], ["portal", "events"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    onError: (error) => setProblem(refusalOrFallback(error, "That did not book. Try again.")),
  })

  const cancel = useMutation({
    mutationFn: (booking: Booking) => cancelMyBooking(booking.id),
    onSuccess: () => {
      setDone("Cancelled. The time is free for somebody else.")
      for (const key of [["portal", "bookings"], ["portal", "availability"], ["portal", "events"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    onError: (error) => setDone(refusalOrFallback(error, "That booking was not cancelled. Try again.")),
  })

  const label =
    choice?.type === "event" ? (waitlist ? "Join the waitlist" : "Enter") : choice ? "Book it" : "Pick a time"
  const primary = (
    <Button
      trailingArrow
      className="w-full min-[900px]:w-auto"
      data-testid="portal-book"
      disabled={!choice || (choice.type === "slot" && !window)}
      loading={book.isPending}
      onClick={() => book.mutate()}
    >
      {label}
    </Button>
  )

  const choicePanel = choice ? (
        <Revealed
          key={choice.type === "event" ? choice.event.id : `${choice.resourceId}-${choice.startsAt}`}
          className="mt-5 border-t border-hairline-soft pt-5"
          data-testid="portal-choice"
        >
          <MicroLabel tone="ink">Your choice</MicroLabel>
          <p className="mt-3 text-[16px] leading-[1.5] text-foreground">
            {choice.type === "event"
              ? `${choice.event.name}, ${dayLabel(dateOf(choice.event.starts_at))}, ${timeRange(choice.event)}`
              : `${chosenResource?.resource.name ?? ""}, ${dayLabel(date)}, ${window ? timeRange(window) : shopClock(choice.startsAt)}`}
          </p>
          {choice.type === "slot" && runs.length > 1 && chosenResource ? (
            <ChipGroup
              aria-label="How long"
              className="mt-4"
              value={[String(Math.min(slots, runs.length))]}
              onValueChange={(next: string[]) => {
                const value = Number(next[0])
                if (value > 0) setSlots(value)
              }}
            >
              {runs.map((entry) => (
                <Chip key={entry.length} value={String(entry.length)}>
                  {lengthWords(entry.length * chosenResource.resource.slot_minutes)}
                </Chip>
              ))}
            </ChipGroup>
          ) : null}
          {choice.type === "event" ? (
            <div className="mt-4">
              <Stepper
                value={party}
                onChange={(next) => {
                  setParty(next)
                  setProblem(null)
                }}
              />
            </div>
          ) : null}
          {quote ? (
            <div className="mt-5 flex flex-col gap-1">
              <span className="tnum text-[20px] font-medium text-foreground" data-testid="portal-price">
                {formatGBP(quote.price)}
              </span>
              <Note>
                {guildPrice ? `The Guild price, ${formatGBP(fullQuote)} for anybody else. ` : ""}
                Paid at the till when you arrive. Nothing is taken now.
                {quote.deposit > 0 ? ` The ${formatGBP(quote.deposit)} deposit is part of it.` : ""}
                {waitlist ? " It is full, so this puts you on the waitlist." : ""}
              </Note>
            </div>
          ) : null}
          <FieldError data-testid="portal-book-problem">{problem}</FieldError>
          <div className="mt-6 hidden min-[900px]:block">{primary}</div>
        </Revealed>
      ) : null

  const days = Array.from({ length: DAYS_AHEAD }, (_, index) => addDays(today, index))
  const upcoming = (mine.data ?? []).filter((row) => row.status !== "cancelled")

  return (
    <section className="pt-12 sm:pt-20" data-testid="portal-book-screen">
      <PageTitle>Book</PageTitle>
      <Lede>A table, a PC or a place at an event. You pay at the till when you arrive.</Lede>

      {done ? (
        <p aria-live="polite" data-testid="portal-book-done" className="mt-8 max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
          {done}
        </p>
      ) : null}

      <div className="mt-10 flex flex-col gap-3">
        <MicroLabel>What</MicroLabel>
        <ChipGroup
          aria-label="What to book"
          value={[what]}
          onValueChange={(next: string[]) => {
            if (!next[0]) return
            setWhat(next[0] as What)
            resetChoice()
          }}
        >
          {kinds.map((kind) => (
            <Chip key={kind} value={kind}>
              {kindLabel(kind)}
            </Chip>
          ))}
          <Chip value="events">Events</Chip>
        </ChipGroup>
      </div>

      {what !== "events" ? (
        <>
          <div className="mt-8 flex flex-col gap-3">
            <MicroLabel>Day</MicroLabel>
            <ChipGroup
              aria-label="Day"
              value={[date]}
              onValueChange={(next: string[]) => {
                if (!next[0]) return
                setDate(next[0])
                resetChoice()
              }}
              className="-mx-1 flex-nowrap overflow-x-auto px-1 pb-1"
            >
              {days.map((day) => (
                <Chip key={day} value={day}>
                  {relativeDay(day, today) === dayLabel(day) ? dayLabel(day) : relativeDay(day, today)}
                </Chip>
              ))}
            </ChipGroup>
          </div>

          {what === "table" || what === "room" ? (
            <div className="mt-8 flex flex-col gap-2">
              <MicroLabel>How many</MicroLabel>
              <Stepper
                value={party}
                max={20}
                onChange={(next) => {
                  setParty(next)
                  resetChoice()
                }}
              />
            </div>
          ) : null}

          <FreeSlots
            availability={availability.data}
            loading={availability.isPending}
            error={availability.isError}
            member={member}
            choice={choice}
            panel={choicePanel}
            onChoose={(resourceId, startsAt) => {
              setChoice({ type: "slot", resourceId, startsAt })
              setSlots(1)
              setProblem(null)
              setDone(null)
            }}
          />
        </>
      ) : (
        <EventList
          events={events.data}
          loading={events.isPending}
          member={member}
          choice={choice?.type === "event" ? choice.event.id : null}
          panel={choicePanel}
          onChoose={(event) => {
            setChoice({ type: "event", event })
            setParty(1)
            setProblem(null)
            setDone(null)
          }}
        />
      )}

      <SectionHeading className="mt-16">Your bookings</SectionHeading>
      {mine.isPending ? (
        <SkeletonText lines={3} />
      ) : upcoming.length === 0 ? (
        <div className="flex items-start gap-5">
          <StickerRing className="size-14" />
          <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
            Nothing booked yet. Pick a day and a time above.
          </p>
        </div>
      ) : (
        <ul className="border-t border-hairline-soft" data-testid="portal-my-bookings">
          {upcoming.map((booking) => (
            <MyBooking
              key={booking.id}
              booking={booking}
              now={now}
              cancelling={cancel.isPending && cancel.variables?.id === booking.id}
              onCancel={() => cancel.mutate(booking)}
            />
          ))}
        </ul>
      )}

      {dock && choice
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}

/**
 * The choice panel, brought into view when a time or an event is tapped, so
 * the price and the button are on screen above the phone's docked bar.
 */
function Revealed({ children, ...props }: React.ComponentProps<"div">) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node || typeof node.scrollIntoView !== "function") return
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    node.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" })
  }, [])
  return (
    <div ref={ref} style={{ scrollMarginBottom: "calc(var(--gg-portal-dock-h, 0px) + 16px)" }} {...props}>
      {children}
    </div>
  )
}

function FreeSlots({
  availability,
  loading,
  error,
  member,
  choice,
  panel,
  onChoose,
}: {
  availability: Availability | undefined
  loading: boolean
  error: boolean
  member: boolean
  choice: Choice | null
  /** What was picked, its price and the button, under the row it was picked from. */
  panel: React.ReactNode
  onChoose: (resourceId: string, startsAt: string) => void
}) {
  if (error) {
    return (
      <p className="mt-10 text-[15px] text-destructive">
        We could not see what is free just now. Check your connection and try again.
      </p>
    )
  }
  if (loading || !availability) {
    return (
      <div className="mt-10">
        <SkeletonText lines={4} />
      </div>
    )
  }
  const open = availability.resources.filter((row) => row.slots.some((slot) => slot.free))
  if (open.length === 0) {
    return (
      <p className="mt-10 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground" data-testid="portal-nothing-free">
        Nothing is free that day. Try another day, or ring the shop.
      </p>
    )
  }
  return (
    <ul className="mt-10 flex flex-col gap-8" data-testid="portal-slots">
      {open.map(({ resource, slots }) => {
        const yours = member && resource.member_price !== null ? resource.member_price : resource.price
        return (
          <li key={resource.id} data-testid="portal-resource" data-resource={resource.name}>
            <div className="flex items-baseline justify-between gap-4">
              <MicroLabel tone="ink">{resource.name}</MicroLabel>
              <span className="tnum text-[15px] text-foreground">{rateWords(yours, resource.slot_minutes)}</span>
            </div>
            {member && yours !== resource.price ? (
              <Note className="mt-1">The Guild price. {rateWords(resource.price, resource.slot_minutes)} for anybody else.</Note>
            ) : !member && resource.member_price !== null && resource.member_price !== resource.price ? (
              <Note className="mt-1">{rateWords(resource.member_price, resource.slot_minutes)} for Guild members.</Note>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Free times at ${resource.name}`}>
              {slots
                .filter((slot) => slot.free)
                .map((slot) => {
                  const chosen =
                    choice?.type === "slot" && choice.resourceId === resource.id && choice.startsAt === slot.starts_at
                  return (
                    <Chip
                      key={slot.starts_at}
                      pressed={chosen}
                      onPressedChange={() => onChoose(resource.id, slot.starts_at)}
                      className="tnum"
                      data-testid="portal-slot"
                    >
                      {shopClock(slot.starts_at)}
                    </Chip>
                  )
                })}
            </div>
            {choice?.type === "slot" && choice.resourceId === resource.id ? panel : null}
          </li>
        )
      })}
    </ul>
  )
}

function EventList({
  events,
  loading,
  member,
  choice,
  panel,
  onChoose,
}: {
  events: EventView[] | undefined
  loading: boolean
  member: boolean
  choice: string | null
  panel: React.ReactNode
  onChoose: (event: EventView) => void
}) {
  if (loading || !events) {
    return (
      <div className="mt-10">
        <SkeletonText lines={4} />
      </div>
    )
  }
  if (events.length === 0) {
    return (
      <p className="mt-10 max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
        No events are open for entries online yet. Ask at the counter what is coming up.
      </p>
    )
  }
  return (
    <ul className="mt-10 border-t border-hairline-soft" data-testid="portal-events">
      {events.map((event) => {
        const fee = entryFee(event, member)
        const about = [event.game?.name, event.format].filter(Boolean).join(", ")
        const places =
          event.places_left === null
            ? ""
            : event.places_left === 0
              ? "Full, join the waitlist"
              : `${event.places_left} ${event.places_left === 1 ? "place" : "places"} left`
        return (
          <li key={event.id} className="border-b border-hairline-soft">
            <button
              type="button"
              aria-pressed={choice === event.id}
              onClick={() => onChoose(event)}
              className="flex min-h-16 w-full items-start gap-4 py-4 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover aria-pressed:bg-row-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="tnum block font-mono text-[13px] text-muted-foreground">
                  {dayLabel(dateOf(event.starts_at))}, {shopClock(event.starts_at)}
                </span>
                <span className="mt-1 block text-[16px] font-medium text-foreground">{event.name}</span>
                <Note>
                  {[about, places].filter(Boolean).join(". ")}
                </Note>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span className="tnum text-[15px] text-foreground">{fee > 0 ? formatGBP(fee) : "Free"}</span>
                {member && fee !== event.entry_fee ? <Note>Guild price</Note> : null}
              </span>
            </button>
            {choice === event.id ? <div className="pb-6">{panel}</div> : null}
          </li>
        )
      })}
    </ul>
  )
}

function MyBooking({
  booking,
  now,
  cancelling,
  onCancel,
}: {
  booking: Booking
  now: number
  cancelling: boolean
  onCancel: () => void
}) {
  const name = whatOf(booking)
  const started = Date.parse(booking.starts_at) <= now
  // BK lets a customer cancel only before it starts and with nothing paid;
  // money paid goes back at the till, so the shop cancels those.
  const canCancel = isOpen(booking) && !started && booking.paid === 0
  const left = Math.max(0, booking.price - booking.paid)
  return (
    <li className="flex min-h-16 items-start gap-4 border-b border-hairline-soft py-4" data-testid="portal-my-booking">
      <span className="min-w-0 flex-1">
        <span className="tnum block font-mono text-[13px] text-muted-foreground">
          {dayLabel(dateOf(booking.starts_at))}, {timeRange(booking)}
        </span>
        <span className="mt-1 block text-[16px] text-foreground">{name}</span>
        <Note>
          {partyWords(booking.party_size)}, {statusWord(booking.status).toLowerCase()}
          {booking.waitlist_position ? `, number ${booking.waitlist_position} on the waitlist` : ""}
          {left > 0 && !booking.waitlist_position
            ? `. ${formatGBP(left)} to pay at the till`
            : booking.price > 0 && left === 0
              ? ". Paid"
              : ""}
          {isOpen(booking) && !started && booking.paid > 0 ? ". Ring the shop to cancel it" : ""}
        </Note>
      </span>
      {canCancel ? (
        <Button variant="text-destructive" loading={cancelling} onClick={onCancel} aria-label={`Cancel ${name}`}>
          Cancel
        </Button>
      ) : null}
    </li>
  )
}
