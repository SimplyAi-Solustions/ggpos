/**
 * Which price labels a sheet prints, and how many of each.
 *
 * The item page asks for one; the stock list asks for one per unit on each
 * ticked row; Add stock asks for one per unit that came in. Staff can change
 * any count before printing. A row with no price has nothing to print.
 */

export interface PriceLabelItem {
  id: string
  sku: string
  title: string
  /** Pence. */
  price: number
  /** How many labels the sheet starts on. */
  copies: number
}

/** The most labels of one item a sheet offers. A roll of 12 x 40 mm is 160. */
export const MAX_COPIES = 160

export function startingCopies(qty: number | null | undefined): number {
  const units = Math.floor(Number(qty) || 0)
  return Math.min(MAX_COPIES, Math.max(1, units))
}

export function hasPrice(item: Pick<PriceLabelItem, "price">): boolean {
  return Number.isFinite(item.price) && item.price > 0
}

/** The rows that will print, with their counts, in the order shown. */
export function printableRows(
  items: readonly PriceLabelItem[],
  copies: Readonly<Record<string, number | "">>
): { item: PriceLabelItem; copies: number }[] {
  const rows: { item: PriceLabelItem; copies: number }[] = []
  for (const item of items) {
    if (!hasPrice(item)) continue
    const count = copies[item.id] ?? item.copies
    const n = count === "" ? 0 : Math.min(MAX_COPIES, Math.max(0, Math.floor(count)))
    if (n > 0) rows.push({ item, copies: n })
  }
  return rows
}

export function totalLabels(rows: readonly { copies: number }[]): number {
  return rows.reduce((sum, row) => sum + row.copies, 0)
}

/**
 * The counts left to print once `printed` labels have come out of `rows`,
 * in order, keyed by item id. The printer reports an item's labels once all
 * of them are out, so a row it stopped part way through is left whole: a
 * label too many beats a gap on the shelf.
 */
export function remainingAfter(
  rows: readonly { item: Pick<PriceLabelItem, "id">; copies: number }[],
  printed: number
): Record<string, number | ""> {
  const left: Record<string, number | ""> = {}
  let out = printed
  for (const row of rows) {
    if (out >= row.copies) {
      left[row.item.id] = ""
      out -= row.copies
    } else {
      left[row.item.id] = row.copies
      out = 0
    }
  }
  return left
}

/** "Print 1 label", "Print 12 labels". */
export function printLabelText(total: number): string {
  return total === 1 ? "Print 1 label" : `Print ${total} labels`
}
