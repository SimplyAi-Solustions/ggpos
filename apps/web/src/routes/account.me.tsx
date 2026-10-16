import { createFileRoute } from "@tanstack/react-router"

import { ProfileScreen } from "@/features/portal/ProfileScreen"

export const Route = createFileRoute("/account/me")({
  component: ProfileScreen,
})
