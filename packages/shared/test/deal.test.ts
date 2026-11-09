import { describe, expect, it } from "vitest"
import { allocatePence } from "../src/money"
import {
  DEFAULT_DEAL_RATES,
  computeDeal,
  dealLine,
  dealPayout,
  effectivePct,
  payoutLines,
  splitDeal,
  type DealLineInput,
} from "../src/deal"

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe("allocatePence", () => {
  it("sums to the total exactly with single units", () => {
    const parts = allocatePence(6000, [3333, 3333, 3334])
    expect(sum(parts)).toBe(6000)
    expect(parts).toEqual([2000, 2000, 2000])
  })

  it("gives leftover pennies to the largest remainders, earlier line on a tie", () => {
    expect(allocatePence(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocatePence(2, [1, 1, 1])).toEqual([1, 1, 0])
    expect(allocatePence(10, [1, 2])).toEqual([3, 7])
  })

  it("is deterministic", () => {
    const weights = [1999, 451, 77, 12345, 1]
    expect(allocatePence(5681, weights)).toEqual(allocatePence(5681, weights))
    expect(sum(allocatePence(5681, weights))).toBe(5681)
  })

  it("keeps one price per unit on a multi-unit line", () => {
    const parts = allocatePence(1001, [500, 500], [2, 1])
    expect(sum(parts)).toBe(1001)
    expect((parts[0] as number) % 2).toBe(0)
  })

  it("never goes over the total when no line can take the last penny", () => {
    const parts = allocatePence(101, [1, 1], [2, 2])
    expect(sum(parts)).toBeLessThanOrEqual(101)
    expect(sum(parts)).toBe(100)
  })

  it("shares equally when every weight is zero, and gives zeros for nothing", () => {
    expect(allocatePence(9, [0, 0, 0])).toEqual([3, 3, 3])
    expect(allocatePence(0, [5, 5])).toEqual([0, 0])
    expect(allocatePence(-5, [5, 5])).toEqual([0, 0])
    expect(allocatePence(100, [])).toEqual([])
  })

  it("holds across many random cases", () => {
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let n = 0; n < 500; n++) {
      const count = 1 + (next() % 8)
      const weights = Array.from({ length: count }, () => next() % 100000)
      const total = next() % 1000000
      const parts = allocatePence(total, weights)
      expect(sum(parts)).toBe(total)
      expect(parts.every((part) => part >= 0)).toBe(true)
    }
  })
})

describe("sweep rates", () => {
  it("values each card at 80% trade and 70% cash by default", () => {
    const line = dealLine({ marketPence: 1000, qty: 1 }, DEFAULT_DEAL_RATES)
    expect(line.trade).toBe(800)
    expect(line.cash).toBe(700)
    expect(line.tradeCustom).toBe(false)
  })

  it("rounds half-up per unit and multiplies by quantity", () => {
    const line = dealLine({ marketPence: 333, qty: 3 }, { tradePct: 80, cashPct: 70 })
    // 266.4 -> 266 and 233.1 -> 233, per unit
    expect(line.trade).toBe(798)
    expect(line.cash).toBe(699)
    expect(line.market).toBe(999)
  })

  it("moves every line when the sweep moves", () => {
    const lines: DealLineInput[] = [
      { marketPence: 5000, qty: 1 },
      { marketPence: 2500, qty: 2 },
    ]
    const deal = computeDeal(lines, { tradePct: 85, cashPct: 60 })
    expect(deal.trade).toBe(4250 + 4250)
    expect(deal.cash).toBe(3000 + 3000)
    expect(deal.tradeOverridden).toBe(false)
  })
})

describe("per-card override", () => {
  it("uses the card's own rate on one side and the sweep on the other", () => {
    const deal = computeDeal(
      [
        { marketPence: 10000, qty: 1, tradePct: 75 },
        { marketPence: 10000, qty: 1 },
      ],
      DEFAULT_DEAL_RATES
    )
    expect(deal.lines[0]?.trade).toBe(7500)
    expect(deal.lines[0]?.tradeCustom).toBe(true)
    expect(deal.lines[0]?.cash).toBe(7000)
    expect(deal.lines[0]?.cashCustom).toBe(false)
    expect(deal.lines[1]?.trade).toBe(8000)
    expect(deal.trade).toBe(15500)
  })

  it("keeps the card's rate when the sweep changes", () => {
    const deal = computeDeal(
      [{ marketPence: 10000, qty: 1, cashPct: 50 }],
      { tradePct: 90, cashPct: 75 }
    )
    expect(deal.lines[0]?.cash).toBe(5000)
    expect(deal.lines[0]?.trade).toBe(9000)
  })

  it("leaves a fixed figure alone whatever the rate", () => {
    const deal = computeDeal(
      [{ marketPence: 2000, qty: 1, fixedTrade: 2000, fixedCash: 2000 }],
      { tradePct: 10, cashPct: 10 }
    )
    expect(deal.trade).toBe(2000)
    expect(deal.cash).toBe(2000)
    expect(deal.lines[0]?.fixed).toBe(true)
  })
})

describe("splitDeal", () => {
  it("matches the owner's example", () => {
    expect(splitDeal(10000, 8750, 3500)).toEqual({ cash: 3500, credit: 6000 })
  })

  it("caps the cash at the cash total", () => {
    expect(splitDeal(10000, 8750, 99999)).toEqual({ cash: 8750, credit: 0 })
  })

  it("gives all credit when no cash is taken", () => {
    expect(splitDeal(10000, 8750, 0)).toEqual({ cash: 0, credit: 10000 })
    expect(splitDeal(10000, 8750, -50)).toEqual({ cash: 0, credit: 10000 })
  })

  it("rounds the credit half-up to the penny", () => {
    // 10001 * (7000 - 1) / 7000 = 9999.57...
    expect(splitDeal(10001, 7000, 1).credit).toBe(10000)
    expect(splitDeal(1000, 300, 100).credit).toBe(667)
  })

  it("is all credit when there is no cash total", () => {
    expect(splitDeal(500, 0, 100)).toEqual({ cash: 0, credit: 500 })
  })
})

describe("dealPayout", () => {
  const deal = { trade: 10000, cash: 8750 }
  it("pays credit, cash or the split", () => {
    expect(dealPayout("credit", deal, 0)).toEqual({ type: "credit", cash: 0, credit: 10000 })
    expect(dealPayout("cash", deal, 0)).toEqual({ type: "cash", cash: 8750, credit: 0 })
    expect(dealPayout("mixed", deal, 3500)).toEqual({ type: "mixed", cash: 3500, credit: 6000 })
  })
  it("says credit when a split takes no cash, and cash when it takes it all", () => {
    expect(dealPayout("mixed", deal, 0).type).toBe("credit")
    expect(dealPayout("mixed", deal, 8750)).toEqual({ type: "cash", cash: 8750, credit: 0 })
  })
  it("keeps any cash at all as cash, however small, so the ID gate sees it", () => {
    expect(dealPayout("mixed", deal, 1).cash).toBe(1)
  })
})

describe("final override", () => {
  const lines: DealLineInput[] = [
    { marketPence: 3001, qty: 1 },
    { marketPence: 2000, qty: 1 },
    { marketPence: 2100, qty: 1 },
  ]

  it("rescales every line pro rata to a keyed trade total, to the penny", () => {
    const deal = computeDeal(lines, DEFAULT_DEAL_RATES, { trade: { kind: "amount", pence: 6000 } })
    expect(deal.calculatedTrade).toBe(2401 + 1600 + 1680)
    expect(deal.trade).toBe(6000)
    expect(sum(deal.lines.map((line) => line.trade))).toBe(6000)
    expect(deal.tradeOverridden).toBe(true)
    // The cash side is untouched.
    expect(deal.cash).toBe(deal.calculatedCash)
    expect(deal.cashOverridden).toBe(false)
  })

  it("takes a final cash total on its own", () => {
    const deal = computeDeal(lines, DEFAULT_DEAL_RATES, { cash: { kind: "amount", pence: 5000 } })
    expect(deal.cash).toBe(5000)
    expect(sum(deal.lines.map((line) => line.cash))).toBe(5000)
    expect(deal.trade).toBe(deal.calculatedTrade)
  })

  it("takes a new percentage of market value", () => {
    const deal = computeDeal(lines, DEFAULT_DEAL_RATES, { trade: { kind: "pct", pct: 90 } })
    // 7101 * 0.9 = 6390.9 -> 6391
    expect(deal.trade).toBe(6391)
    expect(sum(deal.lines.map((line) => line.trade))).toBe(6391)
    expect(effectivePct(deal.trade, deal.market)).toBe(90)
  })

  it("can go down as well as up", () => {
    const deal = computeDeal(lines, DEFAULT_DEAL_RATES, { trade: { kind: "amount", pence: 5681 } })
    expect(deal.trade).toBe(5681)
  })

  it("spreads over market value when nothing was calculated", () => {
    const deal = computeDeal(
      [
        { marketPence: 100, qty: 1, tradePct: 0 },
        { marketPence: 300, qty: 1, tradePct: 0 },
      ],
      DEFAULT_DEAL_RATES,
      { trade: { kind: "amount", pence: 400 } }
    )
    expect(deal.lines.map((line) => line.trade)).toEqual([100, 300])
  })

  it("does nothing on an empty deal", () => {
    const deal = computeDeal([], DEFAULT_DEAL_RATES, { trade: { kind: "amount", pence: 500 } })
    expect(deal.trade).toBe(0)
    expect(deal.tradeOverridden).toBe(false)
  })
})

describe("effectivePct", () => {
  it("is the figure over market to one decimal place", () => {
    expect(effectivePct(5681, 7101)).toBe(80)
    expect(effectivePct(6000, 7101)).toBe(84.5)
    expect(effectivePct(100, 0)).toBe(0)
  })
})

describe("payoutLines", () => {
  const inputs: DealLineInput[] = [
    { marketPence: 5000, qty: 1 },
    { marketPence: 2500, qty: 2 },
    { marketPence: 1333, qty: 1 },
  ]
  const qtys = inputs.map((line) => line.qty)

  it("records the trade figures for credit and the cash figures for cash", () => {
    const deal = computeDeal(inputs, DEFAULT_DEAL_RATES)
    const credit = payoutLines(deal, qtys, dealPayout("credit", deal, 0))
    expect(credit.perUnit).toEqual([4000, 2000, 1066])
    const cash = payoutLines(deal, qtys, dealPayout("cash", deal, 0))
    expect(cash.perUnit).toEqual([3500, 1750, 933])
  })

  it("makes a split's lines add up to cash plus credit exactly", () => {
    const deal = computeDeal(inputs, DEFAULT_DEAL_RATES)
    const payout = dealPayout("mixed", deal, 3500)
    const { perUnit, payout: final } = payoutLines(deal, qtys, payout)
    const recorded = sum(perUnit.map((unit, i) => unit * (qtys[i] as number)))
    expect(recorded).toBe(final.cash + final.credit)
    expect(final.cash).toBe(3500)
  })

  it("keeps a rescaled total exact on the record", () => {
    const deal = computeDeal(inputs, DEFAULT_DEAL_RATES, { trade: { kind: "amount", pence: 9999 } })
    const { perUnit, payout } = payoutLines(deal, qtys, dealPayout("credit", deal, 0))
    expect(sum(perUnit.map((unit, i) => unit * (qtys[i] as number)))).toBe(9999)
    expect(payout.credit).toBe(9999)
  })

  it("trims credit by a penny the multi-unit lines cannot carry, never the cash", () => {
    const multi: DealLineInput[] = [
      { marketPence: 1000, qty: 2 },
      { marketPence: 1000, qty: 2 },
    ]
    const deal = computeDeal(multi, DEFAULT_DEAL_RATES)
    const payout = dealPayout("mixed", deal, 1001)
    const result = payoutLines(deal, [2, 2], payout)
    const recorded = sum(result.perUnit.map((unit) => unit * 2))
    expect(result.payout.cash).toBe(1001)
    expect(recorded).toBe(result.payout.cash + result.payout.credit)
  })
})
