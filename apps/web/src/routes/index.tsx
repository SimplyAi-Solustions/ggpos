import { createFileRoute, redirect } from "@tanstack/react-router"

import { currentStaff } from "@/lib/auth"

/** The front door: the counter when someone is signed in, otherwise sign-in. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: currentStaff() ? "/counter" : "/login" })
  },
})
