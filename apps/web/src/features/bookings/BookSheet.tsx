/**
 * A new booking at the counter: tap a free slot on the day view, or "New
 * booking" to pick the table and the time here. How long, how many, who it
 * is for (a customer from the book, or a name and a phone number), and the
 * price, the Guild price when they are a member. Booked straight away and
 * confirmed; the server's own sentence shows under the button when it
 * cannot be, a clash included.
 */
import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { MinusIcon, PlusIcon } from "lucide-react"
import { bookingPrice, formatGBP, shopClock, type Availability } from "@gg/shared"

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
import { Textarea } from "@/components/ui/textarea"
import { OverrideCancelled } from "@/features/lock/override"
import { CustomerPicker, type PickedCustomer } from "@/features/bookings/CustomerPicker"
import { dayLabel, lengthChoices, lengthWords, partyWords } from "@/features/bookings/model"
import { createBooking, type Booking } from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

type AvailableResource = Availability["resources"][number]

export interface BookSheetStart {
  resourceId: string
  startsAt: string
}

export function BookSheet({
  open,
  onOpenChange,
  date,
  availability,
  start,
  onBooked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  date: string
  availability: Availability | undefined
  /** A tapped slot, or null to choose here. */
  start: BookSheetStart | null
  onBooked: (booking: Booking) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="book-sheet">
        {open ? (
          <BookForm
            key={`${start?.resourceId ?? ""}-${start?.startsAt ?? ""}-${date}`}
            date={date}
            availability={availability}
            start={start}
            onBooked={onBooked}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function BookForm({
  date,
  availability,
  start,
  onBooked,
  onCancel,
}: {
  date: string
  availability: Availability | undefined
  start: BookSheetStart | null
  onBooked: (booking: Booking) => void
  onCancel: () => void
}) {
  const resources = availability?.resources ?? []
  const [resourceId, setResourceId] = React.useState(start?.resourceId ?? resources[0]?.resource.id ?? "")
  const entry: AvailableResource | undefined = resources.find((row) => row.resource.id === resourceId)
  const firstFree = entry?.slots.find((slot) => slot.free) ?? entry?.slots[0]
  const [startsAt, setStartsAt] = React.useState(start?.startsAt ?? firstFree?.starts_at ?? "")
  const [slots, setSlots] = React.useState(1)
  const [party, setParty] = React.useState(1)
  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null)
  const [name, setName] = React.useState("")
  const [phone, setPhone] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [problem, setProblem] = React.useState<string | null>(null)

  const choices = entry ? lengthChoices(entry.slots, startsAt) : []
  const run = choices[Math.min(slots, choices.length) - 1] ?? []
  const window =
    run.length > 0
      ? { starts_at: run[0]?.starts_at ?? "", ends_at: run[run.length - 1]?.ends_at ?? "" }
      : null
  const resource = entry?.resource
  const member = customer?.member ?? false
  const priced = resource && window ? bookingPrice(resource, window, member) : null
  const fullPrice = resource && window ? bookingPrice(resource, window, false).price : 0
  const guildPrice = resource && window ? bookingPrice(resource, window, true).price : 0
  // A capacity of 0 has no limit (BK reads an unset number as 0).
  const capacity = resource && resource.capacity > 0 ? resource.capacity : 99
  const priceNote = !priced
    ? null
    : member && priced.price !== fullPrice
      ? `The Guild price. ${formatGBP(fullPrice)} for anybody else.`
      : !member && guildPrice !== fullPrice
        ? `${formatGBP(guildPrice)} for a Guild member.`
        : null

  const book = useMutation({
    mutationFn: () => {
      if (!resource || !window) throw new Error("Pick a table or a station and a time.")
      if (!customer && !name.trim()) throw new Error("Pick the customer, or type a name.")
      return createBooking({
        resource: resource.id,
        starts_at: window.starts_at,
        ends_at: window.ends_at,
        party_size: party,
        customer: customer?.id ?? null,
        name: customer ? undefined : name.trim(),
        phone: customer ? undefined : phone.trim(),
        notes: notes.trim() || undefined,
        source: "till",
      })
    },
    onMutate: () => setProblem(null),
    onSuccess: (booking) => onBooked(booking),
    onError: (error) => {
      if (error instanceof OverrideCancelled) {
        setProblem("Nothing was booked. A manager needs to approve it.")
        return
      }
      setProblem(refusalOrFallback(error, "That booking did not go through. Try again."))
    },
  })

  const what = resource ? resource.name : "a booking"

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-label="New booking"
      onSubmit={(event) => {
        event.preventDefault()
        book.mutate()
      }}
    >
      <SheetHeader>
        <SheetTitle>New booking</SheetTitle>
        <SheetDescription>
          {start && resource
            ? `${resource.name}, ${dayLabel(date)}, ${shopClock(startsAt)}`
            : `${dayLabel(date)}. Pick what and when.`}
        </SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-8">
        {!start ? (
          <>
            <Field layout="stacked" label="What">
              <Select
                value={resourceId || null}
                onValueChange={(next: string | null) => {
                  const chosen = resources.find((row) => row.resource.id === next)
                  setResourceId(next ?? "")
                  setStartsAt((chosen?.slots.find((slot) => slot.free) ?? chosen?.slots[0])?.starts_at ?? "")
                  setSlots(1)
                  setProblem(null)
                }}
              >
                <SelectTrigger aria-label="What">
                  <SelectValue placeholder="Pick a table or a station">
                    {(value: string) =>
                      resources.find((row) => row.resource.id === value)?.resource.name ?? "Pick one"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {resources.map((row) => (
                    <SelectItem key={row.resource.id} value={row.resource.id}>
                      {row.resource.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field layout="stacked" label="Starts">
              <Select
                value={startsAt || null}
                onValueChange={(next: string | null) => {
                  setStartsAt(next ?? "")
                  setSlots(1)
                  setProblem(null)
                }}
              >
                <SelectTrigger aria-label="Starts">
                  <SelectValue placeholder="Pick a time">
                    {(value: string) => (value ? shopClock(value) : "Pick a time")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(entry?.slots ?? []).map((slot) => (
                    <SelectItem key={slot.starts_at} value={slot.starts_at}>
                      {shopClock(slot.starts_at)}
                      {slot.free ? "" : ", taken"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        ) : null}

        <Field layout="stacked" label="How long">
          {choices.length > 0 && resource ? (
            <ChipGroup
              aria-label="How long"
              value={[String(Math.min(slots, choices.length))]}
              onValueChange={(next: string[]) => {
                const value = Number(next[0])
                if (value > 0) {
                  setSlots(value)
                  setProblem(null)
                }
              }}
            >
              {choices.map((choice) => (
                <Chip key={choice.length} value={String(choice.length)}>
                  {lengthWords(choice.length * resource.slot_minutes)}
                </Chip>
              ))}
            </ChipGroup>
          ) : (
            <p className="text-[15px] text-muted-foreground">Nothing can be booked then.</p>
          )}
        </Field>

        <Field layout="stacked" label="Players">
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
            <span className="tnum w-24 text-center text-[16px] text-foreground" data-testid="book-party">
              {partyWords(party)}
            </span>
            <Button
              type="button"
              variant="ghost-icon"
              className="size-12"
              aria-label="One more player"
              disabled={party >= capacity}
              onClick={() => setParty((value) => Math.min(capacity, value + 1))}
            >
              <PlusIcon />
            </Button>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground-2">
            {resource && resource.capacity > 0 ? `${resource.name} takes up to ${resource.capacity}.` : ""}
          </p>
        </Field>

        <Field layout="stacked" label="Who">
          <CustomerPicker value={customer} onChange={setCustomer} />
          {!customer ? (
            <div className="mt-6 flex flex-col gap-6">
              <Input
                aria-label="Name"
                placeholder="Or a name, if they are not in the book"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Input
                aria-label="Phone"
                placeholder="Phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          ) : null}
        </Field>

        <Field layout="stacked" label="Notes" htmlFor="book-notes">
          <Textarea
            id="book-notes"
            maxLength={500}
            placeholder="Anything the counter should know"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        <div className="flex flex-col gap-1" data-testid="book-price">
          <MicroLabel>Price</MicroLabel>
          <span className="tnum text-[20px] font-medium text-foreground">
            {priced ? formatGBP(priced.price) : "None yet"}
          </span>
          {priceNote ? <p className="text-[13px] text-muted-foreground-2">{priceNote}</p> : null}
          {priced && priced.deposit > 0 ? (
            <p className="text-[13px] text-muted-foreground-2">
              Deposit {formatGBP(priced.deposit)}, taken at the till.
            </p>
          ) : null}
        </div>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError data-testid="book-problem">{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button type="submit" trailingArrow loading={book.isPending} disabled={!window}>
            {`Book ${what}`}
          </Button>
          <Button type="button" variant="text" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}
