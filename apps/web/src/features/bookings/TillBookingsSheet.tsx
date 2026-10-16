/**
 * Bookings on the till (docs/api-contract-launch.md, section 4, "Web (BW)"):
 * from the till menu and its Bookings tile. Today's bookings and event
 * entries with something left to pay, each with its deposit or the rest as
 * a key that puts it on the ticket, and the stations strip, where a session
 * starts and stops and its charge lands on the ticket the same way.
 *
 * The till decides what a line on its ticket means; this sheet only hands
 * it the line and whose booking it was.
 */
import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP, shopClock } from "@gg/shared"

import { Button } from "@/components/ui/button"
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
import { StationsStrip } from "@/features/bookings/Stations"
import {
  isWalkIn,
  lineTitle,
  owed,
  partyWords,
  paymentChoices,
  shopToday,
  statusWord,
  whatOf,
} from "@/features/bookings/model"
import { bookingLine } from "@/features/bookings/till-line"
import { useNow } from "@/features/bookings/use-now"
import type { TicketLine } from "@/features/till/ticket"
import { listBookings, listStations, type Booking } from "@/lib/api/bookings"

export function TillBookingsSheet({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Puts the line on the ticket; the customer's card code comes with it. */
  onAdd: (line: TicketLine, customerCode?: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)] sm:max-w-lg" data-testid="till-bookings-sheet">
        {open ? <TillBookings onAdd={onAdd} onClose={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function TillBookings({
  onAdd,
  onClose,
}: {
  onAdd: (line: TicketLine, customerCode?: string) => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const now = useNow(60_000)
  const today = shopToday(new Date(now))
  const bookings = useQuery({
    queryKey: ["bookings", today, today],
    queryFn: () => listBookings(today),
    staleTime: 5_000,
    // A sale this till just took may have paid one: read them again each time.
    refetchOnMount: "always",
  })
  const stations = useQuery({
    queryKey: ["booking-stations"],
    queryFn: listStations,
    staleTime: 5_000,
    refetchOnMount: "always",
  })

  const owing = (bookings.data ?? [])
    .filter(
      (row) =>
        owed(row) > 0 &&
        !isWalkIn(row) &&
        !row.waitlist_position &&
        row.status !== "cancelled" &&
        row.status !== "no_show"
    )
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))

  const refresh = () => {
    for (const key of [["bookings"], ["bookings-availability"], ["booking-stations"], ["booking-entries"]]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  const add = (booking: Booking, key: "deposit" | "balance" | "full" | "session", amount: number) => {
    onAdd(
      bookingLine({
        bookingId: booking.id,
        title: lineTitle(booking, whatOf(booking), key),
        amount,
      }),
      booking.customer?.code || undefined
    )
    onClose()
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>Bookings</SheetTitle>
        <SheetDescription>Today's bookings with something to pay, and the stations.</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-10">
        <StationsStrip
          stations={stations.data ?? []}
          onStarted={refresh}
          onStopped={(stopped) => {
            refresh()
            if (stopped.charge.balance > 0) add(stopped, "session", stopped.charge.balance)
          }}
        />

        <div>
          <MicroLabel tone="ink" className="mb-3">
            To pay today
          </MicroLabel>
          {bookings.isPending ? (
            <p className="text-[15px] text-muted-foreground-2">Loading today's bookings.</p>
          ) : owing.length === 0 ? (
            <p className="text-[15px] text-muted-foreground" data-testid="till-bookings-none">
              Nothing is waiting to be paid today.
            </p>
          ) : (
            <ul className="border-t border-hairline-soft" data-testid="till-bookings-owing">
              {owing.map((booking) => (
                <li key={booking.id} className="flex flex-col gap-3 border-b border-hairline-soft py-4" data-testid="till-booking">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block truncate text-[16px] text-foreground">{booking.name}</span>
                      <span className="tnum block truncate text-[13px] text-muted-foreground-2">
                        {whatOf(booking)}, {shopClock(booking.starts_at)}, {partyWords(booking.party_size)},{" "}
                        {statusWord(booking.status).toLowerCase()}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-[16px] font-medium text-foreground">{formatGBP(owed(booking))}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {paymentChoices(booking).map((choice) => (
                      <Button
                        key={choice.key}
                        variant="key"
                        className="h-14"
                        onClick={() => add(booking, choice.key, choice.amount)}
                        aria-label={`${choice.label} ${formatGBP(choice.amount)} for ${booking.name}`}
                      >
                        {choice.label}
                        <span className="tnum font-sans text-[15px] font-medium tracking-normal normal-case">
                          {formatGBP(choice.amount)}
                        </span>
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetBody>
      <SheetFooter>
        <Button variant="text" render={<Link to="/counter/bookings" />}>
          Open bookings
        </Button>
      </SheetFooter>
    </>
  )
}
