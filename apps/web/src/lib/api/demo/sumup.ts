/**
 * The demo shop's SumUp day.
 *
 * Three card sales rung through the shop and three transactions on SumUp's
 * side, deliberately not lining up: one pair matches, one transaction has no
 * sale behind it, and one card sale never reached SumUp. That is the whole
 * point of the screen, so the demo has to show it.
 *
 * The mixed sale is the one that matters most: its total is £30.00 but only
 * £12.00 of it went through the card reader, so the card takings compare on
 * `card_share`, never on `total`.
 */
import type {
  SumUpPullResult,
  SumUpReconcile,
  SumUpSale,
  SumUpTransaction,
} from "@/lib/api/types"

function at(hour: number, minute: number, date: string): string {
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`
}

const matchedByHand = new Map<string, string>()

function transactions(date: string): SumUpTransaction[] {
  return [
    {
      id: "sumup_tx_1",
      sumup_id: "TXN-8841",
      transaction_code: "TEHY8841",
      amount: 4745,
      timestamp: at(9, 42, date),
      status: "SUCCESSFUL",
    },
    {
      id: "sumup_tx_2",
      sumup_id: "TXN-8842",
      transaction_code: "TEHY8842",
      amount: 1200,
      timestamp: at(11, 18, date),
      status: "SUCCESSFUL",
    },
    {
      id: "sumup_tx_3",
      sumup_id: "TXN-8843",
      transaction_code: "TEHY8843",
      amount: 899,
      timestamp: at(15, 4, date),
      status: "SUCCESSFUL",
    },
  ]
}

function sales(date: string): SumUpSale[] {
  return [
    {
      id: "sale_demo_1",
      number: "GG-S-000455",
      total: 4745,
      card_share: 4745,
      payment: "sumup_card",
      created: at(9, 41, date),
    },
    {
      id: "sale_demo_3",
      number: "GG-S-000457",
      total: 3000,
      // A mixed sale: £18.00 in cash, £12.00 on the card reader.
      card_share: 1200,
      payment: "mixed",
      created: at(11, 17, date),
    },
    {
      id: "sale_demo_4",
      number: "GG-S-000458",
      total: 2250,
      card_share: 2250,
      payment: "sumup_card",
      created: at(16, 30, date),
    },
  ]
}

export function reconcile(date: string): SumUpReconcile {
  const all = transactions(date)
  const everySale = sales(date)

  const pairs: { transaction: SumUpTransaction; sale: SumUpSale }[] = []
  const usedTransactions = new Set<string>()
  const usedSales = new Set<string>()

  // The one the server's own rule would have matched: same amount, inside
  // three minutes of each other.
  const first = all[0]
  const firstSale = everySale[0]
  if (first && firstSale) {
    pairs.push({ transaction: first, sale: firstSale })
    usedTransactions.add(first.id)
    usedSales.add(firstSale.id)
  }

  for (const [transactionId, saleId] of matchedByHand) {
    const transaction = all.find((row) => row.id === transactionId)
    const sale = everySale.find((row) => row.id === saleId)
    if (transaction && sale && !usedTransactions.has(transactionId) && !usedSales.has(saleId)) {
      pairs.push({ transaction, sale })
      usedTransactions.add(transactionId)
      usedSales.add(saleId)
    }
  }

  const unmatchedTransactions = all.filter((row) => !usedTransactions.has(row.id))
  const unmatchedSales = everySale.filter((row) => !usedSales.has(row.id))

  const sumup = all.reduce((carry, row) => carry + row.amount, 0)
  const salesTotal = everySale.reduce((carry, row) => carry + row.card_share, 0)

  return {
    date,
    matched: pairs,
    unmatched_transactions: unmatchedTransactions,
    unmatched_sales: unmatchedSales,
    totals: { sumup, sales: salesTotal, difference: sumup - salesTotal },
  }
}

export function pull(): SumUpPullResult {
  return { fetched: 3, matched: 1 + matchedByHand.size, unmatched: 2 - matchedByHand.size, refunded: 0 }
}

export function match(transactionId: string, saleId: string): void {
  matchedByHand.set(transactionId, saleId)
}
