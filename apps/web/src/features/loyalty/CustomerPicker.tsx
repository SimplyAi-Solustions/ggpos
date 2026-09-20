/**
 * Finding a customer from inside a sheet.
 *
 * The Sell screen's own picker is a sheet, and a sheet inside a sheet is a
 * focus trap inside a focus trap, so the membership and adjustment sheets
 * put the same search inline: one box, a hairline list of matches, and the
 * chosen person shown back with a way to change it.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { findCustomersForSale } from "@/lib/api"
import type { SaleCustomer } from "@/lib/api/types"

export interface CustomerPickerProps {
  id: string
  label?: string
  /** The chosen customer, or null while nobody is chosen. */
  chosen: SaleCustomer | null
  onChoose: (customer: SaleCustomer | null) => void
  error?: string
}

export function CustomerPicker({
  id,
  label = "Customer",
  chosen,
  onChoose,
  error,
}: CustomerPickerProps) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query)

  const { data = [], isFetching } = useQuery({
    queryKey: ["sale-customers", deferred],
    queryFn: () => findCustomersForSale(deferred),
    enabled: !chosen,
    staleTime: 10_000,
  })

  if (chosen) {
    return (
      <Field label={label} layout="stacked">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-hairline-soft pb-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-foreground">
              {chosen.name}
            </span>
            <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
              {displayCode(chosen.code)}
            </span>
          </span>
          {chosen.tierName ? <Badge variant="volt">{chosen.tierName}</Badge> : null}
          <Button variant="text" type="button" onClick={() => onChoose(null)}>
            Change
          </Button>
        </div>
      </Field>
    )
  }

  return (
    <Field label={label} htmlFor={id} layout="stacked" error={error}>
      <Input
        id={id}
        autoComplete="off"
        placeholder="Name, phone or GGC code"
        value={query}
        aria-invalid={Boolean(error) || undefined}
        onChange={(event) => setQuery(event.target.value)}
      />
      {data.length === 0 ? (
        <p className="mt-4 text-[13px] leading-[1.45] text-muted-foreground-2">
          {isFetching
            ? "Searching."
            : "No customer matches that. Check the spelling, or add them first."}
        </p>
      ) : (
        <ul className="mt-4 max-h-60 overflow-y-auto">
          {data.slice(0, 6).map((customer) => (
            <li key={customer.id} className="border-b border-hairline-soft first:border-t">
              <button
                type="button"
                data-testid="customer-hit"
                onClick={() => onChoose(customer)}
                className="flex min-h-12 w-full items-center gap-4 py-2 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">
                    {customer.name}
                  </span>
                  <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
                    {displayCode(customer.code)}
                  </span>
                </span>
                <Hint className="tnum shrink-0">
                  {customer.pointsBalance.toLocaleString("en-GB")} points
                </Hint>
                <Hint className="tnum shrink-0">
                  {formatGBP(customer.creditBalance)}
                </Hint>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  )
}
