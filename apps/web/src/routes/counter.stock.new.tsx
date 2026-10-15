import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AddStockScreen } from "@/features/stock/AddStockScreen"

const searchSchema = z.object({
  /** A card chosen in the command palette, as its set code and number. */
  set: z.string().optional(),
  number: z.string().optional(),
  /** A retail barcode scanned on another screen. */
  ean: z.string().optional(),
  /**
   * Add more of this on the item page: the SKU of the stock row to fill the
   * form from (docs/api-contract-reorder.md, section 4.3).
   */
  from: z.string().min(1).optional().catch(undefined),
})

function AddStock() {
  const { set, number, ean, from } = Route.useSearch()
  return (
    <AddStockScreen
      // A second Add more of this from the same screen starts a fresh form.
      key={from ?? "new"}
      initialSet={set}
      initialNumber={number}
      initialEan={ean}
      fromSku={from}
    />
  )
}

export const Route = createFileRoute("/counter/stock/new")({
  validateSearch: searchSchema,
  component: AddStock,
})
