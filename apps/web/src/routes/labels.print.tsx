import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { PrintPage } from "@/features/labels/PrintPage"

const searchSchema = z.object({
  /** Comma-separated `label_jobs` ids, in the order they should print. */
  jobs: z.string().default(""),
  /** 0 holds the print dialog back, for screenshots and the e2e suite. */
  print: z.coerce.number().default(1),
})

function LabelsPrint() {
  const { jobs, print } = Route.useSearch()
  return <PrintPage jobs={jobs} autoPrint={print !== 0} />
}

export const Route = createFileRoute("/labels/print")({
  validateSearch: searchSchema,
  component: LabelsPrint,
})
