import { createFileRoute } from "@tanstack/react-router"

import { SharedBinderScreen } from "@/features/binders/SharedBinderScreen"

function SharedBinder() {
  const { token } = Route.useParams()
  return <SharedBinderScreen key={token} token={token} />
}

/**
 * A customer's shared binder. Public and read only: the token in the link is
 * the only key, and the page never shows who owns the binder or any value.
 * It lives under /c/ so the PocketBase app shell (pb/pb_hooks/appshell.pb.js)
 * serves the customer page for it with no sign-in.
 */
export const Route = createFileRoute("/c/b/$token")({
  component: SharedBinder,
})
