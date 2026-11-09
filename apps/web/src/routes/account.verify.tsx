import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { VerifyEmailScreen } from "@/features/portal/EmailLinkScreens"

export const Route = createFileRoute("/account/verify")({
  validateSearch: z.object({ token: z.string().optional() }),
  component: function VerifyRoute() {
    const { token } = Route.useSearch()
    return <VerifyEmailScreen token={token} />
  },
})
