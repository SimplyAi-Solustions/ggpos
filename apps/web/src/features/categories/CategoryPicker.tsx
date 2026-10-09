/**
 * The one picker for a branch of the category tree
 * (docs/api-contract-inventory.md, section 1.6), used everywhere one is
 * chosen: Stock's filter and its bulk filing, Add stock, the item page,
 * the Settings editor's "Move to" and "File these".
 *
 * A sheet, which is a bottom sheet on a phone: the breadcrumb of where you
 * are, the branches at that level as hairline rows with their shelf counts
 * and a chevron where there is more beneath, a search across every path,
 * and "Choose this branch" as the block. A row takes you into its branch;
 * the block chooses the branch you are in. Switched-off branches are never
 * offered.
 */
import * as React from "react"
import type { CategoryBranch } from "@gg/shared"
import { ChevronRightIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Breadcrumb } from "@/features/categories/Breadcrumb"
import {
  branchById,
  childrenOf,
  searchBranches,
  trailOf,
} from "@/features/categories/tree"
import { useCategoryTree } from "@/lib/api/categories"
import { refusalOrFallback } from "@/lib/api/refusal"

export interface CategoryPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The sheet's micro-label title: "Choose a branch", "Move Singles to". */
  title?: string
  description?: string
  /** Where the picker opens: this branch's level. Top when empty. */
  initial?: string | null
  /** The chosen branch, or null for the top level when `allowTop`. */
  onChoose: (branch: CategoryBranch | null) => void
  /** Narrows what is offered further; switched-off branches never are. */
  offered?: (branch: CategoryBranch) => boolean
  /** The top level itself can be chosen: "Move to" the top. */
  allowTop?: boolean
  chooseLabel?: string
  /** The choice is being saved. */
  pending?: boolean
  /** What went wrong with the last choice, in the server's words. */
  error?: string | null
}

export function CategoryPicker({
  open,
  onOpenChange,
  title = "Choose a branch",
  description,
  ...rest
}: CategoryPickerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="pb-[env(safe-area-inset-bottom)]"
        data-testid="category-picker"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        {/* Mounted only while the sheet is open, so it starts where it was
            asked to every time without an effect reaching in. */}
        <PickerBody {...rest} />
      </SheetContent>
    </Sheet>
  )
}

function PickerBody({
  initial,
  onChoose,
  offered,
  allowTop = false,
  chooseLabel = "Choose this branch",
  pending = false,
  error,
}: Omit<CategoryPickerProps, "open" | "onOpenChange" | "title" | "description">) {
  const tree = useCategoryTree()
  const branches = React.useMemo(() => tree.data?.branches ?? [], [tree.data])
  const isOffered = React.useCallback(
    (branch: CategoryBranch) => branch.visible && (!offered || offered(branch)),
    [offered]
  )

  const [at, setAt] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")

  // Where the picker opens, once the tree is here: the asked-for branch when
  // it can be offered, else the top.
  const start = React.useMemo(() => {
    const branch = branchById(branches, initial)
    return branch && isOffered(branch) ? branch.id : ""
  }, [branches, initial, isOffered])
  const current = at ?? start
  const here = branchById(branches, current)

  const rows = childrenOf(branches, current).filter(isOffered)
  const results = query.trim()
    ? searchBranches(branches, query, { offered: isOffered })
    : []
  const steps = [
    { id: "", name: "All branches" },
    ...trailOf(branches, current).map((branch) => ({ id: branch.id, name: branch.name })),
  ]

  function go(id: string) {
    setAt(id)
    setQuery("")
  }

  const canChoose = Boolean(here) || allowTop

  return (
    <>
      <SheetBody className="flex flex-col gap-5">
        <Input
          leadingIcon={<SearchIcon />}
          placeholder="Search every branch"
          aria-label="Search every branch"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="category-picker-search"
        />

        {tree.isPending ? (
          <div className="flex flex-col gap-3" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : tree.isError ? (
          <p role="alert" className="text-[15px] text-destructive">
            {refusalOrFallback(tree.error, "The branches did not load. Check the connection and try again.")}
          </p>
        ) : query.trim() ? (
          results.length === 0 ? (
            <p className="text-[15px] text-muted-foreground">
              No branch matches that. Check the spelling, or go down the tree.
            </p>
          ) : (
            <ul aria-label="Branches found" data-testid="category-picker-results" className="border-t border-hairline-soft">
              {results.map((match) => (
                <li key={match.branch.id}>
                  <button
                    type="button"
                    onClick={() => go(match.branch.id)}
                    className="flex min-h-14 w-full items-center justify-between gap-4 border-b border-hairline-soft py-3 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                  >
                    <span className="min-w-0 text-[15px] leading-[1.4]">
                      {match.levels.map((level, index) => (
                        <React.Fragment key={index}>
                          {index > 0 ? <span className="text-muted-foreground-2"> / </span> : null}
                          <span
                            className={
                              level.match ? "text-foreground" : "text-muted-foreground-2"
                            }
                          >
                            {level.name}
                          </span>
                        </React.Fragment>
                      ))}
                    </span>
                    <span className="tnum shrink-0 text-[13px] text-muted-foreground-2">
                      {match.branch.counts.items_total}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <Breadcrumb label="Where you are" steps={steps} onStep={go} />
            {rows.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">
                {here ? `Nothing beneath ${here.name}.` : "There are no branches yet."}
              </p>
            ) : (
              <ul
                aria-label={here ? `Branches in ${here.name}` : "Branches"}
                data-testid="category-picker-rows"
                className="border-t border-hairline-soft"
              >
                {rows.map((branch) => {
                  const deeper = childrenOf(branches, branch.id).some(isOffered)
                  return (
                    <li key={branch.id}>
                      <button
                        type="button"
                        onClick={() => go(branch.id)}
                        className="flex min-h-14 w-full items-center justify-between gap-4 border-b border-hairline-soft py-3 text-left outline-none transition-colors duration-150 ease-gg hover:bg-row-hover focus-visible:bg-row-hover"
                      >
                        <span className="min-w-0 truncate text-[16px] text-foreground">
                          {branch.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="tnum text-[13px] text-muted-foreground-2">
                            {branch.counts.items_total}
                          </span>
                          {deeper ? (
                            <ChevronRightIcon
                              aria-hidden="true"
                              className="size-5 stroke-[1.25] text-foreground"
                            />
                          ) : (
                            <span aria-hidden="true" className="size-5" />
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-3 border-t border-hairline-soft">
        <p className="text-[13px] leading-[1.45] text-muted-foreground" data-testid="category-picker-current">
          {here ? here.path : allowTop ? "The top level" : "Go into a branch to choose it."}
        </p>
        {error ? (
          <p role="alert" className="text-[13px] leading-[1.45] text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          trailingArrow
          className="w-full"
          disabled={!canChoose}
          loading={pending}
          onClick={() => onChoose(here ?? null)}
        >
          {chooseLabel}
        </Button>
      </SheetFooter>
    </>
  )
}
