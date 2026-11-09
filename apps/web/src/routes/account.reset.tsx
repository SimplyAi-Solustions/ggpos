import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { ResetPasswordScreen } from "@/features/portal/EmailLinkScreens"

export const Route = createFileRoute("/account/reset")({
  validateSearch: z.object({ token: z.string().optional() }),
  component: function ResetRoute() {
    const { token } = Route.useSearch()
    return <ResetPasswordScreen token={token} />
  },
})
