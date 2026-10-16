import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TillScreen } from "@/features/till/TillScreen"

const searchSchema = z.object({
  /** A GGV code handed over by the Scan screen's voucher sheet. */
  voucher: z.string().optional(),
})

function Till() {
  const { voucher } = Route.useSearch()
  return <TillScreen voucher={voucher} />
}

export const Route = createFileRoute("/counter/till")({
  validateSearch: searchSchema,
  component: Till,
})
