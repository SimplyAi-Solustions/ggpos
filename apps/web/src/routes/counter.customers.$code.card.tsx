import { createFileRoute } from "@tanstack/react-router"

function CardProbe() {
  return <p>card</p>
}

export const Route = createFileRoute("/counter/customers/$code/card")({
  component: CardProbe,
})
