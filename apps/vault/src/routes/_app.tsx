import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"

import { currentStaff } from "@/lib/auth"
import { AppShell } from "@/shell/AppShell"

/** Every screen but /login sits under this guard and the shell. */
export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (!currentStaff()) {
      throw redirect({ to: "/login", search: { redirect: location.href } })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
