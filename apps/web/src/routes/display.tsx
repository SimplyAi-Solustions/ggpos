import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

function DisplayPlaceholder() {
  return (
    <main className="mx-auto w-full max-w-[1040px] px-5 pb-16 sm:px-10">
      <Placeholder
        title="Game, trade, play"
        lede="The customer-facing screen shows the basket, the perks applied and the offer to accept."
      />
    </main>
  )
}

export const Route = createFileRoute("/display")({
  component: DisplayPlaceholder,
})
