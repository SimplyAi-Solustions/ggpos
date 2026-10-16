/**
 * A booking's payment on the till's ticket (docs/api-contract-launch.md,
 * section 4, "Paying"): a deposit, a balance, a station session's charge or
 * an event entry goes on as one line carrying the booking, which the sale
 * route takes as `lines[].booking`, marks paid and confirms.
 *
 * The ticket lives outside React (`features/till/till-store.ts`), so the
 * day view, the event sheet and the till's own Bookings sheet all put a
 * line on it the same way, and the till finds it there when it opens.
 */
import { NO_ADJUSTMENT, type TicketLine } from "@/features/till/ticket"
import { dispatchTill, getTill } from "@/features/till/till-store"
import { getCustomerForSale } from "@/lib/api"

let minted = 0

/** The line for one payment towards one booking. */
export function bookingLine(input: { bookingId: string; title: string; amount: number }): TicketLine {
  minted += 1
  const amount = Math.max(0, Math.round(input.amount))
  return {
    key: `booking_${input.bookingId}_${Date.now().toString(36)}_${minted}`,
    itemId: null,
    productId: null,
    productKind: null,
    bookingId: input.bookingId,
    sku: "",
    title: input.title,
    detail: "",
    kind: "product",
    condition: "",
    platform: "other",
    unitPrice: amount,
    listPrice: amount,
    openPrice: false,
    qty: 1,
    maxQty: 1,
    game: null,
    // Table time, a station and an event entry are services the shop
    // supplies, standard rated; VAT only shows once the shop is registered.
    taxScheme: "standard",
    vatRate: 20,
    discount: NO_ADJUSTMENT,
    note: "",
  }
}

/**
 * Puts the line on the ticket. Answers the sentence to show when it cannot
 * go on, or null once it is there.
 */
export function putOnTicket(line: TicketLine): string | null {
  const till = getTill()
  if (till.phase === "paying") {
    return "The till is taking a payment. Finish it, then take this one."
  }
  const lines = till.phase === "done" ? [] : till.ticket.lines
  if (line.bookingId && lines.some((row) => row.bookingId === line.bookingId)) {
    return "That booking is already on the ticket."
  }
  dispatchTill({ type: "add", line })
  return null
}

/**
 * The booking's customer onto a ticket that has nobody yet, so the sale's
 * points and the Guild price are theirs. Staff can take them off.
 */
export async function attachBookingCustomer(code: string | undefined): Promise<void> {
  if (!code) return
  const till = getTill()
  if (till.phase !== "ticket" || till.ticket.customer) return
  try {
    const customer = await getCustomerForSale(code)
    const now = getTill()
    if (customer && now.phase === "ticket" && !now.ticket.customer) {
      dispatchTill({ type: "attachCustomer", customer })
    }
  } catch {
    // The line is on; the customer can be scanned by hand.
  }
}
