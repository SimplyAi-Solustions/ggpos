import { createFileRoute } from "@tanstack/react-router"

import { Placeholder } from "@/app/placeholder"

function TradePlaceholder() {
  return (
    <Placeholder
      title="Trade"
      lede="Buy-ins and remote quotes live here, with the offer built line by line."
    />
  )
}

export const Route = createFileRoute("/counter/trade")({
  component: TradePlaceholder,
})
