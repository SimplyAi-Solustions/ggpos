/**
 * One booking, tapped on the day view, the week or a station: who, what,
 * when, how many and what is paid, then what the counter does with it.
 * Check in (on the day) and check out are the block, by its state; Take
 * payment puts a deposit or the balance on the till's ticket; Move, Cancel
 * (keeping the deposit or giving everything back) and No-show (once it
 * should have started) are the secondary actions, each confirmed in the
 * sheet before anything is sent. Every rule is BK's: the routes refuse in
 * their own words and the sheet shows them under the block.
 *
 * "Move" here is the fallback for dragging on the day view, and the only
 * way to move a booking to another day.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { formatGBP, shopClock, type ResourceKind } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { OverrideCancelled } from "@/features/lock/override"
import {
  dateOf,
  dayLabel,
  isOpen,
  isWalkIn,
  owed,
  paidState,
  partyWords,
  paymentChoices,
  refundWords,
  shopToday,
  statusWord,
  timeRange,
  whatOf,
  type PaymentChoice,
} from "@/features/bookings/model"
import {
  cancelBooking,
  checkIn,
  checkOut,
  getAvailability,
  markNoShow,
  moveBooking,
  type Booking,
} from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

export interface ResourceRef {
  id: string
  name: string
  kind: ResourceKind
}

/** A payment the sheet hands to the screen: what, and how much. */
export interface PaymentRequest {
  key: PaymentChoice["key"] | "session" | "entry"
  amount: number
}

type Mode = "details" | "pay" | "move" | "cancel" | "no-show"

const SOURCE_WORDS: Record<string, string> = {
  till: "At the counter",
  phone: "On the phone",
  online: "Online, in My Vault",
}

function failure(error: unknown, fallback: string): string {
  if (error instanceof OverrideCancelled) return "Nothing changed. A manager needs to approve it."
  return refusalOrFallback(error, fallback)
}

export function BookingSheet({
  booking,
  resources,
  onOpenChange,
  onChanged,
  onPay,
}: {
  booking: Booking | null
  resources: ResourceRef[]
  onOpenChange: (open: boolean) => void
  /** Something changed: the sentence to show, and the booking as it is now. */
  onChanged: (message: string, booking: Booking) => void
  onPay: (booking: Booking, payment: PaymentRequest) => void
}) {
  return (
    <Sheet open={booking !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="booking-sheet">
        {booking ? (
          <BookingPanel
            key={booking.id}
            booking={booking}
            resources={resources}
            onChanged={onChanged}
            onPay={onPay}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-hairline-soft py-3">
      <MicroLabel className="shrink-0">{label}</MicroLabel>
      <span className="min-w-0 text-right text-[15px] leading-[1.45] text-foreground">{children}</span>
    </div>
  )
}

function BookingPanel({
  booking: initial,
  resources,
  onChanged,
  onPay,
  onClose,
}: {
  booking: Booking
  resources: ResourceRef[]
  onChanged: (message: string, booking: Booking) => void
  onPay: (booking: Booking, payment: PaymentRequest) => void
  onClose: () => void
}) {
  const [booking, setBooking] = React.useState(initial)
  const [mode, setMode] = React.useState<Mode>("details")
  const [problem, setProblem] = React.useState<string | null>(null)
  const what = whatOf(booking)
  const left = owed(booking)
  const walkIn = isWalkIn(booking)
  const [now] = React.useState(() => Date.now())
  const started = Date.parse(booking.starts_at) <= now
  const onTheDay = dateOf(booking.starts_at) <= shopToday(new Date(now))

  const changed = (message: string, next: Booking) => {
    setBooking(next)
    setProblem(null)
    onChanged(message, next)
  }

  const arrive = useMutation({
    mutationFn: () => checkIn(booking.id),
    onMutate: () => setProblem(null),
    onSuccess: (next) => changed(`${next.name} checked in.`, next),
    onError: (error) => setProblem(failure(error, "That check-in did not go through. Try again.")),
  })

  const leave = useMutation({
    mutationFn: () => checkOut(booking.id),
    onMutate: () => setProblem(null),
    onSuccess: (next) => {
      const { charge } = next
      const station = next.resource?.kind === "pc" || next.resource?.kind === "console"
      changed(
        station
          ? `${what} stopped after ${charge.minutes} minutes: ${formatGBP(charge.price)}.`
          : `${next.name} checked out.`,
        next
      )
      if (charge.balance > 0 && station) {
        onPay(next, { key: "session", amount: charge.balance })
        return
      }
      if (charge.balance > 0) setMode("pay")
      else onClose()
    },
    onError: (error) => setProblem(failure(error, "That check-out did not go through. Try again.")),
  })

  const choices = paymentChoices(booking)

  if (mode === "pay") {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Take payment</SheetTitle>
          <SheetDescription>
            {booking.name}, {what}. It goes on the till's ticket.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-3">
          {choices.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              {booking.waitlist_position
                ? "This entry is on the waitlist. Take payment when a place frees."
                : "Nothing is left to pay on this booking."}
            </p>
          ) : (
            choices.map((choice) => (
              <Button
                key={choice.key}
                variant="key"
                className="w-full justify-between"
                data-testid={`pay-${choice.key}`}
                onClick={() =>
                  onPay(booking, {
                    key: booking.kind === "event" && choice.key === "full" ? "entry" : choice.key,
                    amount: choice.amount,
                  })
                }
              >
                <span>{choice.label}</span>
                <span className="tnum font-sans text-[16px] font-medium tracking-normal normal-case">
                  {formatGBP(choice.amount)}
                </span>
              </Button>
            ))
          )}
        </SheetBody>
        <SheetFooter>
          <Button variant="text" onClick={() => setMode("details")}>
            Back
          </Button>
        </SheetFooter>
      </>
    )
  }

  if (mode === "move") {
    return (
      <MovePanel
        booking={booking}
        resources={resources}
        onMoved={(next) => {
          changed(`${next.name} moved to ${dayLabel(dateOf(next.starts_at))}, ${timeRange(next)}.`, next)
          setMode("details")
        }}
        onBack={() => setMode("details")}
      />
    )
  }

  if (mode === "cancel") {
    return (
      <CancelPanel
        booking={booking}
        what={what}
        onDone={(next, message) => {
          changed(message, next)
          onClose()
        }}
        onBack={() => setMode("details")}
      />
    )
  }

  if (mode === "no-show") {
    return (
      <NoShowPanel
        booking={booking}
        onDone={(next) => {
          changed(`${next.name} marked as a no-show.`, next)
          onClose()
        }}
        onBack={() => setMode("details")}
      />
    )
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{what}</SheetTitle>
        <SheetDescription className="text-[20px] leading-[1.3] font-medium text-foreground">
          {booking.name || "No name"}
        </SheetDescription>
      </SheetHeader>
      <SheetBody>
        <div className="border-t border-hairline-soft">
          <Row label="When">
            {dayLabel(dateOf(booking.starts_at))},{" "}
            {walkIn ? `from ${shopClock(booking.checked_in_at || booking.starts_at)}` : timeRange(booking)}
          </Row>
          <Row label="Party">{partyWords(booking.party_size)}</Row>
          <Row label="State">
            <span data-testid="booking-state">
              {booking.waitlist_position ? `Waitlist, number ${booking.waitlist_position}` : statusWord(booking.status)}
            </span>
          </Row>
          <Row label="Payment">
            <span className="tnum" data-testid="booking-paid">
              {paidState(booking)}
            </span>
          </Row>
          {booking.price > 0 ? (
            <Row label="Price">
              <span className="tnum">
                {formatGBP(booking.price)}
                {booking.paid > 0 ? `, ${formatGBP(booking.paid)} paid` : ""}
              </span>
            </Row>
          ) : null}
          {booking.deposit > 0 ? (
            <Row label="Deposit">
              <span className="tnum">{formatGBP(booking.deposit)}</span>
            </Row>
          ) : null}
          {booking.customer ? <Row label="Guild">{booking.customer.member ? "Member" : "Not joined"}</Row> : null}
          {booking.phone ? <Row label="Phone">{booking.phone}</Row> : null}
          {booking.source ? <Row label="Booked">{SOURCE_WORDS[booking.source] ?? booking.source}</Row> : null}
          {booking.notes ? <Row label="Notes">{booking.notes}</Row> : null}
        </div>
        {isOpen(booking) && !onTheDay ? (
          <p className="mt-4 text-[13px] leading-[1.45] text-muted-foreground-2">Check it in on the day.</p>
        ) : null}
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-5">
        <FieldError data-testid="booking-problem">{problem}</FieldError>
        {isOpen(booking) && onTheDay && !booking.waitlist_position ? (
          <Button trailingArrow loading={arrive.isPending} onClick={() => arrive.mutate()}>
            Check in
          </Button>
        ) : booking.status === "checked_in" ? (
          <Button trailingArrow loading={leave.isPending} onClick={() => leave.mutate()}>
            {walkIn ? "Stop and take payment" : "Check out"}
          </Button>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          {left > 0 && !walkIn && choices.length > 0 ? (
            <Button variant="text" onClick={() => setMode("pay")}>
              Take payment
            </Button>
          ) : null}
          {isOpen(booking) && booking.kind === "resource" ? (
            <Button variant="text" onClick={() => setMode("move")}>
              Move
            </Button>
          ) : null}
          {isOpen(booking) && started ? (
            <Button variant="text" onClick={() => setMode("no-show")}>
              No-show
            </Button>
          ) : null}
          {isOpen(booking) ? (
            <Button variant="text-destructive" onClick={() => setMode("cancel")}>
              Cancel booking
            </Button>
          ) : null}
        </div>
      </SheetFooter>
    </>
  )
}

function MovePanel({
  booking,
  resources,
  onMoved,
  onBack,
}: {
  booking: Booking
  resources: ResourceRef[]
  onMoved: (booking: Booking) => void
  onBack: () => void
}) {
  const kind = booking.resource?.kind
  const choices = resources.filter((row) => row.kind === kind)
  const length = Date.parse(booking.ends_at) - Date.parse(booking.starts_at)
  const [date, setDate] = React.useState(dateOf(booking.starts_at))
  const [resourceId, setResourceId] = React.useState(booking.resource?.id ?? "")
  const [startsAt, setStartsAt] = React.useState(booking.starts_at)
  const [problem, setProblem] = React.useState<string | null>(null)

  const availability = useQuery({
    queryKey: ["bookings-availability", date, kind ?? ""],
    queryFn: () => getAvailability(date, kind ? { kind } : {}),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
    staleTime: 10_000,
  })
  const slots = availability.data?.resources.find((row) => row.resource.id === resourceId)?.slots ?? []

  const move = useMutation({
    mutationFn: () =>
      moveBooking(booking.id, {
        starts_at: startsAt,
        ends_at: new Date(Date.parse(startsAt) + length).toISOString(),
        resource: resourceId,
      }),
    onMutate: () => setProblem(null),
    onSuccess: onMoved,
    onError: (error) => setProblem(failure(error, "That move did not go through. Try again.")),
  })

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Move booking"
      onSubmit={(event) => {
        event.preventDefault()
        move.mutate()
      }}
    >
      <SheetHeader>
        <SheetTitle>Move booking</SheetTitle>
        <SheetDescription>
          {booking.name}, now {dayLabel(dateOf(booking.starts_at))}, {timeRange(booking)}.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-8">
        <Field layout="stacked" label="Day" htmlFor="move-date">
          <Input
            id="move-date"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              setProblem(null)
            }}
          />
        </Field>
        {choices.length > 1 ? (
          <Field layout="stacked" label="Where">
            <Select value={resourceId} onValueChange={(next: string | null) => setResourceId(next ?? resourceId)}>
              <SelectTrigger aria-label="Where">
                <SelectValue>{(value: string) => choices.find((row) => row.id === value)?.name ?? "Pick one"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field layout="stacked" label="Starts">
          {slots.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              {availability.isPending ? "Looking at that day." : "Nothing is open that day."}
            </p>
          ) : (
            <Select value={startsAt} onValueChange={(next: string | null) => setStartsAt(next ?? startsAt)}>
              <SelectTrigger aria-label="Starts">
                <SelectValue>{(value: string) => (value ? shopClock(value) : "Pick a time")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {slots.map((slot) => (
                  <SelectItem key={slot.starts_at} value={slot.starts_at}>
                    {shopClock(slot.starts_at)}
                    {slot.free ? "" : ", taken"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError data-testid="move-problem">{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button type="submit" trailingArrow loading={move.isPending}>
            Move booking
          </Button>
          <Button type="button" variant="text" onClick={onBack}>
            Back
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}

function CancelPanel({
  booking,
  what,
  onDone,
  onBack,
}: {
  booking: Booking
  what: string
  onDone: (booking: Booking, message: string) => void
  onBack: () => void
}) {
  const [keep, setKeep] = React.useState(booking.deposit > 0)
  const [problem, setProblem] = React.useState<string | null>(null)
  const cancel = useMutation({
    mutationFn: () => cancelBooking(booking.id, keep),
    onMutate: () => setProblem(null),
    onSuccess: (next) => {
      const money = refundWords(next)
      onDone(next, `${what} for ${booking.name} cancelled.${money ? ` ${money}` : ""}`)
    },
    onError: (error) => setProblem(failure(error, "That booking was not cancelled. Try again.")),
  })

  return (
    <>
      <SheetHeader>
        <SheetTitle>Cancel booking</SheetTitle>
        <SheetDescription>
          {booking.name}, {what}, {dayLabel(dateOf(booking.starts_at))}, {timeRange(booking)}.
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        {booking.paid > 0 ? (
          <Field layout="stacked" label={`${formatGBP(booking.paid)} paid`}>
            {booking.deposit > 0 ? (
              <ChipGroup
                aria-label="What happens to what was paid"
                value={[keep ? "keep" : "refund"]}
                onValueChange={(next: string[]) => {
                  if (next[0] === "keep" || next[0] === "refund") setKeep(next[0] === "keep")
                }}
              >
                <Chip value="keep">Keep the deposit</Chip>
                <Chip value="refund">Refund it all</Chip>
              </ChipGroup>
            ) : null}
            <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground-2">
              The money goes back at the till, through Returns on the sale it was paid in. Nothing is refunded here.
            </p>
          </Field>
        ) : (
          <p className="text-[15px] leading-[1.5] text-muted-foreground">Nothing has been paid on it.</p>
        )}
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError>{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button trailingArrow loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel the booking
          </Button>
          <Button variant="text" onClick={onBack}>
            Keep it booked
          </Button>
        </div>
      </SheetFooter>
    </>
  )
}

function NoShowPanel({
  booking,
  onDone,
  onBack,
}: {
  booking: Booking
  onDone: (booking: Booking) => void
  onBack: () => void
}) {
  const [problem, setProblem] = React.useState<string | null>(null)
  const mark = useMutation({
    mutationFn: () => markNoShow(booking.id),
    onMutate: () => setProblem(null),
    onSuccess: onDone,
    onError: (error) => setProblem(failure(error, "That did not go through. Try again.")),
  })
  return (
    <>
      <SheetHeader>
        <SheetTitle>No-show</SheetTitle>
        <SheetDescription>
          {booking.name} did not come. The time is freed up
          {booking.paid > 0 ? ` and the ${formatGBP(booking.paid)} paid is kept.` : "."}
        </SheetDescription>
      </SheetHeader>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError>{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button trailingArrow loading={mark.isPending} onClick={() => mark.mutate()}>
            Mark as a no-show
          </Button>
          <Button variant="text" onClick={onBack}>
            Back
          </Button>
        </div>
      </SheetFooter>
    </>
  )
}
