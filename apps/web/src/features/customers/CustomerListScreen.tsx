import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Hint } from "@/components/ui/micro-label"
import { SkeletonText } from "@/components/ui/skeleton"
import { StickerRing } from "@/components/ui/sticker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useCounterDock } from "@/app/counter-dock"
import { registerSearchField } from "@/app/focus-registry"
import { ID_STATUS_LABEL, formatShortDate } from "@/features/customers/format"
import { searchCustomerPage } from "@/lib/api"

/**
 * The customer book: one field, one table, one black block.
 *
 * Search is the whole screen, so the field takes `/` from the shortcut
 * handler and the table below it filters as the query settles. A scanned
 * `GGC` code never lands here at all: the scan bus routes it straight to the
 * profile.
 */
export function CustomerListScreen() {
  const navigate = useNavigate()
  const [query, setQuery] = React.useState("")
  const searchRef = React.useRef<HTMLInputElement>(null)
  const dock = useCounterDock()

  React.useEffect(() => registerSearchField(searchRef.current), [])

  const deferred = React.useDeferredValue(query)
  const { data: page, isPending } = useQuery({
    queryKey: ["customers", deferred.trim()],
    queryFn: () => searchCustomerPage(deferred),
    staleTime: 10_000,
  })
  const customers = page?.items ?? []

  const newCustomer = () => void navigate({ to: "/counter/customers/new" })

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Customers</PageTitle>
      <Lede>Find someone by name, phone, card or email.</Lede>

      <div className="mt-12">
        <Input
          id="customer-search"
          ref={searchRef}
          type="search"
          autoComplete="off"
          aria-label="Search customers"
          leadingIcon={<SearchIcon />}
          trailingHint="Press / to focus"
          placeholder="Name, phone, GGC code or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="mt-12">
        {isPending ? (
          <SkeletonText lines={5} />
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-start gap-6 py-10">
            <StickerRing className="size-14 text-muted-foreground-2" aria-hidden="true" />
            <p className="max-w-[46ch] text-base leading-[1.5] text-muted-foreground">
              {query.trim()
                ? "Nobody matches that. Try fewer characters, or add them as a new customer."
                : "No customers yet. Add the first one to start the Guild."}
            </p>
          </div>
        ) : (
          <Table>
            <caption className="sr-only">
              Customers matching the search, newest card first
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Card</TableHead>
                <TableHead className="max-sm:hidden">Phone</TableHead>
                <TableHead>ID</TableHead>
                <TableHead className="max-sm:hidden" numeric>
                  Credit
                </TableHead>
                <TableHead className="max-sm:hidden">Last visit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <Link
                      to="/counter/customers/$code"
                      params={{ code: customer.code }}
                      className="text-foreground underline-offset-4 outline-none hover:underline"
                    >
                      {customer.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="tnum font-mono text-[13px] whitespace-nowrap text-muted-foreground">
                      {displayCode(customer.code)}
                    </span>
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    <span className="tnum text-[15px] whitespace-nowrap text-muted-foreground">
                      {customer.phone || "-"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {ID_STATUS_LABEL[customer.idStatus]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-sm:hidden" numeric>
                    {formatGBP(customer.creditBalance)}
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    <span className="tnum text-[15px] whitespace-nowrap text-muted-foreground">
                      {formatShortDate(customer.lastVisit) || "-"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="mt-14 hidden items-center gap-8 min-[900px]:flex">
        <Button type="button" trailingArrow onClick={newCustomer}>
          New customer
        </Button>
        {/* What the server matched in all, not the size of this page. */}
        <Hint>
          {page ? page.total : 0} {query.trim() ? "found" : "on file"}
        </Hint>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3">
              <Button
                type="button"
                trailingArrow
                className="w-full"
                onClick={newCustomer}
              >
                New customer
              </Button>
            </div>,
            dock
          )
        : null}
    </section>
  )
}
