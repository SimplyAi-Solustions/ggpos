import { createFileRoute } from "@tanstack/react-router"

import { BookScreen } from "@/features/portal/BookScreen"

export const Route = createFileRoute("/account/bookings")({
  component: BookScreen,
})
