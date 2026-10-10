import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { AddStockScreen } from "@/features/stock/AddStockScreen"

const searchSchema = z.object({
  /** A card chosen in the command palette, as its set code and number. */
  set: z.string().optional(),
  number: z.string().optional(),
  /** A retail barcode scanned on another screen. */
  ean: z.string().optional(),
})

function AddStock() {
  const { set, number, ean } = Route.useSearch()
  return <AddStockScreen initialSet={set} initialNumber={number} initialEan={ean} />
}

export const Route = createFileRoute("/counter/stock/new")({
  validateSearch: searchSchema,
  component: AddStock,
})
