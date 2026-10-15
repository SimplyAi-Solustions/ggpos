import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ReorderScreen, type ReorderSearch } from "@/features/reorder/ReorderScreen"
import { RACK_VIEW_KEYS } from "@/features/reorder/rack"

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * The supplier call (docs/api-contract-reorder.md, section 4.2). Every
 * part is in the address, so a call can be bookmarked or sent: the
 * supplier, the period (the last seven days when left out) and the rack's
 * chip. Anything malformed is dropped rather than refused, so an old link
 * still lands on the screen.
 */
const searchSchema = z.object({
  supplier: z.string().min(1).optional().catch(undefined),
  from: day.optional().catch(undefined),
  to: day.optional().catch(undefined),
  view: z.enum(RACK_VIEW_KEYS).optional().catch(undefined),
})

function Reorder() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ReorderScreen
      search={search}
      onNavigate={(next: Partial<ReorderSearch>) =>
        void navigate({ search: (current) => ({ ...current, ...next }), replace: true })
      }
    />
  )
}

export const Route = createFileRoute("/counter/reports/reorder")({
  validateSearch: searchSchema,
  component: Reorder,
})
