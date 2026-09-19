import { createFileRoute, redirect } from "@tanstack/react-router"

import { CounterShell } from "@/app/counter-shell"
import { currentStaff } from "@/lib/auth"

/**
 * Everything under /counter is staff-only. An unsigned visit is bounced to
 * sign-in carrying where it was going, so the sign-in returns them to it.
 */
export const Route = createFileRoute("/counter")({
  beforeLoad: ({ location }) => {
    if (!currentStaff()) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: CounterShell,
})
