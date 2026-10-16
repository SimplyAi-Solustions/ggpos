/**
 * The stations strip (`GET /api/vault/bookings/stations`): every PC and
 * console, free or in use, with the clock and what the session comes to so
 * far, as the check-out will charge it (`sessionCharge`, section 4,
 * "Walk-in sessions"). Start puts a walk-in on the clock now, for a Guild
 * member at the Guild price when one is picked; Stop checks it out and hands
 * the charge to the screen, which puts it on the till's ticket.
 *
 * On the day view under the date, and in the till's Bookings sheet. Each
 * station is a touch target with a hairline edge, the till tile's shape,
 * because it is pressed standing up.
 */
import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { formatGBP, shopClock, type StationView } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { MicroLabel } from "@/components/ui/micro-label"
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
import { CustomerPicker, type PickedCustomer } from "@/features/bookings/CustomerPicker"
import { clockSince, priceFor, rateWords, runningCharge } from "@/features/bookings/model"
import { useNow } from "@/features/bookings/use-now"
import { checkOut, startSession, type Booking, type BookingCheckedOut } from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

type Station = StationView["resource"]

function failure(error: unknown, fallback: string): string {
  if (error instanceof OverrideCancelled) return "Nothing changed. A manager needs to approve it."
  return refusalOrFallback(error, fallback)
}

export function StationsStrip({
  stations,
  onStarted,
  onStopped,
}: {
  stations: readonly StationView[]
  onStarted: (booking: Booking) => void
  /** A session stopped: the booking, with the charge and what is left to pay. */
  onStopped: (stopped: BookingCheckedOut) => void
}) {
  const now = useNow()
  const [starting, setStarting] = React.useState<Station | null>(null)
  const [stopping, setStopping] = React.useState<{ station: Station; session: Booking } | null>(null)

  if (stations.length === 0) return null

  return (
    <section aria-labelledby="stations-heading" data-testid="stations">
      <MicroLabel tone="ink" id="stations-heading" className="mb-3">
        Stations
      </MicroLabel>
      <ul className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {stations.map(({ resource: station, session, next }) => (
          <li
            key={station.id}
            data-testid="station"
            data-station={station.name}
            data-state={session ? "in-use" : "free"}
            className="flex w-[188px] shrink-0 items-center gap-3 rounded-[var(--radius)] border border-hairline-soft py-2 pr-2 pl-3"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <MicroLabel tone="ink" className="truncate">
                {station.name}
              </MicroLabel>
              {session ? (
                <span className="tnum truncate text-[13px] leading-tight text-foreground" data-testid="station-charge">
                  <span className="font-mono">{clockSince(session.checked_in_at || session.starts_at, now)}</span>
                  {", "}
                  {formatGBP(Math.max(0, runningCharge(session, station, now) - session.paid))}
                </span>
              ) : (
                <span className="truncate text-[13px] leading-tight text-muted-foreground">
                  {next ? (
                    <>
                      Free till <span className="tnum font-mono">{shopClock(next.starts_at)}</span>
                    </>
                  ) : (
                    "Free"
                  )}
                </span>
              )}
            </span>
            {session ? (
              <Button
                variant="key"
                className="h-12 shrink-0 px-4"
                aria-label={`Stop ${station.name}`}
                onClick={() => setStopping({ station, session })}
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="key"
                className="h-12 shrink-0 px-4"
                aria-label={`Start ${station.name}`}
                onClick={() => setStarting(station)}
              >
                Start
              </Button>
            )}
          </li>
        ))}
      </ul>

      <StartSheet
        station={starting}
        onOpenChange={(open) => {
          if (!open) setStarting(null)
        }}
        onStarted={(booking) => {
          setStarting(null)
          onStarted(booking)
        }}
      />
      <StopSheet
        target={stopping}
        now={now}
        onOpenChange={(open) => {
          if (!open) setStopping(null)
        }}
        onStopped={(stopped) => {
          setStopping(null)
          onStopped(stopped)
        }}
      />
    </section>
  )
}

function StartSheet({
  station,
  onOpenChange,
  onStarted,
}: {
  station: Station | null
  onOpenChange: (open: boolean) => void
  onStarted: (booking: Booking) => void
}) {
  return (
    <Sheet open={station !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="start-sheet">
        {station ? (
          <StartForm key={station.id} station={station} onStarted={onStarted} onCancel={() => onOpenChange(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function StartForm({
  station,
  onStarted,
  onCancel,
}: {
  station: Station
  onStarted: (booking: Booking) => void
  onCancel: () => void
}) {
  const [customer, setCustomer] = React.useState<PickedCustomer | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const start = useMutation({
    mutationFn: () => startSession(station.id, { customer: customer?.id ?? null }),
    onMutate: () => setProblem(null),
    onSuccess: onStarted,
    onError: (error) => setProblem(failure(error, "The clock did not start. Try again.")),
  })
  const price = priceFor(station, customer?.member ?? false)

  return (
    <>
      <SheetHeader>
        <SheetTitle>Start {station.name}</SheetTitle>
        <SheetDescription>The clock starts now. A part slot counts once it runs past ten minutes.</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        <div>
          <MicroLabel className="mb-2">Who is playing</MicroLabel>
          <CustomerPicker value={customer} onChange={setCustomer} label="Who is playing" />
          <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
            Optional. A Guild member plays at the Guild price.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <MicroLabel>Rate</MicroLabel>
          <span className="tnum text-[20px] font-medium text-foreground">
            {rateWords(price.price, station.slot_minutes)}
          </span>
          {price.memberPrice ? <p className="text-[13px] text-muted-foreground-2">The Guild price.</p> : null}
        </div>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError>{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button trailingArrow loading={start.isPending} onClick={() => start.mutate()}>
            Start the clock
          </Button>
          <Button variant="text" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetFooter>
    </>
  )
}

function StopSheet({
  target,
  now,
  onOpenChange,
  onStopped,
}: {
  target: { station: Station; session: Booking } | null
  now: number
  onOpenChange: (open: boolean) => void
  onStopped: (stopped: BookingCheckedOut) => void
}) {
  const [problem, setProblem] = React.useState<string | null>(null)
  const stop = useMutation({
    mutationFn: (id: string) => checkOut(id),
    onMutate: () => setProblem(null),
    onSuccess: onStopped,
    onError: (error) => setProblem(failure(error, "The session did not stop. Try again.")),
  })
  const comes = target ? runningCharge(target.session, target.station, now) : 0
  const paid = target?.session.paid ?? 0
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setProblem(null)
        onOpenChange(open)
      }}
    >
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="stop-sheet">
        {target ? (
          <>
            <SheetHeader>
              <SheetTitle>Stop {target.station.name}</SheetTitle>
              <SheetDescription>
                {target.session.name}, on the clock for{" "}
                {clockSince(target.session.checked_in_at || target.session.starts_at, now)}.
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <MicroLabel>Comes to</MicroLabel>
              <span className="tnum mt-1 block text-[20px] font-medium text-foreground">{formatGBP(comes)}</span>
              <p className="mt-2 text-[13px] text-muted-foreground-2">
                {paid > 0 ? `${formatGBP(paid)} is paid already. ` : ""}
                What is left goes on the till's ticket.
              </p>
            </SheetBody>
            <SheetFooter className="flex-col items-stretch gap-4">
              <FieldError>{problem}</FieldError>
              <div className="flex flex-wrap items-center gap-6">
                <Button trailingArrow loading={stop.isPending} onClick={() => stop.mutate(target.session.id)}>
                  Stop and take payment
                </Button>
                <Button variant="text" onClick={() => onOpenChange(false)}>
                  Keep it running
                </Button>
              </div>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
