import { createFileRoute, redirect } from "@tanstack/react-router"

/** The front door: straight to Scan (the _app guard sends a signed-out visitor to /login). */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/scan" })
  },
})
