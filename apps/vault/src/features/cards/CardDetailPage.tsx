import { Layers } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function CardDetailPage({ id }: { id: string }) {
  return (
    <FeaturePlaceholder
      eyebrow={`Card ${id}`}
      title="Card"
      lede="One card: image, prices per condition and what we hold."
      icon={<Layers aria-hidden />}
      plans={[
        "Large card image with tilt",
        "NM, LP, MP, HP and damaged prices in GBP",
        "Buy price at the current cash and credit rates",
        "Copies in stock, add to a deal",
      ]}
    />
  )
}
