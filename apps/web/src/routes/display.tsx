import { createFileRoute, redirect } from "@tanstack/react-router"

import { DisplayScreen } from "@/features/display/DisplayScreen"
import { currentStaff } from "@/lib/auth"

/**
 * The customer-facing tablet. It signs in as staff once and stays on this
 * address, so an unsigned visit is bounced to sign-in carrying where it was
 * going, exactly as /counter is.
 */
export const Route = createFileRoute("/display")({
  beforeLoad: ({ location }) => {
    if (!currentStaff()) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: DisplayScreen,
})
