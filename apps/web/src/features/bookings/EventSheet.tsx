/**
 * One event (`GET /api/vault/events/{id}`): when and what, how many places
 * are left, the entries with their party sizes and whether they have paid,
 * the waitlist in the order it is offered, and check-in by scanning the
 * customer's Guild card QR (`POST /api/vault/events/{id}/check-in`; section
 * 4, "Events"). An entry is added here for a customer from the book or by
 * name, at the Guild fee for a member's whole party; past the places left it
 * goes on the waitlist, and a tier's free entry takes one fee off.
 *
 * While the sheet is open it takes the counter's scanner, so a card read by
 * the wedge scanner checks its holder in without touching the field.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MinusIcon, PlusIcon } from "lucide-react"
import { entryFee, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { setScanHandler } from "@/app/scan-bus"
import { OverrideCancelled } from "@/features/lock/override"
import { isManagerUp, useStaffRole } from "@/features/lock/role"
import { CustomerPicker, type PickedCustomer } from "@/features/bookings/CustomerPicker"
import type { PaymentRequest } from "@/features/bookings/BookingSheet"
import {
  dateOf,
  dayLabel,
  feeWords,
  owed,
  paidState,
  partyWords,
  paymentChoices,
  placesWords,
  splitEntries,
  statusWord,
  timeRange,
} from "@/features/bookings/model"
import {
  cancelEvent,
  checkIn,
  checkInByCard,
  createBooking,
  getEvent,
  updateEvent,
  type Booking,
  type EventView,
} from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

function failure(error: unknown, fallback: string): string {
  if (error instanceof OverrideCancelled) return "Nothing changed. A manager needs to approve it."
  return refusalOrFallback(error, fallback)
}

export function EventSheet({
  event,
  onOpenChange,
  onChanged,
  onPay,
}: {
  event: EventView | null
  onOpenChange: (open: boolean) => void
  onChanged: (message: string) => void
  onPay: (booking: Booking, payment: PaymentRequest) => void
}) {
  return (
    <Sheet open={event !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)] sm:max-w-lg" data-testid="event-sheet">
        {event ? <EventPanel key={event.id} initial={event} onChanged={onChanged} onPay={onPay} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function EventPanel({
  initial,
  onChanged,
  onPay,
}: {
  initial: EventView
  onChanged: (message: string) => void
  onPay: (booking: Booking, payment: PaymentRequest) => void
}) {
  const queryClient = useQueryClient()
  const role = useStaffRole()
  const [notice, setNotice] = React.useState<string | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const scanRef = React.useRef<HTMLInputElement>(null)

  const detail = useQuery({
    queryKey: ["booking-entries", initial.id],
    queryFn: () => getEvent(initial.id),
    staleTime: 5_000,
  })
  const event = detail.data?.event ?? initial
  const split = splitEntries(detail.data?.entries ?? [])

  const refresh = React.useCallback(
    (message: string) => {
      setNotice(message)
      setProblem(null)
      for (const key of [["booking-entries", initial.id], ["bookings"], ["booking-events"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
      onChanged(message)
    },
    [initial.id, onChanged, queryClient]
  )

  const arrive = useMutation({
    mutationFn: (entry: Booking) => checkIn(entry.id),
    onMutate: () => setProblem(null),
    onSuccess: (entry) => refresh(`${entry.name} checked in.`),
    onError: (error) => setProblem(failure(error, "That check-in did not go through. Try again.")),
  })

  const byCard = useMutation({
    mutationFn: (scanned: string) => checkInByCard(initial.id, scanned),
    onMutate: () => {
      setProblem(null)
      setNotice(null)
    },
    onSuccess: (entry) => refresh(`${entry.name} checked in.`),
    onError: (error) => setProblem(failure(error, "That card could not be read. Scan it again.")),
  })
  const { mutate: checkInCard } = byCard

  const publish = useMutation({
    mutationFn: () => updateEvent(initial.id, { status: "published" }),
    onSuccess: (next) => refresh(`${next.name} is published.`),
    onError: (error) => setProblem(failure(error, "The event was not published. Try again.")),
  })

  const callOff = useMutation({
    mutationFn: () => cancelEvent(initial.id),
    onSuccess: (result) => {
      setCancelling(false)
      const refunds = result.refunds.reduce((sum, refund) => sum + refund.amount, 0)
      refresh(
        `${result.event.name} is cancelled and its ${result.cancelled} ${result.cancelled === 1 ? "entry" : "entries"} told.` +
          (refunds > 0 ? ` Refund ${formatGBP(refunds)} at the till, through Returns on each sale.` : "")
      )
    },
    onError: (error) => setProblem(failure(error, "The event was not cancelled. Try again.")),
  })

  /** A Guild card scanned or typed: its holder's entry, checked in. */
  const onScan = React.useCallback(
    (raw: string) => {
      if (scanRef.current) scanRef.current.value = ""
      const value = raw.trim()
      if (value) checkInCard(value)
    },
    [checkInCard]
  )
  React.useEffect(() => setScanHandler(onScan), [onScan])

  const open = event.status === "published"

  return (
    <>
      <SheetHeader>
        <SheetTitle>{event.status === "published" ? "Event" : `Event, ${event.status}`}</SheetTitle>
        <SheetDescription className="text-[20px] leading-[1.3] font-medium text-foreground">
          {event.name}
        </SheetDescription>
        <p className="text-[15px] leading-[1.5] text-muted-foreground">
          {dayLabel(dateOf(event.starts_at))}, {timeRange(event)}
          {event.game ? `. ${event.game.name}` : ""}
          {event.format ? `, ${event.format}` : ""}.
        </p>
        <p className="tnum text-[15px] text-foreground" data-testid="event-places">
          {placesWords(event)}. {feeWords(event)}.
        </p>
      </SheetHeader>
      <SheetBody>
        {event.status === "draft" ? (
          <div className="mb-8 flex flex-wrap items-center gap-6">
            <p className="text-[15px] text-muted-foreground">Nobody can enter until it is published.</p>
            <Button variant="text" loading={publish.isPending} onClick={() => publish.mutate()}>
              Publish
            </Button>
          </div>
        ) : null}

        {open ? (
          <form
            aria-label="Check in by card"
            onSubmit={(submit) => {
              submit.preventDefault()
              onScan(scanRef.current?.value ?? "")
            }}
          >
            <Input
              ref={scanRef}
              data-testid="event-checkin-field"
              leadingIcon={<BarcodeGlyph />}
              trailingHint="Press enter"
              placeholder="Scan their card to check in"
              aria-label="Scan the customer's Guild card to check them in"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="go"
            />
          </form>
        ) : null}
        <FieldError data-testid="event-problem">{problem}</FieldError>
        {notice && !problem ? (
          <p aria-live="polite" data-testid="event-notice" className="mt-2 text-[13px] text-muted-foreground">
            {notice}
          </p>
        ) : null}

        <SectionHeading className="mt-10">Entries</SectionHeading>
        {detail.isPending ? (
          <p className="text-[15px] text-muted-foreground-2">Loading the entries.</p>
        ) : detail.isError ? (
          <p className="text-[15px] text-destructive">
            {refusalOrFallback(detail.error, "The entries would not load. Check the connection and try again.")}
          </p>
        ) : split.entered.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">Nobody has entered yet.</p>
        ) : (
          <ul className="border-t border-hairline-soft" data-testid="event-entries">
            {split.entered.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                pending={arrive.isPending && arrive.variables?.id === entry.id}
                onCheckIn={() => arrive.mutate(entry)}
                onPay={() => {
                  const choice = paymentChoices(entry).at(-1)
                  if (choice) onPay(entry, { key: choice.key, amount: choice.amount })
                }}
              />
            ))}
          </ul>
        )}

        {split.waitlist.length > 0 ? (
          <>
            <SectionHeading className="mt-10">Waitlist</SectionHeading>
            <ol className="border-t border-hairline-soft" data-testid="event-waitlist">
              {split.waitlist.map((entry) => (
                <li key={entry.id} className="flex min-h-14 items-center gap-4 border-b border-hairline-soft py-2">
                  <span className="tnum w-6 font-mono text-[13px] text-muted-foreground-2">{entry.waitlist_position}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{entry.name}</span>
                    <span className="block text-[13px] text-muted-foreground-2">{partyWords(entry.party_size)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
              Offered a place in this order when one frees. They are told by email.
            </p>
          </>
        ) : null}

        {open ? (
          <AddEntry
            event={event}
            onAdded={(entry) =>
              refresh(
                entry.waitlist_position
                  ? `${entry.name} is on the waitlist for ${event.name}, number ${entry.waitlist_position}.`
                  : `${entry.name} is entered in ${event.name}.`
              )
            }
          />
        ) : null}

        {isManagerUp(role) && (event.status === "published" || event.status === "draft") ? (
          <div className="mt-14 border-t border-hairline-soft pt-6">
            {cancelling ? (
              <div className="flex flex-col gap-4">
                <p className="text-[15px] leading-[1.5] text-foreground">
                  Cancel {event.name}? Every entry is cancelled and told, and what they paid is listed to refund.
                </p>
                <div className="flex flex-wrap items-center gap-6">
                  <Button variant="text-destructive" loading={callOff.isPending} onClick={() => callOff.mutate()}>
                    Cancel the event
                  </Button>
                  <Button variant="text" onClick={() => setCancelling(false)}>
                    Keep it on
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="text-destructive" onClick={() => setCancelling(true)}>
                Cancel event
              </Button>
            )}
          </div>
        ) : null}
      </SheetBody>
    </>
  )
}

function EntryRow({
  entry,
  pending,
  onCheckIn,
  onPay,
}: {
  entry: Booking
  pending: boolean
  onCheckIn: () => void
  onPay: () => void
}) {
  const due = owed(entry)
  return (
    <li className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hairline-soft py-3" data-testid="event-entry">
      {/* Wide enough to read whole; on a phone the actions wrap under it. */}
      <span className="min-w-[11rem] flex-1">
        <span className="block truncate text-[15px] text-foreground">{entry.name}</span>
        <span className="tnum block text-[13px] leading-[1.45] text-muted-foreground-2">
          {partyWords(entry.party_size)}, {statusWord(entry.status).toLowerCase()}, {paidState(entry).toLowerCase()}
        </span>
      </span>
      <span className="flex items-center gap-4">
        {due > 0 ? (
          <Button variant="text" onClick={onPay} aria-label={`Take ${formatGBP(due)} from ${entry.name}`}>
            Take payment
          </Button>
        ) : null}
        {entry.status === "held" || entry.status === "confirmed" ? (
          <Button variant="key" className="h-12" loading={pending} onClick={onCheckIn} aria-label={`Check ${entry.name} in`}>
            Check in
          </Button>
        ) : entry.status === "checked_in" ? (
          <MicroLabel tone="ink">In</MicroLabel>
        ) : null}
      </span>
    </li>
  )
}

function AddEntry({ event, onAdded }: { event: EventView; onAdded: (entry: Booking) => void }) {
  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null)
  const [name, setName] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [party, setParty] = React.useState(1)
  const [free, setFree] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)
  const left = event.places_left
  const waitlist = left !== null && party > left
  const fee = entryFee(event, customer?.member ?? false)
  const price = Math.max(0, fee * party - (free && customer && !waitlist ? fee : 0))

  const add = useMutation({
    mutationFn: () => {
      if (!customer && !name.trim()) throw new Error("Pick the customer, or type a name.")
      return createBooking({
        event: event.id,
        party_size: party,
        customer: customer?.id ?? null,
        name: customer ? undefined : name.trim(),
        phone: customer ? undefined : phone.trim(),
        source: "till",
        ...(waitlist ? { waitlist: true } : {}),
        ...(free && customer && !waitlist ? { free_entry: true } : {}),
      })
    },
    onMutate: () => setProblem(null),
    onSuccess: (entry) => {
      setCustomer(null)
      setName("")
      setPhone("")
      setParty(1)
      setFree(false)
      onAdded(entry)
    },
    onError: (error) => setProblem(failure(error, "That entry did not go through. Try again.")),
  })

  return (
    <form
      className="mt-12 flex flex-col gap-6"
      aria-label="Add an entry"
      onSubmit={(submit) => {
        submit.preventDefault()
        add.mutate()
      }}
    >
      <SectionHeading className="mt-0 mb-0">Add an entry</SectionHeading>
      <CustomerPicker value={customer} onChange={setCustomer} />
      {!customer ? (
        <div className="flex flex-col gap-6">
          <Input
            aria-label="Name"
            placeholder="Or a name, if they are not in the book"
            autoComplete="off"
            value={name}
            onChange={(change) => setName(change.target.value)}
          />
          <Input
            aria-label="Phone"
            placeholder="Phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            onChange={(change) => setPhone(change.target.value)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <Switch checked={free} onCheckedChange={(next: boolean) => setFree(next)} aria-label="Use a free entry" />
          <span className="text-[15px] text-foreground">
            {free ? "One free entry from their tier" : "No free entry"}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost-icon"
            className="size-12"
            aria-label="One fewer player"
            disabled={party <= 1}
            onClick={() => setParty((value) => Math.max(1, value - 1))}
          >
            <MinusIcon />
          </Button>
          <span className="tnum w-24 text-center text-[16px] text-foreground">{partyWords(party)}</span>
          <Button
            type="button"
            variant="ghost-icon"
            className="size-12"
            aria-label="One more player"
            onClick={() => setParty((value) => value + 1)}
          >
            <PlusIcon />
          </Button>
        </div>
        <span className="tnum text-[20px] font-medium text-foreground" data-testid="entry-fee">
          {formatGBP(price)}
        </span>
      </div>
      {customer?.member && event.member_fee !== null && event.member_fee !== event.entry_fee ? (
        <p className="-mt-3 text-[13px] text-muted-foreground-2">The Guild fee, for the whole party.</p>
      ) : null}
      {waitlist ? (
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          {left === 0 ? "The event is full." : `Only ${left} ${left === 1 ? "place is" : "places are"} left.`} This entry
          goes on the waitlist, and pays when a place frees.
        </p>
      ) : null}
      <FieldError data-testid="entry-problem">{problem}</FieldError>
      <div>
        <Button type="submit" trailingArrow loading={add.isPending}>
          {waitlist ? "Add to the waitlist" : customer ? `Enter ${customer.name}` : "Add entry"}
        </Button>
      </div>
    </form>
  )
}
