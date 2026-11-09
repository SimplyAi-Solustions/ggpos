import { Handshake } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function DealDetailPage({ id }: { id: string }) {
  return (
    <FeaturePlaceholder
      eyebrow={`Deal ${id}`}
      title="Deal"
      lede="One buy-in: its lines, the offer and how it was paid."
      icon={<Handshake aria-hidden />}
      plans={["Lines with condition and buy rate", "Totals for cash and credit", "Complete, void or reopen"]}
    />
  )
}
