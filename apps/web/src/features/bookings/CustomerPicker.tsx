/**
 * Who a booking is for, inside a sheet: one field that searches the
 * customer book by name, phone or card code, the matches as hairline rows,
 * and once one is chosen, their name and code with "Change". A sheet
 * cannot open a second sheet over itself on a phone, so this is the same
 * search as the till's Attach customer, laid inline.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon, XIcon } from "lucide-react"
import { displayCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { customerIsMember } from "@/lib/api/bookings"
import { findCustomersForSale } from "@/lib/api"
import type { SaleCustomer } from "@/lib/api/types"

export interface PickedCustomer {
  id: string
  name: string
  code: string
  member: boolean
}

export function CustomerPicker({
  value,
  onChange,
  label = "Customer",
}: {
  value: PickedCustomer | null
  onChange: (next: PickedCustomer | null) => void
  label?: string
}) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query.trim())
  const [choosing, setChoosing] = React.useState<string | null>(null)

  const { data = [], isFetching } = useQuery({
    queryKey: ["booking-customers", deferred],
    queryFn: () => findCustomersForSale(deferred),
    enabled: deferred.length >= 2 && !value,
    staleTime: 10_000,
  })

  async function choose(customer: SaleCustomer) {
    setChoosing(customer.id)
    // Not knowing is not being a member: the server prices it either way.
    const member = await customerIsMember(customer.id).catch(() => false)
    setChoosing(null)
    setQuery("")
    onChange({ id: customer.id, name: customer.name, code: customer.code, member })
  }

  if (value) {
    return (
      <div className="flex min-h-12 items-center gap-3 border-b border-hairline pb-2" data-testid="picked-customer">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] text-foreground">{value.name}</span>
          <span className="tnum block font-mono text-[13px] text-muted-foreground-2">
            {displayCode(value.code)}
          </span>
        </span>
        {value.member ? <Badge variant="outline">Guild</Badge> : null}
        <Button
          variant="ghost-icon"
          aria-label={`Take ${value.name} off`}
          onClick={() => onChange(null)}
        >
          <XIcon />
        </Button>
      </div>
    )
  }

  return (
    <div>
      <Input
        type="search"
        autoComplete="off"
        aria-label={`${label}: search by name, phone or card code`}
        leadingIcon={<SearchIcon />}
        placeholder="Name, phone or GGC code"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {deferred.length >= 2 ? (
        data.length === 0 ? (
          <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground-2">
            {isFetching ? "Searching." : "Nobody matches that. Type their name and phone below instead."}
          </p>
        ) : (
          <ul className="mt-3" aria-label="Matching customers">
            {data.slice(0, 5).map((customer) => (
              <li key={customer.id} className="border-b border-hairline-soft first:border-t">
                <button
                  type="button"
                  disabled={choosing !== null}
                  onClick={() => void choose(customer)}
                  className="flex min-h-12 w-full items-center gap-4 py-2 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{customer.name}</span>
                    <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
                      {displayCode(customer.code)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}
