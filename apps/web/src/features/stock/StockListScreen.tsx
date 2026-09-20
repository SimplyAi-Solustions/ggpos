/**
 * The stock list: a hairline table of what the shop holds, with the filters
 * staff reach for first and one search box over the lot.
 *
 * No zebra, no outer border, no card: rows at ink 12 percent and a lot of
 * air, as DESIGN.md's data section sets out.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useInfiniteQuery } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerCards } from "@/components/ui/sticker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableImageCell,
  TableRow,
} from "@/components/ui/table"
import { ProductImage } from "@/components/product-image"
import { registerSearchField } from "@/app/focus-registry"
import { listItems } from "@/lib/api"
import type { ItemStatus } from "@/lib/api/types"

const FILTERS: { value: ItemStatus; label: string }[] = [
  { value: "in_stock", label: "In stock" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "listed_ebay", label: "Listed on eBay" },
]

const STATUS_LABELS: Record<ItemStatus, string> = {
  in_stock: "In stock",
  reserved: "Reserved",
  listed_ebay: "On eBay",
  sold: "Sold",
  returned: "Returned",
  written_off: "Written off",
}

export function StockListScreen() {
  const navigate = useNavigate()
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [status, setStatus] = React.useState<ItemStatus | null>("in_stock")
  const [search, setSearch] = React.useState("")
  const deferred = React.useDeferredValue(search)

  React.useEffect(() => registerSearchField(searchRef.current), [])

  // One page at a time, and "Show more" asks for the next: the count in the
  // field and the rows under it have to agree, and a shop with four thousand
  // cards should not send them all to a phone.
  const {
    data,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ["items", status, deferred],
    queryFn: ({ pageParam }) =>
      listItems({ status: status ?? undefined, search: deferred }, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page < last.totalPages ? last.page + 1 : undefined,
    staleTime: 10_000,
  })

  const rows = data?.pages.flatMap((page) => page.items) ?? []
  const totalItems = data?.pages[0]?.totalItems ?? 0

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Stock</PageTitle>
      <Lede>Every card, cart and box we hold, priced and findable.</Lede>

      <div className="mt-14">
        <Input
          ref={searchRef}
          value={search}
          placeholder="Title, code, set or barcode"
          aria-label="Search stock"
          autoComplete="off"
          trailingHint={data ? `${totalItems} items` : undefined}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="mt-8">
        <ChipGroup
          aria-label="Stock filters"
          value={status ? [status] : []}
          onValueChange={(next) => setStatus((next[0] as ItemStatus | undefined) ?? null)}
        >
          {FILTERS.map((filter) => (
            <Chip key={filter.value} value={filter.value}>
              {filter.label}
            </Chip>
          ))}
        </ChipGroup>
      </div>

      <div className="mt-12">
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-6">
            <StickerCards />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              {isPending
                ? "Looking through the shelves."
                : search
                  ? "Nothing matches that. Try the code, or clear the filters."
                  : "Nothing is in stock under that filter. Add an item and it will show up here."}
            </p>
            <Button render={<Link to="/counter/stock/new" />} trailingArrow>
              Add stock
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="sr-only">Picture</span>
                </TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead numeric>Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-testid="stock-row"
                  tabIndex={0}
                  role="link"
                  className="cursor-pointer"
                  onClick={() =>
                    void navigate({
                      to: "/counter/stock/$sku",
                      params: { sku: row.sku },
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    void navigate({
                      to: "/counter/stock/$sku",
                      params: { sku: row.sku },
                    })
                  }}
                >
                  <TableImageCell>
                    <ProductImage
                      src={row.image}
                      alt=""
                      platform={row.platform}
                      height={40}
                    />
                  </TableImageCell>
                  <TableCell>
                    <span className="block truncate text-[15px] text-foreground">
                      {row.title}
                    </span>
                    {row.detail ? (
                      <Hint className="block truncate normal-case">{row.detail}</Hint>
                    ) : null}
                  </TableCell>
                  <TableCell className="tnum font-mono text-[13px]">
                    {displayCode(row.sku)}
                  </TableCell>
                  <TableCell>{row.condition || "-"}</TableCell>
                  <TableCell numeric>{formatGBP(row.price)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{STATUS_LABELS[row.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground-2">
                    {row.locationName || "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {hasNextPage ? (
        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3">
          <Button
            variant="text"
            loading={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            Show more
          </Button>
          <Hint className="tnum">
            {rows.length} of {totalItems}
          </Hint>
        </div>
      ) : null}
    </section>
  )
}
