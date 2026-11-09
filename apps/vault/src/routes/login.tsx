import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"

import { LoginPage, safeRedirect } from "@/features/auth"
import { currentStaff } from "@/lib/auth"

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: ({ search }) => {
    if (currentStaff()) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: Login,
})

function Login() {
  const router = useRouter()
  const { redirect: target } = Route.useSearch()
  return <LoginPage onSignedIn={() => void router.history.push(safeRedirect(target))} />
}
