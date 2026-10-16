import { createFileRoute } from "@tanstack/react-router"

import { StaffScreen } from "@/features/staff/StaffScreen"

/** Admin only; anybody else gets one line saying so. */
export const Route = createFileRoute("/counter/staff")({
  component: StaffScreen,
})
