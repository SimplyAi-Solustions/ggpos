import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { CardScreen } from "@/features/portal/CardScreen"
import { SignInScreen } from "@/features/portal/SignInScreen"
import { useCustomerSession } from "@/features/portal/session"

const searchSchema = z.object({
  /** Where the guard bounced them from, so sign-in puts them back. */
  next: z.string().optional(),
})

function AccountHome() {
  const { next } = Route.useSearch()
  const signedIn = useCustomerSession()
  return signedIn ? <CardScreen /> : <SignInScreen next={next} />
}

export const Route = createFileRoute("/account/")({
  validateSearch: searchSchema,
  component: AccountHome,
})
