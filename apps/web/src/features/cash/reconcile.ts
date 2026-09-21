/**
 * Putting a SumUp transaction beside the sale it belongs to.
 *
 * The server matches what it can on a pull: a transaction whose products
 * name one of our SKUs, then a card sale of the same amount within three
 * minutes. What is left over is matched by hand here, and the order the
 * candidates are offered in is the same idea: the same amount first, then
 * whatever happened nearest in time.
 *
 * The amount compared is always the card share, never the sale total. A
 * mixed sale's total includes cash, store credit or points, none of which
 * ever reached SumUp (docs/api-contract.md, "Phase 4: exports, imports and
 * SumUp").
 */
import type { SumUpSale, SumUpTransaction } from "@/lib/api/types"

/** Whole minutes between two timestamps, always positive. */
export function minutesApart(left: string, right: string): number {
  const a = new Date(left).getTime()
  const b = new Date(right).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY
  return Math.abs(a - b) / 60_000
}

interface Side {
  amount: number
  at: string
}

/**
 * Sort candidates: an exact amount first, then nearest in time, then by the
 * amount they are out by, so the order is the same on every run.
 */
function rank<Row>(target: Side, rows: Row[], read: (row: Row) => Side): Row[] {
  return [...rows].sort((left, right) => {
    const a = read(left)
    const b = read(right)
    const exactA = a.amount === target.amount ? 0 : 1
    const exactB = b.amount === target.amount ? 0 : 1
    if (exactA !== exactB) return exactA - exactB
    const timeA = minutesApart(a.at, target.at)
    const timeB = minutesApart(b.at, target.at)
    if (timeA !== timeB) return timeA - timeB
    return Math.abs(a.amount - target.amount) - Math.abs(b.amount - target.amount)
  })
}

/** The sales worth offering for one unmatched transaction. */
export function salesForTransaction(
  transaction: SumUpTransaction,
  sales: SumUpSale[]
): SumUpSale[] {
  return rank(
    { amount: transaction.amount, at: transaction.timestamp },
    sales,
    (sale) => ({ amount: sale.card_share, at: sale.created ?? "" })
  )
}

/** The transactions worth offering for one unmatched sale. */
export function transactionsForSale(
  sale: SumUpSale,
  transactions: SumUpTransaction[]
): SumUpTransaction[] {
  return rank(
    { amount: sale.card_share, at: sale.created ?? "" },
    transactions,
    (transaction) => ({ amount: transaction.amount, at: transaction.timestamp })
  )
}

/** Why a candidate is where it is in the list, said in two or three words. */
export function candidateReason(target: Side, candidate: Side): string {
  if (candidate.amount === target.amount) return "Same amount"
  const apart = minutesApart(candidate.at, target.at)
  if (!Number.isFinite(apart)) return "No time on file"
  if (apart < 1) return "Same minute"
  return `${Math.round(apart)} ${Math.round(apart) === 1 ? "minute" : "minutes"} apart`
}

/**
 * What the difference between the two sides means, in words.
 *
 * Nothing here is a ledger entry: a difference is something to look into,
 * not something to post.
 */
export function differenceLine(sumup: number, sales: number): string {
  const difference = sumup - sales
  if (difference === 0) return "The two sides agree."
  return difference > 0
    ? "SumUp took more than the Vault has on file."
    : "The Vault has more card sales than SumUp took."
}
