import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { BookingsScreen, type BookingsView } from "@/features/bookings/BookingsScreen"

const searchSchema = z.object({
  /** A shop-time date, "2026-10-16"; today when left out. */
  date: z.string().optional(),
  view: z.enum(["day", "week", "events"]).optional(),
})

function Bookings() {
  const { date, view } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <BookingsScreen
      date={date}
      view={view ?? "day"}
      onNavigate={(next: { date?: string; view?: BookingsView }) =>
        void navigate({ search: (current) => ({ ...current, ...next }), replace: true })
      }
    />
  )
}

export const Route = createFileRoute("/counter/bookings")({
  validateSearch: searchSchema,
  component: Bookings,
})
