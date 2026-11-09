import { Package } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function StockItemPage({ id }: { id: string }) {
  return (
    <FeaturePlaceholder
      eyebrow={`Item ${id}`}
      title="Stock item"
      lede="One item: provenance, price history and where it is."
      icon={<Package aria-hidden />}
      plans={["Edit price and location", "See who it came from", "Reprint its label"]}
    />
  )
}
