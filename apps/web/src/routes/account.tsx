import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

/** Outside the counter shell, so this screen owns its own column. */
function AccountPlaceholder() {
  return (
    <main className="mx-auto w-full max-w-[1040px] px-5 pb-16 sm:px-10">
      <Placeholder
        title="My Vault"
        lede="Sign in with the code we email you to see your card, your Guild points and your trade-ins."
      />
    </main>
  )
}

export const Route = createFileRoute("/account")({
  component: AccountPlaceholder,
})
