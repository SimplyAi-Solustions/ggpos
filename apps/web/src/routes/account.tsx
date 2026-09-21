import { createFileRoute, redirect } from "@tanstack/react-router"

import { PortalShell } from "@/features/portal/PortalShell"
import { currentCustomerId } from "@/features/portal/session"

/**
 * My Vault, the customer portal.
 *
 * The front door at `/account` is the sign-in screen when nobody is signed
 * in, so every other screen under it can assume a session. A signed-out visit
 * to one of those is bounced to the front door carrying where it was going.
 */
export const Route = createFileRoute("/account")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/account" || location.pathname === "/account/") return
    if (!currentCustomerId()) {
      throw redirect({ to: "/account", search: { next: location.pathname } })
    }
  },
  component: PortalShell,
})
