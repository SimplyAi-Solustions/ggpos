import { createFileRoute, redirect } from "@tanstack/react-router"
import { z } from "zod"

/**
 * The old Sell screen's address. The till replaced it (docs/EPOS-PLAN.md,
 * "The till screen"), so anything still pointing here, a bookmark, the
 * Scan screen's voucher sheet or the item page's "Sell", lands on the till
 * with its voucher intact.
 */
const searchSchema = z.object({
  voucher: z.string().optional(),
})

export const Route = createFileRoute("/counter/sell")({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/counter/till",
      search: search.voucher ? { voucher: search.voucher } : {},
      replace: true,
    })
  },
})
