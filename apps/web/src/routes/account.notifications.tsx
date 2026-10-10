import { createFileRoute } from "@tanstack/react-router"

import { NotificationsScreen } from "@/features/portal/NotificationsScreen"

export const Route = createFileRoute("/account/notifications")({
  component: NotificationsScreen,
})
