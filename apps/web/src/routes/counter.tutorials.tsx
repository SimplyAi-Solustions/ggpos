import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TutorialsScreen } from "@/features/tutorials/TutorialsScreen"

const searchSchema = z.object({
  /**
   * The tutorial to open on, by its slug ("selling"). One the till does not
   * have opens the first instead, so an old link still lands on the page.
   */
  t: z.string().min(1).optional().catch(undefined),
})

/** The tutorial videos, for every member of staff. */
export const Route = createFileRoute("/counter/tutorials")({
  validateSearch: searchSchema,
  component: TutorialsScreen,
})
