import { createFileRoute } from "@tanstack/react-router"
import { displayCode } from "@gg/shared"

import { Placeholder } from "@/app/placeholder"
import { MicroLabel } from "@/components/ui/micro-label"

function ItemPlaceholder() {
  const { sku } = Route.useParams()
  return (
    <Placeholder
      title="Item"
      lede="The full record, its provenance, its price history and its label live here once the stock screens land."
    >
      <div className="mt-10 flex flex-col gap-2">
        <MicroLabel>Code</MicroLabel>
        <p
          data-testid="item-sku"
          className="tnum font-mono text-[20px] leading-none text-foreground"
        >
          {displayCode(sku)}
        </p>
      </div>
    </Placeholder>
  )
}

export const Route = createFileRoute("/counter/stock/$sku")({
  component: ItemPlaceholder,
})
