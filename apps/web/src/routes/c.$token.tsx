import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

/**
 * The QR landing on a customer's card. It never shows anything about a
 * customer without a sign-in; staff who are already signed in will be taken
 * to that customer at the counter instead.
 */
function CardLandingPlaceholder() {
  return (
    <main className="mx-auto w-full max-w-[1040px] px-5 pb-16 sm:px-10">
      <Placeholder
        title="Your Guild card"
        lede="Sign in to My Vault to see this card, its points and the rewards it can claim."
      />
    </main>
  )
}

export const Route = createFileRoute("/c/$token")({
  component: CardLandingPlaceholder,
})
