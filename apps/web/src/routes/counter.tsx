import { createFileRoute, redirect } from "@tanstack/react-router"

import { CounterShell } from "@/app/counter-shell"
import { LockedShell } from "@/features/auth/LockedShell"
import { isLocked, lockedRedirect } from "@/features/auth/gate"
import { currentStaff, useStaff } from "@/lib/auth"

/**
 * Everything under /counter is staff-only. An unsigned visit is bounced to
 * sign-in carrying where it was going, so the sign-in returns them to it.
 *
 * A signed-in staff member whose account still carries
 * `must_change_password` is bounced again, to `/counter/password`, and gets
 * the bare `LockedShell` around it: no nav, no palette, no shortcuts, no
 * scan listener and no idle lock until they have set a password of their
 * own. The root route runs the same `lockedRedirect` for every screen in
 * the app, `/display` and `/labels/print` included; it is repeated here
 * because this is the subtree the lock exists for, and because the shell
 * swap below has to ask the same question anyway.
 */
function CounterRoute() {
  const staff = useStaff()
  return isLocked(staff) ? <LockedShell /> : <CounterShell />
}

export const Route = createFileRoute("/counter")({
  beforeLoad: ({ location }) => {
    const staff = currentStaff()
    if (!staff) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
    const locked = lockedRedirect(staff, location.pathname)
    if (locked) throw redirect({ to: locked })
  },
  component: CounterRoute,
})
