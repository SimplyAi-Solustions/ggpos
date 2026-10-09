import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { CashScreen } from "@/features/cash/CashScreen"
import { CASH_ACTIONS } from "@/features/cash/actions"

const searchSchema = z.object({
  /**
   * The step to open on. The till's own menu links here for the X report,
   * cashing up, no sale and paid in or out, and the closed till's "Open the
   * till" with `open`. Anything else is ignored rather than refused, so an
   * old link still lands on the screen.
   */
  action: z.enum(CASH_ACTIONS).optional().catch(undefined),
  /** A saved X or Z report to show, from the history or straight after one. */
  report: z.string().min(1).optional().catch(undefined),
})

export const Route = createFileRoute("/counter/cash")({
  validateSearch: searchSchema,
  component: CashScreen,
})
