import { createFileRoute } from "@tanstack/react-router"

import { GuildScreen } from "@/features/portal/GuildScreen"

export const Route = createFileRoute("/account/guild")({
  component: GuildScreen,
})
