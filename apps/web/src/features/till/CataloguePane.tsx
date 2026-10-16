/**
 * The catalogue pane (DESIGN.md, section 10, "Catalogue pane"): the scan
 * field, the category rail, and the tiles. A dynamic category pages through
 * the stock lines it lists. A search replaces the tiles with the same
 * tiles, or with hairline table rows for serialised stock (singles, graded,
 * retro), where the code and the condition matter more than the picture.
 *
 * The rail shows the quick-key pages, then the category tree's top-level
 * branches (docs/api-contract-inventory.md, section 1.6). A branch opens
 * its view in place of the tiles, and while one is open the scan field's
 * words search beneath it; a scanned code still finds the item anywhere.
 */
import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CalendarClockIcon } from "lucide-react"
import {
  displayCode,
  formatGBP,
  type TillCatalogue,
  type TillCatalogueItem,
  type TillCatalogueProduct,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { FieldError } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Skeleton } from "@/components/ui/skeleton"
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
import { BranchView } from "@/features/till/BranchView"
import { ItemTile, KeyTile, Tile } from "@/features/till/Tile"
import { listItems } from "@/lib/api"
import { getCategoryItems, searchTillProducts } from "@/lib/api/till"
import type { ItemSummary } from "@/lib/api/types"

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-3"

/** Stock that is one row per unit: the code and condition say which one. */
function serialised(item: ItemSummary): boolean {
  return item.kind === "single" || item.kind === "graded" || item.kind === "retro" || item.kind === "other"
}

function summaryToCatalogueItem(item: ItemSummary): TillCatalogueItem {
  return {
    id: item.id,
    sku: item.sku,
    title: item.title,
    price: item.price,
    qty: item.qty,
    image_url: item.image ?? "",
    kind: item.kind,
    status: item.status,
  }
}

function TileSkeletons() {
  return (
    <div className={GRID} aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-[136px] rounded-[var(--radius)]" />
      ))}
    </div>
  )
}

/** A branch open in the pane, the top-level one it is under, and the page it was opened from. */
export interface OpenBranch {
  id: string
  top: string
  from: string | null
}

/** Rail chips are pages and branches, two collections, so each value says which. */
const PAGE = "page:"
const BRANCH = "branch:"

export interface CataloguePaneProps {
  scanRef: React.RefObject<HTMLInputElement | null>
  scanError: string | null
  scanNote: string | null
  onScanTyping: (value: string) => void
  catalogue: TillCatalogue | undefined
  catalogueLoading: boolean
  catalogueError: boolean
  onRetryCatalogue: () => void
  categoryId: string | null
  onCategory: (id: string) => void
  /** The branch open in the pane, or null for a page's tiles. */
  branch: OpenBranch | null
  /** A top-level branch from the rail. */
  onRailBranch: (id: string) => void
  /** A folder tile or a step of the breadcrumb, under the same top-level branch. */
  onOpenBranch: (id: string) => void
  /** Up to `parent`, or with null back to the page the branch was opened from. */
  onBranchBack: (parent: string | null) => void
  /** The words being searched for, or null for the tiles. */
  search: string | null
  onClearSearch: () => void
  onProduct: (product: TillCatalogueProduct) => void
  onItem: (item: TillCatalogueItem, label?: string) => void
  /** A serialised item from a search: added through its full record. */
  onStock: (item: ItemSummary) => void
  /** A stock row from a branch: a serialised one through its full record. */
  onBranchItem: (item: TillCatalogueItem) => void
  /** The Bookings tile at the head of the first category (package BW). */
  onBookings?: () => void
}

function CategoryItems({
  categoryId,
  onItem,
}: {
  categoryId: string
  onItem: (item: TillCatalogueItem) => void
}) {
  const query = useInfiniteQuery({
    queryKey: ["till-category", categoryId],
    queryFn: ({ pageParam }) => getCategoryItems(categoryId, { page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((sum, page) => sum + page.items.length, 0)
      return shown < last.total ? last.page + 1 : undefined
    },
    staleTime: 30_000,
  })

  if (query.isPending) return <TileSkeletons />
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[15px] text-destructive">
          That category did not load. Check the connection and try again.
        </p>
        <Button variant="text" className="min-h-14" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    )
  }
  const items = query.data.pages.flatMap((page) => page.items)
  if (items.length === 0) {
    return <p className="text-[15px] text-muted-foreground">Nothing in stock under this one.</p>
  }
  return (
    <div className="flex flex-col items-start gap-6">
      <div className={`${GRID} w-full`}>
        {items.map((item) => (
          <ItemTile key={item.id} item={item} onItem={onItem} />
        ))}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="text"
          className="min-h-14"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Show more
        </Button>
      ) : null}
    </div>
  )
}

function SearchResults({
  search,
  onProduct,
  onItem,
  onStock,
}: {
  search: string
  onProduct: (product: TillCatalogueProduct) => void
  onItem: (item: TillCatalogueItem) => void
  onStock: (item: ItemSummary) => void
}) {
  const products = useQuery({
    queryKey: ["till-search-products", search],
    queryFn: () => searchTillProducts(search),
    staleTime: 30_000,
  })
  const stock = useQuery({
    queryKey: ["till-search-stock", search],
    queryFn: () => listItems({ search, status: "in_stock" }, 1),
    staleTime: 10_000,
  })

  if (products.isPending || stock.isPending) return <TileSkeletons />

  const items = stock.data?.items ?? []
  const lines = items.filter((item) => !serialised(item))
  const units = items.filter(serialised)
  const found = (products.data?.length ?? 0) + items.length

  if (found === 0) {
    return (
      <p data-testid="till-search-empty" className="text-[15px] text-muted-foreground">
        Nothing on the till or in stock matches that. Check the spelling, or scan the label.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-10">
      {(products.data?.length ?? 0) + lines.length > 0 ? (
        <div className={GRID}>
          {(products.data ?? []).map((product) => (
            <KeyTile key={product.id} product={product} onProduct={onProduct} onItem={onItem} />
          ))}
          {lines.map((item) => (
            <ItemTile key={item.id} item={summaryToCatalogueItem(item)} onItem={onItem} />
          ))}
        </div>
      ) : null}
      {units.length > 0 ? (
        <Table data-testid="till-search-stock">
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">
                <span className="sr-only">Picture</span>
              </TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="max-sm:hidden">Code</TableHead>
              <TableHead numeric>Price</TableHead>
              <TableHead>
                <span className="sr-only">Add</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((item) => (
              <TableRow key={item.id} className="h-16">
                <TableImageCell>
                  <ProductImage src={item.image} alt="" platform={item.platform} height={40} />
                </TableImageCell>
                <TableCell>
                  <span className="block truncate text-[15px] text-foreground">{item.title}</span>
                  <span className="block truncate text-[13px] text-muted-foreground-2">
                    {[item.detail, item.condition].filter(Boolean).join(" · ")}
                  </span>
                </TableCell>
                <TableCell className="tnum font-mono text-[13px] text-muted-foreground max-sm:hidden">
                  {displayCode(item.sku)}
                </TableCell>
                <TableCell numeric>{formatGBP(item.price)}</TableCell>
                <TableCell className="w-24 text-right">
                  <Button
                    variant="key"
                    className="min-w-20"
                    aria-label={`Add ${item.title}`}
                    onClick={() => onStock(item)}
                  >
                    Add
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  )
}

export function CataloguePane({
  scanRef,
  scanError,
  scanNote,
  onScanTyping,
  catalogue,
  catalogueLoading,
  catalogueError,
  onRetryCatalogue,
  categoryId,
  onCategory,
  branch,
  onRailBranch,
  onOpenBranch,
  onBranchBack,
  search,
  onClearSearch,
  onProduct,
  onItem,
  onStock,
  onBranchItem,
  onBookings,
}: CataloguePaneProps) {
  const categories = catalogue?.categories ?? []
  const branches = catalogue?.branches ?? []
  const category = categories.find((entry) => entry.id === categoryId) ?? categories[0]
  const chosen = branch
    ? `${BRANCH}${branch.top}`
    : !search && category
      ? `${PAGE}${category.id}`
      : null

  return (
    <section aria-label="Catalogue" className="flex min-h-full flex-col px-5 pt-4 pb-8 sm:px-8">
      <Input
        ref={scanRef}
        size="scan"
        data-testid="till-scan-field"
        leadingIcon={<BarcodeGlyph />}
        trailingHint="Press enter"
        placeholder="Scan or search"
        aria-label="Scan an item, a card, a voucher or a receipt, or search"
        aria-invalid={scanError ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(event) => onScanTyping(event.target.value)}
      />
      <FieldError>{scanError}</FieldError>
      {scanNote && !scanError ? (
        <p aria-live="polite" className="mt-2 text-[13px] text-muted-foreground">
          {scanNote}
        </p>
      ) : null}

      <ChipGroup
        aria-label="Categories"
        value={chosen ? [chosen] : []}
        onValueChange={(next) => {
          // Tapping the chip that is already chosen goes back to its top.
          const value = next[0] ?? chosen
          if (!value) return
          if (value.startsWith(BRANCH)) onRailBranch(value.slice(BRANCH.length))
          else onCategory(value.slice(PAGE.length))
        }}
        className="mt-5 -mx-1 flex-nowrap overflow-x-auto px-1 pb-1"
        data-testid="till-rail"
      >
        {categories.map((entry) => (
          <Chip key={`${PAGE}${entry.id}`} value={`${PAGE}${entry.id}`} className="h-12 px-5">
            {entry.name}
          </Chip>
        ))}
        {branches.map((entry) => (
          <Chip
            key={`${BRANCH}${entry.id}`}
            value={`${BRANCH}${entry.id}`}
            className="h-12 px-5"
          >
            {entry.name}
          </Chip>
        ))}
      </ChipGroup>

      <div className="mt-5 flex-1">
        {branch ? (
          <BranchView
            key={branch.id}
            branchId={branch.id}
            search={search}
            onOpen={onOpenBranch}
            onBack={onBranchBack}
            onClearSearch={onClearSearch}
            onProduct={onProduct}
            onItem={onBranchItem}
          />
        ) : search ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-6">
              <MicroLabel tone="ink" className="truncate">
                Results
              </MicroLabel>
              <Button variant="text" className="min-h-14" onClick={onClearSearch}>
                Back to the tiles
              </Button>
            </div>
            <SearchResults search={search} onProduct={onProduct} onItem={onItem} onStock={onStock} />
          </div>
        ) : catalogueLoading ? (
          <TileSkeletons />
        ) : catalogueError ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[15px] text-destructive">
              The till could not load its tiles. Check the connection and try again.
            </p>
            <Button variant="text" className="min-h-14" onClick={onRetryCatalogue}>
              Try again
            </Button>
          </div>
        ) : !category ? (
          <p className="text-[15px] text-muted-foreground">
            No tiles are set up yet. Scan an item to sell it.
          </p>
        ) : category.dynamic ? (
          <CategoryItems categoryId={category.id} onItem={onItem} />
        ) : category.keys.length === 0 && !(onBookings && category === categories[0]) ? (
          <p className="text-[15px] text-muted-foreground">Nothing is on this one yet.</p>
        ) : (
          <div className={GRID} data-testid="till-tiles">
            {onBookings && category === categories[0] ? (
              <Tile
                title="Bookings"
                price=""
                status="Pay or start"
                Icon={CalendarClockIcon}
                onPress={onBookings}
                testId="till-bookings-tile"
              />
            ) : null}
            {[...category.keys]
              .sort((a, b) => a.position - b.position)
              .map((key) => (
                <KeyTile
                  key={key.id}
                  product={key.product}
                  item={key.item}
                  label={key.label}
                  onProduct={onProduct}
                  onItem={onItem}
                />
              ))}
          </div>
        )}
      </div>
    </section>
  )
}
