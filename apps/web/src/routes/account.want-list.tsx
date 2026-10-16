import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * The path the server's own want-list notifications link to.
 *
 * `lib/wants.js` writes `link: "/account/want-list"` on every match and every
 * released hold (docs/api-contract.md, Phase 5), while the portal's bottom
 * bar calls the screen "Wants" and lives at `/account/wants`. Rather than
 * having two names for one screen in the nav, this redirects, so a
 * notification and a tab both land in the same place.
 */
export const Route = createFileRoute("/account/want-list")({
  beforeLoad: () => {
    throw redirect({ to: "/account/wants", replace: true })
  },
})
