import { createFileRoute } from "@tanstack/react-router"

import { PasswordScreen } from "@/features/auth/PasswordScreen"

/**
 * The one screen a staff member locked to a password change may see, and
 * the same screen anybody else opens from their own menu. The `/counter`
 * route's guard sends a locked account here and keeps it here; nothing
 * extra is needed on this route itself.
 */
export const Route = createFileRoute("/counter/password")({
  component: PasswordScreen,
})
