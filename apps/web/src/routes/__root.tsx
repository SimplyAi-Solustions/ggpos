import { QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, Link, Outlet } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/components/theme-provider"
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
  component: RootLayout,
  notFoundComponent: NotFound,
})
