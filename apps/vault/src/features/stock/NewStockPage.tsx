import { Package } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function NewStockPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Inventory"
      title="Add stock"
      lede="Identify it, price it, label it, put it away."
      icon={<Package aria-hidden />}
      plans={["Pick the card or product", "Condition, quantity and location", "Suggested sell price, rounded to .49 or .99"]}
    />
  )
}
