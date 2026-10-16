/**
 * The stock list: a hairline table of what the shop holds, with the filters
 * staff reach for first and one search box over the lot.
 *
 * No zebra, no outer border, no card: rows at ink 12 percent and a lot of
 * air, as DESIGN.md's data section sets out.
 *
 * The category tree (docs/api-contract-inventory.md, section 1.6): a branch
 * filter through the picker that takes in everything beneath the branch, a
 * Category column with the last two levels of each row's path, and rows
 * ticked here filed into a branch in one go.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { displayCode, formatGBP, type CategoryBranch } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
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
import { CategoryPicker } from "@/features/categories/CategoryPicker"
import { RowCheck } from "@/features/categories/RowCheck"
import { lastLevels } from "@/features/categories/tree"
import { OverrideCancelled } from "@/features/lock/override"
import { PriceLabelSheet } from "@/features/price-labels/PriceLabelSheet"
import { startingCopies } from "@/features/price-labels/plan"
import { listItems } from "@/lib/api"
import { assignCategory, CATEGORY_TREE_KEY } from "@/lib/api/categories"
import { refusalOrFallback } from "@/lib/api/refusal"
import { ONLINE_FEED_KEY, setItemsOnline } from "@/lib/api/online"
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

/**
 * Columns a phone leaves to the item page. Below 640px a row is the picture,
 * the name with its code and the price, so the list never scrolls sideways.
 */
const WIDE = "max-sm:hidden"

export interface StockListScreenProps {
  /** The filter the list opens on. Home's waiting line links in on "reserved". */
  initialStatus?: ItemStatus
}

export function StockListScreen({ initialStatus = "in_stock" }: StockListScreenProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [status, setStatus] = React.useState<ItemStatus | null>(initialStatus)
  const [search, setSearch] = React.useState("")
  const deferred = React.useDeferredValue(search)
  /** The branch the list is narrowed to, with everything beneath it. */
  const [branch, setBranch] = React.useState<CategoryBranch | null>(null)
  /** Which picker is open: the filter, or filing the ticked rows. */
  const [picking, setPicking] = React.useState<"filter" | "file" | null>(null)
  const [chosen, setChosen] = React.useState<string[]>([])
  const [note, setNote] = React.useState<string | null>(null)
  /** Print prices for the ticked rows on the Niimbot D110. */
  const [pricing, setPricing] = React.useState(false)

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
    queryKey: ["items", status, deferred, branch?.id ?? ""],
    queryFn: ({ pageParam }) =>
      listItems(
        { status: status ?? undefined, search: deferred, category: branch?.id },
        pageParam
      ),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page < last.totalPages ? last.page + 1 : undefined,
    staleTime: 10_000,
  })

  const rows = data?.pages.flatMap((page) => page.items) ?? []
  const totalItems = data?.pages[0]?.totalItems ?? 0
  // Only singles and graded cards carry a condition, so a list of boxes and
  // paints gives the column back to the item's name.
  const showCondition = rows.some((row) => row.condition)
  const ticked = chosen.filter((id) => rows.some((row) => row.id === id))

  const file = useMutation({
    mutationFn: (into: CategoryBranch) => assignCategory({ category: into.id, items: ticked }),
    onSuccess: (result, into) => {
      setPicking(null)
      setChosen([])
      setNote(
        `${result.items} ${result.items === 1 ? "row" : "rows"} filed in ${lastLevels(into.path)}.`
      )
      void queryClient.invalidateQueries({ queryKey: ["items"] })
      void queryClient.invalidateQueries({ queryKey: ["item"] })
      void queryClient.invalidateQueries({ queryKey: CATEGORY_TREE_KEY })
    },
  })

  // Launch (docs/api-contract-launch.md, section 6): the ticked rows shown
  // on the website, or taken off it, in one go.
  const online = useMutation({
    mutationFn: (on: boolean) => setItemsOnline(ticked, on),
    onSuccess: (count, on) => {
      setChosen([])
      setNote(
        `${count} ${count === 1 ? "row" : "rows"} ${on ? "shown on the website" : "taken off the website"}.`
      )
      void queryClient.invalidateQueries({ queryKey: ["items"] })
      void queryClient.invalidateQueries({ queryKey: ["item"] })
      void queryClient.invalidateQueries({ queryKey: ONLINE_FEED_KEY })
    },
    onError: (err) => setNote(refusalOrFallback(err, "Those rows did not change. Try again.")),
  })

  function toggle(id: string, on: boolean) {
    setNote(null)
    setChosen((now) => (on ? [...now.filter((entry) => entry !== id), id] : now.filter((entry) => entry !== id)))
  }

  const fileError =
    file.error && !(file.error instanceof OverrideCancelled)
      ? refusalOrFallback(file.error, "Those rows were not filed. Try again.")
      : null

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

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="stock-branch-filter">
        <MicroLabel>Branch</MicroLabel>
        <span className="min-w-0 text-[15px] text-foreground" data-testid="stock-branch">
          {branch ? branch.path : "Every branch"}
        </span>
        <span className="flex items-center gap-6">
          <Button variant="text" onClick={() => setPicking("filter")}>
            {branch ? "Change" : "Choose a branch"}
          </Button>
          {branch ? (
            <Button variant="text" onClick={() => setBranch(null)}>
              Every branch
            </Button>
          ) : null}
        </span>
      </div>

      {ticked.length > 0 || note ? (
        <div
          className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-2"
          data-testid="stock-bulk"
          aria-live="polite"
        >
          {ticked.length > 0 ? (
            <>
              <span className="tnum text-[15px] text-foreground">
                {ticked.length} chosen
              </span>
              <Button variant="text" onClick={() => setPicking("file")}>
                File in a branch
              </Button>
              <Button variant="text" loading={online.isPending && online.variables} onClick={() => online.mutate(true)}>
                Show online
              </Button>
              <Button variant="text" loading={online.isPending && !online.variables} onClick={() => online.mutate(false)}>
                Take offline
              </Button>
              <Button variant="text" onClick={() => setPricing(true)}>
                Print prices
              </Button>
              <Button variant="text" onClick={() => setChosen([])}>
                Clear
              </Button>
            </>
          ) : note ? (
            <span className="text-[15px] text-muted-foreground">{note}</span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-12">
        {rows.length === 0 ? (
          <div className="flex flex-col items-start gap-6">
            <StickerCards />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              {isPending
                ? "Looking through the shelves."
                : search
                  ? "Nothing matches that. Try the code, or clear the filters."
                  : branch
                    ? `Nothing in ${branch.name} under that filter. Choose another branch, or add an item.`
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
                <TableHead className="w-12">
                  <span className="sr-only">Choose</span>
                </TableHead>
                <TableHead>
                  <span className="sr-only">Picture</span>
                </TableHead>
                <TableHead>Item</TableHead>
                <TableHead className={WIDE}>Category</TableHead>
                {showCondition ? <TableHead className={WIDE}>Condition</TableHead> : null}
                <TableHead numeric>Price</TableHead>
                <TableHead className={WIDE}>Status</TableHead>
                <TableHead className={WIDE}>Location</TableHead>
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
                    if (event.target !== event.currentTarget) return
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    void navigate({
                      to: "/counter/stock/$sku",
                      params: { sku: row.sku },
                    })
                  }}
                >
                  <TableCell className="w-12 p-0">
                    {/* The whole cell is the target, not just the square. */}
                    <label
                      className="flex size-12 cursor-pointer items-center justify-start"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <RowCheck
                        label={`Choose ${row.title}`}
                        checked={chosen.includes(row.id)}
                        onChange={(on) => toggle(row.id, on)}
                      />
                    </label>
                  </TableCell>
                  <TableImageCell>
                    <ProductImage
                      src={row.image}
                      alt=""
                      platform={row.platform}
                      height={40}
                    />
                  </TableImageCell>
                  {/* The one column that gives: `w-full max-w-0` hands it
                      whatever the others leave, so the table always fits the
                      page and a long name wraps instead of pushing Status and
                      Location off the edge. The code sits under the name, as
                      it does on the supplier call. */}
                  <TableCell className="w-full max-w-0 min-w-40">
                    <span className="line-clamp-2 text-[15px] leading-[1.35] text-foreground [overflow-wrap:anywhere]">
                      {row.title}
                    </span>
                    <span className="mt-1 flex min-w-0 items-baseline gap-3">
                      <span className="tnum shrink-0 font-mono text-[13px] text-muted-foreground-2">
                        {displayCode(row.sku)}
                      </span>
                      {row.detail ? (
                        <Hint className="min-w-0 truncate normal-case">{row.detail}</Hint>
                      ) : null}
                      {/* A phone has no Status column, so a mixed list says it here. */}
                      {status === null ? (
                        <Hint className="shrink-0 normal-case sm:hidden">{STATUS_LABELS[row.status]}</Hint>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell
                    className={`max-w-44 truncate text-muted-foreground ${WIDE}`}
                    data-testid="stock-category"
                    title={row.categoryPath || undefined}
                  >
                    {row.categoryPath ? lastLevels(row.categoryPath) : "-"}
                  </TableCell>
                  {showCondition ? <TableCell className={WIDE}>{row.condition || "-"}</TableCell> : null}
                  <TableCell numeric className="whitespace-nowrap">
                    {formatGBP(row.price)}
                  </TableCell>
                  <TableCell className={`whitespace-nowrap ${WIDE}`}>
                    <Badge variant="outline">{STATUS_LABELS[row.status]}</Badge>
                  </TableCell>
                  <TableCell
                    className={`max-w-32 truncate text-muted-foreground-2 ${WIDE}`}
                    title={row.locationName || undefined}
                  >
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

      {/* One label per unit on each ticked row, in the order they were ticked. */}
      <PriceLabelSheet
        open={pricing}
        onOpenChange={setPricing}
        items={ticked.flatMap((id) => {
          const row = rows.find((entry) => entry.id === id)
          return row
            ? [{ id: row.id, sku: row.sku, title: row.title, price: row.price, copies: startingCopies(row.qty) }]
            : []
        })}
      />
      <CategoryPicker
        open={picking === "filter"}
        onOpenChange={(open) => setPicking(open ? "filter" : null)}
        title="Show a branch"
        description="The list keeps the rows in the branch you choose and everything beneath it."
        initial={branch?.id}
        onChoose={(next) => {
          setBranch(next)
          setChosen([])
          setPicking(null)
        }}
      />
      <CategoryPicker
        open={picking === "file"}
        onOpenChange={(open) => {
          if (!open) file.reset()
          setPicking(open ? "file" : null)
        }}
        title={`File ${ticked.length} ${ticked.length === 1 ? "row" : "rows"}`}
        description="They move into the branch you choose. Nothing else about them changes."
        initial={branch?.id}
        pending={file.isPending}
        error={fileError}
        onChoose={(into) => {
          if (into) file.mutate(into)
        }}
      />
    </section>
  )
}
