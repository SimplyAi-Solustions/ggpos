import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { StockListScreen } from "@/features/stock/StockListScreen"
import type { ItemStatus } from "@/lib/api/types"

const searchSchema = z.object({
  /**
   * Which filter the list opens on. Home's waiting line links here with
   * `reserved`, so "3 holds end today" lands on the holds themselves rather
   * than on the shelf.
   */
  status: z
    .enum(["in_stock", "reserved", "sold", "listed_ebay"])
    .optional(),
})

function StockList() {
  const { status } = Route.useSearch()
  return <StockListScreen initialStatus={(status as ItemStatus) ?? "in_stock"} />
}

export const Route = createFileRoute("/counter/stock/")({
  validateSearch: searchSchema,
  component: StockList,
})
