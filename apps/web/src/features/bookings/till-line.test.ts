import { beforeEach, describe, expect, it } from "vitest"

import { bookingLine, putOnTicket } from "@/features/bookings/till-line"
import { saleLines, summarise } from "@/features/till/ticket"
import { configureTillStore, dispatchTill, getTill } from "@/features/till/till-store"

/**
 * A booking's payment on the till's ticket (section 4, "Paying"): one line
 * a booking, sent as `lines[].booking` with its own title and price.
 */

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

beforeEach(() => {
  configureTillStore({ register: "test", storage: memoryStorage() })
})

describe("a booking on the ticket", () => {
  it("goes on as one line at the amount being paid, standard rated", () => {
    const line = bookingLine({ bookingId: "b1", title: "Table 2, Fri 16 Oct 18:00, deposit", amount: 500 })
    expect(putOnTicket(line)).toBeNull()
    const ticket = getTill().ticket
    expect(ticket.lines).toHaveLength(1)
    expect(summarise(ticket).total).toBe(500)
    expect(ticket.lines[0]).toMatchObject({ bookingId: "b1", maxQty: 1, taxScheme: "standard", sku: "" })
  })

  it("is sent to the sale route as a booking line", () => {
    putOnTicket(bookingLine({ bookingId: "b1", title: "Table 2, Fri 16 Oct 18:00", amount: 800 }))
    expect(saleLines(getTill().ticket)).toEqual([
      { booking: "b1", qty: 1, unit_price: 800, discount: 0, title: "Table 2, Fri 16 Oct 18:00" },
    ])
  })

  it("is not put on twice", () => {
    putOnTicket(bookingLine({ bookingId: "b1", title: "Table 2", amount: 800 }))
    expect(putOnTicket(bookingLine({ bookingId: "b1", title: "Table 2", amount: 800 }))).toBe(
      "That booking is already on the ticket."
    )
    expect(getTill().ticket.lines).toHaveLength(1)
    // A different booking is a different line.
    expect(putOnTicket(bookingLine({ bookingId: "b2", title: "PC 1", amount: 400 }))).toBeNull()
    expect(getTill().ticket.lines).toHaveLength(2)
  })

  it("waits while the till is taking a payment", () => {
    putOnTicket(bookingLine({ bookingId: "b1", title: "Table 2", amount: 800 }))
    dispatchTill({ type: "pay" })
    expect(putOnTicket(bookingLine({ bookingId: "b2", title: "PC 1", amount: 400 }))).toBe(
      "The till is taking a payment. Finish it, then take this one."
    )
  })
})
