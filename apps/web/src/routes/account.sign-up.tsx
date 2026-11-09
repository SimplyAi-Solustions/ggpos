import { createFileRoute, redirect } from "@tanstack/react-router"

import { SignUpScreen } from "@/features/portal/SignUpScreen"
import { currentCustomerId } from "@/features/portal/session"

/** Online sign-up. Somebody already signed in goes straight to their account. */
export const Route = createFileRoute("/account/sign-up")({
  beforeLoad: () => {
    if (currentCustomerId()) throw redirect({ to: "/account" })
  },
  component: SignUpScreen,
})
