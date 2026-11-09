import { Link } from "@tanstack/react-router"
import { Handshake, Plus } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"
import { buttonClasses } from "@/ui"

export function DealsPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Buy-ins"
      title="Deals"
      lede="Every buy-in, open and done."
      icon={<Handshake aria-hidden />}
      plans={[
        "Open deals first, then today's completed ones",
        "Cash or trade credit at a glance",
        "Tap through to finish or reopen a deal",
      ]}
    >
      <Link to="/deals/new" className={buttonClasses("primary", "lg", true)}>
        <Plus className="size-5" aria-hidden />
        New deal
      </Link>
    </FeaturePlaceholder>
  )
}
