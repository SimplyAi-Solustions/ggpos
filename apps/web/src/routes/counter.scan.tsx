import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ScanScreen } from "@/features/scan/ScanScreen"

const searchSchema = z.object({
  /** A code another screen could not place, handed over to be explained here. */
  code: z.string().optional(),
})

function Scan() {
  const { code } = Route.useSearch()
  return <ScanScreen incoming={code} />
}

export const Route = createFileRoute("/counter/scan")({
  validateSearch: searchSchema,
  component: Scan,
})
