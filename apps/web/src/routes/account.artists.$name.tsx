import { createFileRoute } from "@tanstack/react-router"

import { ArtistScreen } from "@/features/binders/ArtistScreen"

function Artist() {
  const { name } = Route.useParams()
  return <ArtistScreen name={name} />
}

export const Route = createFileRoute("/account/artists/$name")({
  component: Artist,
})
