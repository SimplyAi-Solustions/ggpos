import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

function AccountPlaceholder() {
  return (
    <Placeholder
      title="My Vault"
      lede="Sign in with the code we email you to see your card, your Guild points and your trade-ins."
    />
  )
}

export const Route = createFileRoute("/account")({
  component: AccountPlaceholder,
})
