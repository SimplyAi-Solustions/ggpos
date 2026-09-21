import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { SellScreen } from "@/features/sell/SellScreen"

const searchSchema = z.object({
  /** A GGV code handed over by the Scan screen's voucher sheet. */
  voucher: z.string().optional(),
})

function Sell() {
  const { voucher } = Route.useSearch()
  return <SellScreen voucher={voucher} />
}

export const Route = createFileRoute("/counter/sell")({
  validateSearch: searchSchema,
  component: Sell,
})
