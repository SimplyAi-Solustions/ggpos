import { Link } from "@tanstack/react-router"
import { Package, Plus } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"
import { buttonClasses } from "@/ui"

export function StockPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Inventory"
      title="Stock"
      lede="What we hold, where it is and what it is priced at."
      icon={<Package aria-hidden />}
      plans={["Search and filter stock", "Reprice against today's market", "Print a label"]}
    >
      <Link to="/stock/new" className={buttonClasses("primary", "lg", true)}>
        <Plus className="size-5" aria-hidden />
        Add stock
      </Link>
    </FeaturePlaceholder>
  )
}
