/**
 * "Attach customer" on the Sell screen, and "Reserve" on the Item page.
 * One box: a name, a phone or a GGC code, and the rows carry the tier and
 * the balances so staff can tell two Smiths apart.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { findCustomersForSale } from "@/lib/api"
import type { SaleCustomer } from "@/lib/api/types"

export interface CustomerSearchSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChoose: (customer: SaleCustomer) => void
  title?: string
  description?: string
}

export function CustomerSearchSheet({
  open,
  onOpenChange,
  onChoose,
  title = "Attach customer",
  description = "Search a name, a phone number or a card code.",
}: CustomerSearchSheetProps) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query)

  const { data = [], isFetching } = useQuery({
    queryKey: ["sale-customers", deferred],
    queryFn: () => findCustomersForSale(deferred),
    enabled: open,
    staleTime: 10_000,
  })

  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Input
            autoFocus
            value={query}
            placeholder="Name, phone or GGC code"
            aria-label="Search customers"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />

          {data.length === 0 ? (
            <p className="mt-8 text-[15px] leading-[1.5] text-muted-foreground-2">
              {isFetching
                ? "Searching."
                : "No customer matches that. Check the spelling, or sell without one."}
            </p>
          ) : (
            <ul className="mt-8 border-t border-hairline-soft">
              {data.map((customer) => (
                <li key={customer.id} className="border-b border-hairline-soft">
                  <button
                    type="button"
                    onClick={() => {
                      onChoose(customer)
                      onOpenChange(false)
                    }}
                    className="flex min-h-14 w-full items-center gap-4 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-foreground">
                        {customer.name}
                      </span>
                      <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
                        {displayCode(customer.code)}
                      </span>
                    </span>
                    {customer.tierName ? (
                      <Badge variant="volt">{customer.tierName}</Badge>
                    ) : null}
                    <Hint className="tnum shrink-0">
                      {formatGBP(customer.creditBalance)}
                    </Hint>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
