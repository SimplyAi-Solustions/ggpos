import { createRootRoute, Link, Outlet } from "@tanstack/react-router"

import { buttonClasses, EmptyState } from "@/ui"

export const Route = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        title="Page not found"
        action={
          <Link to="/scan" className={buttonClasses("primary")}>
            Go to Scan
          </Link>
        }
      >
        That address is not part of the Vault. Check the link or start from Scan.
      </EmptyState>
    </div>
  )
}
