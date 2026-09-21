import { QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, Link, Outlet, redirect } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/components/theme-provider"
import { lockedRedirect } from "@/features/auth/gate"
import { currentStaff } from "@/lib/auth"
import { queryClient } from "@/lib/query"

function RootLayout() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

function NotFound() {
  return (
    <main className="mx-auto w-full max-w-[1040px] px-5 pt-24 pb-16 sm:px-10">
      <PageTitle>Nothing here</PageTitle>
      <Lede>
        That address does not match a screen. Go back to the counter and try again.
      </Lede>
      <div className="mt-10">
        <Button render={<Link to="/counter" />} trailingArrow>
          Back to the counter
        </Button>
      </div>
    </main>
  )
}

export const Route = createRootRoute({
  /**
   * The password gate, for every screen at once.
   *
   * A staff account still carrying `must_change_password` may see one
   * screen, `/counter/password`, and the guard sits here rather than on
   * `/counter` so that `/display`, `/labels/print` and anything added
   * later inherit it without asking. It is inert for everybody else:
   * `currentStaff` is null for a customer token and for nobody signed in,
   * and `lockedRedirect` returns null for an unlocked staff member and
   * for the password screen itself, so nothing else on any route changes.
   * The server refuses the same account anyway (`pb_hooks/staff.pb.js`);
   * this is what keeps the counter from asking.
   */
  beforeLoad: ({ location }) => {
    const locked = lockedRedirect(currentStaff(), location.pathname)
    if (locked) throw redirect({ to: locked })
  },
  component: RootLayout,
  notFoundComponent: NotFound,
})
