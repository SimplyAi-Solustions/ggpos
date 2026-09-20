import { describe, expect, it } from "vitest"

import {
  breakdown,
  cumNet,
  grossOf,
  pointsCum,
  refundAmount,
  remainingQty,
  spread,
  type SaleLineAsSold,
} from "../src/saleline"

/**
 * The counter's refund sheet and the server's refund route both read this, so
 * these lock down the properties the two have to agree on: the allocations sum
 * to the sale's discount exactly, the per-unit amounts sum to the line's net,
 * and any sequence of partial refunds adds up to what was taken and no more.
 */

function line(over: Partial<SaleLineAsSold> = {}): SaleLineAsSold {
  return { id: "l1", qty: 1, unitPrice: 1000, discount: 0, refundedQty: 0, ...over }
}

describe("gross", () => {
  it("is the unit price times the quantity, less the line's own discount", () => {
    expect(grossOf({ qty: 3, unitPrice: 1000, discount: 250 })).toBe(2750)
  })

  it("treats a quantity of zero as one, as the server does", () => {
    expect(grossOf({ qty: 0, unitPrice: 1000, discount: 0 })).toBe(1000)
  })
})

describe("spreading a sale-level discount", () => {
  it("gives the last entry the remainder, so the allocations sum exactly", () => {
    const grosses = [1000, 1000, 1000]
    const nets = spread(grosses, 100)
    const allocated = grosses.map((g, i) => g - (nets[i] as number))
    expect(allocated.reduce((a, b) => a + b, 0)).toBe(100)
    // 33.33 each rounds to 33, 33, and the last takes 34.
    expect(allocated).toEqual([33, 33, 34])
  })

  it("takes nothing off when there is no discount", () => {
    expect(spread([500, 700], 0)).toEqual([500, 700])
  })

  it("allocates nothing against a zero gross rather than dividing by it", () => {
    expect(spread([0, 0], 500)).toEqual([0, 0])
  })
})

describe("the breakdown of a sale", () => {
  const lines: SaleLineAsSold[] = [
    line({ id: "a", qty: 1, unitPrice: 4995, discount: 0 }),
    line({ id: "b", qty: 3, unitPrice: 1000, discount: 250 }),
    line({ id: "c", qty: 2, unitPrice: 349, discount: 0 }),
  ]

  it("nets out to the sale's total", () => {
    const result = breakdown(lines, 250)
    expect(result.gross).toBe(4995 + 2750 + 698)
    expect(result.net).toBe(result.gross - 250)
    expect(result.lines.reduce((sum, row) => sum + row.net, 0)).toBe(result.net)
  })

  it("puts each line's share on the line", () => {
    const result = breakdown(lines, 250)
    const allocated = result.lines.reduce((sum, row) => sum + row.allocation, 0)
    expect(allocated).toBe(250)
    expect(result.byId.a?.gross).toBe(4995)
    expect(result.byId.b?.qty).toBe(3)
  })

  it("leaves the lines alone when nothing was discounted", () => {
    const result = breakdown(lines, 0)
    expect(result.lines.every((row) => row.allocation === 0)).toBe(true)
    expect(result.net).toBe(result.gross)
  })
})

describe("what a refund comes to", () => {
  it("adds a line's units back up to its net, whatever order they go in", () => {
    const [row] = breakdown([line({ qty: 3, unitPrice: 1000, discount: 250 })], 100).lines
    expect(row).toBeDefined()
    const net = row!.net

    let refunded = 0
    let taken = 0
    for (const step of [1, 1, 1]) {
      taken += refundAmount({ ...row!, refundedQty: refunded }, step)
      refunded += step
    }
    expect(taken).toBe(net)
  })

  it("gives the same figure whether the units go back one at a time or together", () => {
    const [row] = breakdown([line({ qty: 4, unitPrice: 333, discount: 0 })], 77).lines
    const together = refundAmount(row!, 4)
    let apart = 0
    for (let n = 0; n < 4; n++) apart += refundAmount({ ...row!, refundedQty: n }, 1)
    expect(together).toBe(apart)
    expect(together).toBe(row!.net)
  })

  it("never gives back more than the line, however many are asked for", () => {
    const [row] = breakdown([line({ qty: 2, unitPrice: 500 })], 0).lines
    expect(refundAmount({ ...row!, refundedQty: 2 }, 5)).toBe(0)
    expect(refundAmount(row!, 99)).toBe(row!.net)
  })

  it("counts what is left on a line", () => {
    expect(remainingQty({ qty: 3, refundedQty: 1 })).toBe(2)
    expect(remainingQty({ qty: 3, refundedQty: 3 })).toBe(0)
  })

  it("covers a whole sale exactly, line by line", () => {
    const sale = breakdown(
      [
        line({ id: "a", qty: 1, unitPrice: 4995 }),
        line({ id: "b", qty: 3, unitPrice: 1000, discount: 250 }),
        line({ id: "c", qty: 2, unitPrice: 349 }),
      ],
      250
    )
    const paid = sale.lines.reduce((sum, row) => sum + refundAmount(row, row.qty), 0)
    expect(paid).toBe(sale.net)
  })
})

describe("cumulative net", () => {
  it("lands on the line's whole net at its quantity", () => {
    expect(cumNet(1000, 3, 3)).toBe(1000)
    expect(cumNet(1000, 3, 4)).toBe(1000)
    expect(cumNet(1000, 3, 0)).toBe(0)
    expect(cumNet(1000, 0, 1)).toBe(0)
  })

  it("rounds half-up on the way", () => {
    expect(cumNet(1000, 3, 1)).toBe(333)
    expect(cumNet(1000, 3, 2)).toBe(667)
  })
})

describe("points to reverse", () => {
  it("reverses the lot once the whole sale has gone back", () => {
    expect(pointsCum(325, 32499, 32499)).toBe(325)
    expect(pointsCum(325, 32499, 40000)).toBe(325)
  })

  it("reverses nothing before anything goes back", () => {
    expect(pointsCum(325, 32499, 0)).toBe(0)
    expect(pointsCum(0, 32499, 1000)).toBe(0)
    expect(pointsCum(325, 0, 1000)).toBe(0)
  })

  it("is cumulative, so a run of partial refunds reverses the sale once", () => {
    const earned = 325
    const total = 32499
    const first = pointsCum(earned, total, 10000)
    const second = pointsCum(earned, total, 32499) - first
    expect(first + second).toBe(earned)
  })
})
