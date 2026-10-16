/**
 * One branch of the category tree in the till's catalogue pane
 * (docs/api-contract-inventory.md, section 1.6; DESIGN.md, section 10,
 * "Catalogue pane"): how staff find anything without a barcode, "if you
 * click trading cards and then you've got another set of options".
 *
 * A breadcrumb with a back step, then the child branches as folder tiles
 * (the till's own tile, the branch's picture or a folder at 28px, the shelf
 * count in `Hint`), then the branch's till products and stock rows as the
 * till's usual tiles, forty at a time with "Load more". With words in the
 * scan field the same tiles show what matches anywhere beneath the branch.
 */
import { useInfiniteQuery } from "@tanstack/react-query"
import type {
  TillBranchChip,
  TillBranchView,
  TillCatalogueItem,
  TillCatalogueProduct,
} from "@gg/shared"
import { ArrowLeftIcon, FolderIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { Skeleton } from "@/components/ui/skeleton"
import { Breadcrumb } from "@/features/categories/Breadcrumb"
import { ItemTile, KeyTile, Tile } from "@/features/till/Tile"
import { getTillBranch } from "@/lib/api/categories"
import { isNotFound, refusalOrFallback } from "@/lib/api/refusal"

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-3"

/** A child branch: the till's tile with a folder where the picture would be. */
export function FolderTile({
  branch,
  onOpen,
}: {
  branch: TillBranchChip
  onOpen: (id: string) => void
}) {
  return (
    <Tile
      testId="till-folder"
      title={branch.name}
      price=""
      image={branch.image_url || undefined}
      platform="other"
      Icon={FolderIcon}
      // A branch of services has nothing on the shelf and plenty to sell,
      // so an empty shelf says nothing rather than "none".
      status={branch.items > 0 ? `${branch.items} in stock` : undefined}
      onPress={() => onOpen(branch.id)}
    />
  )
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

export interface BranchViewProps {
  branchId: string
  /** Words from the scan field: search beneath this branch. */
  search: string | null
  onOpen: (id: string) => void
  /** One level up to `parent`, or with null back to the page the branch was opened from. */
  onBack: (parent: string | null) => void
  onClearSearch: () => void
  onProduct: (product: TillCatalogueProduct) => void
  /** A stock row from a tile: a serialised one goes through its full record. */
  onItem: (item: TillCatalogueItem) => void
}

export function BranchView({
  branchId,
  search,
  onOpen,
  onBack,
  onClearSearch,
  onProduct,
  onItem,
}: BranchViewProps) {
  const q = search?.trim() ?? ""
  const query = useInfiniteQuery({
    queryKey: ["till-branch", branchId, q],
    queryFn: ({ pageParam }) => getTillBranch(branchId, { q, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last: TillBranchView, pages: TillBranchView[]) => {
      const shown = pages.reduce((sum, page) => sum + page.items.length, 0)
      return shown < last.total ? last.page + 1 : undefined
    },
    staleTime: 30_000,
    retry: (count, error) => !isNotFound(error) && count < 2,
  })

  const first = query.data?.pages[0]
  const steps = first
    ? [...first.trail, { id: first.branch.id, name: first.branch.name }]
    : []

  return (
    <div className="flex flex-col gap-5" data-testid="till-branch">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Button
          variant="text"
          className="min-h-14"
          onClick={() => onBack(first?.trail.at(-1)?.id ?? null)}
          data-testid="till-branch-back"
        >
          <ArrowLeftIcon aria-hidden="true" />
          Back
        </Button>
        {first ? (
          <Breadcrumb
            label="Branch"
            steps={steps}
            onStep={onOpen}
            className="min-w-0"
            testId="till-branch-trail"
          />
        ) : null}
      </div>

      {query.isPending ? (
        <TileSkeletons />
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-[15px] text-destructive">
            {isNotFound(query.error)
              ? refusalOrFallback(query.error, "That branch was not found.")
              : "That branch did not load. Check the connection and try again."}
          </p>
          {isNotFound(query.error) ? null : (
            <Button variant="text" className="min-h-14" onClick={() => void query.refetch()}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <BranchContents
          pages={query.data.pages}
          search={q}
          onOpen={onOpen}
          onClearSearch={onClearSearch}
          onProduct={onProduct}
          onItem={onItem}
          more={query.hasNextPage}
          loadingMore={query.isFetchingNextPage}
          onMore={() => void query.fetchNextPage()}
        />
      )}
    </div>
  )
}

function BranchContents({
  pages,
  search,
  onOpen,
  onClearSearch,
  onProduct,
  onItem,
  more,
  loadingMore,
  onMore,
}: {
  pages: TillBranchView[]
  search: string
  onOpen: (id: string) => void
  onClearSearch: () => void
  onProduct: (product: TillCatalogueProduct) => void
  onItem: (item: TillCatalogueItem) => void
  more: boolean
  loadingMore: boolean
  onMore: () => void
}) {
  const first = pages[0]
  if (!first) return null
  const children = first.children
  const products = first.products
  const items = pages.flatMap((page) => page.items)
  const empty = children.length + products.length + items.length === 0

  return (
    <div className="flex flex-col items-start gap-6">
      {search ? (
        <div className="flex w-full items-center justify-between gap-6">
          <MicroLabel tone="ink" className="truncate">
            Results in {first.branch.name}
          </MicroLabel>
          <Button variant="text" className="min-h-14" onClick={onClearSearch}>
            Clear
          </Button>
        </div>
      ) : null}

      {empty ? (
        <p data-testid="till-branch-empty" className="text-[15px] text-muted-foreground">
          {search
            ? `Nothing in ${first.branch.name} matches that. Check the spelling, or scan the label.`
            : `Nothing in ${first.branch.name} yet. Scan an item to sell it.`}
        </p>
      ) : (
        <div className={`${GRID} w-full`} data-testid="till-branch-tiles">
          {children.map((branch) => (
            <FolderTile key={branch.id} branch={branch} onOpen={onOpen} />
          ))}
          {products.map((product) => (
            <KeyTile key={product.id} product={product} onProduct={onProduct} onItem={onItem} />
          ))}
          {items.map((item) => (
            <ItemTile key={item.id} item={item} onItem={(row) => onItem(row)} />
          ))}
        </div>
      )}

      {more ? (
        <Button variant="text" className="min-h-14" loading={loadingMore} onClick={onMore}>
          Load more
        </Button>
      ) : null}
    </div>
  )
}
