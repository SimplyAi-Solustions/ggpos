import { Layers } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function CardsPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Catalogue"
      title="Cards"
      lede="Search every card by name, set or number."
      icon={<Layers aria-hidden />}
      plans={[
        "Search across Pokémon, Magic, Lorcana and One Piece",
        "Filter by game, set and rarity",
        "Prices per condition, UK sources first",
      ]}
    />
  )
}
