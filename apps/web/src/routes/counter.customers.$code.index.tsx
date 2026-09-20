import { createFileRoute } from "@tanstack/react-router"
import { displayCode } from "@gg/shared"

import { Placeholder } from "@/app/placeholder"
import { MicroLabel } from "@/components/ui/micro-label"

function CustomerPlaceholder() {
  const { code } = Route.useParams()
  return (
    <Placeholder
      title="Customer"
      lede="This customer's profile, credit and Guild points open here once the customer screens land."
    >
      <div className="mt-10 flex flex-col gap-2">
        <MicroLabel>Card</MicroLabel>
        <p className="tnum font-mono text-[13px] text-foreground">
          {displayCode(code)}
        </p>
      </div>
    </Placeholder>
  )
}

export const Route = createFileRoute("/counter/customers/$code/")({
  component: CustomerPlaceholder,
})
