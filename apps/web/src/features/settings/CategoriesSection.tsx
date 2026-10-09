/**
 * Settings, Categories (docs/api-contract-inventory.md, section 1.6): the
 * stock category tree, kept by a manager or an admin, taking effect the
 * moment each change is made rather than on the page's Save.
 *
 * The tree is an indented list, the top level open and the rest closed at
 * first, and whatever is opened or closed remembered by this browser. Each
 * row has its shelf count and its own actions: add a branch beneath it,
 * rename it in place, move it, its defaults and picture, switch it off or
 * on, and delete it when it is empty (the server says what is still in one
 * that is not). A switched-off branch and everything beneath it are grey.
 *
 * Rows move by drag, touch first: the grip on each row drags straight away
 * with any pointer, and a long press anywhere on a row drags it on a touch
 * screen. The top and bottom edges of a row put the branch beside it, the
 * middle puts it inside. "Move to" in the row's menu does the same through
 * the picker, and the grip takes the arrow keys, for a keyboard. Every
 * move and reorder goes through the routes, and the list redraws from the
 * tree they answer.
 *
 * Unsorted shows its count and "File these": tick the rows, choose a
 * branch, and they are filed with `assign`.
 */
import * as React from "react"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CATEGORY_KINDS,
  UNSORTED_KEY,
  type CategoryBranch,
  type CategoryKind,
  type CategoryTaxScheme,
  type CategoryTree,
} from "@gg/shared"
import { ChevronRightIcon, EllipsisIcon, GripVerticalIcon } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { ProductImage } from "@/components/product-image"
import { CategoryPicker } from "@/features/categories/CategoryPicker"
import { RowCheck } from "@/features/categories/RowCheck"
import {
  branchById,
  canTake,
  childrenOf,
  defaultOpen,
  lastLevels,
  planDrop,
  planMoveTo,
  planNudge,
  shownRows,
  zoneFor,
  type DropPlan,
  type DropZone,
} from "@/features/categories/tree"
import { OverrideCancelled } from "@/features/lock/override"
import { listGames, listItems } from "@/lib/api"
import {
  CATEGORY_TREE_KEY,
  assignCategory,
  createCategory,
  deleteCategory,
  listPlatforms,
  listProductsInCategory,
  moveCategory,
  reorderCategories,
  updateCategory,
  useCategoryTree,
} from "@/lib/api/categories"
import { refusalOrFallback } from "@/lib/api/refusal"

const OPEN_KEY = "gg-category-tree-open"
/** How far each level steps in: less on a phone, where eight levels must fit. */
const INDENT = "var(--gg-category-indent)"
const LONG_PRESS_MS = 450
const NONE = "none"

const KIND_LABELS: Record<CategoryKind, string> = {
  single: "Card single",
  graded: "Graded card",
  retro: "Retro game",
  sealed: "Sealed product",
  accessory: "Accessory",
  other: "Other",
}

const TAX_LABELS: Record<CategoryTaxScheme, string> = {
  margin: "Margin scheme",
  standard: "Standard rate",
  exempt: "Exempt",
}

function readOpen(): string[] | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null
  } catch {
    return null
  }
}

function writeOpen(ids: string[]): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids))
  } catch {
    // Private browsing: the tree still opens and closes, it is just not remembered.
  }
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
  )
}

/** The refusal to show for a failed write, or null when a manager's approval was cancelled. */
function problemOf(error: unknown, fallback: string): string | null {
  if (error instanceof OverrideCancelled) return null
  return refusalOrFallback(error, fallback)
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

interface DragView {
  id: string
  target: string | null
  zone: DropZone | null
  plan: DropPlan | null
}

interface RowProps {
  branch: CategoryBranch
  open: boolean
  hasChildren: boolean
  drag: DragView | null
  renaming: boolean
  confirmingDelete: boolean
  rowError: string | null
  busy: boolean
  onToggle: () => void
  onGrip: (event: React.PointerEvent) => void
  onLongPress: (event: React.PointerEvent) => void
  onNudge: (step: -1 | 1) => void
  onAdd: () => void
  onRename: () => void
  onRenamed: (name: string) => void
  onCancelRename: () => void
  onMove: () => void
  onDefaults: () => void
  onSwitch: () => void
  onDelete: () => void
  onConfirmDelete: () => void
  onKeep: () => void
  onFile: () => void
}

function BranchRow({
  branch,
  open,
  hasChildren,
  drag,
  renaming,
  confirmingDelete,
  rowError,
  busy,
  onToggle,
  onGrip,
  onLongPress,
  onNudge,
  onAdd,
  onRename,
  onRenamed,
  onCancelRename,
  onMove,
  onDefaults,
  onSwitch,
  onDelete,
  onConfirmDelete,
  onKeep,
  onFile,
}: RowProps) {
  const [name, setName] = React.useState(branch.name)
  const unsorted = branch.key === UNSORTED_KEY
  const dragging = drag?.id === branch.id
  const targeted = drag && drag.target === branch.id && drag.plan && "route" in drag.plan
  const zone = targeted ? drag.zone : null
  const grey = !branch.visible
  const count = unsorted ? branch.counts.items : branch.counts.items_total

  return (
    <li
      data-branch-row={branch.id}
      data-testid="category-row"
      data-name={branch.name}
      className={cn("relative", dragging && "opacity-60")}
    >
      {zone === "before" || zone === "after" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-0 z-10 h-0.5 bg-foreground",
            zone === "before" ? "-top-px" : "-bottom-px"
          )}
          style={{ left: `calc(${branch.depth} * ${INDENT} + 48px)` }}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-14 items-center gap-1 border-b border-hairline-soft pr-0 select-none",
          "transition-colors duration-150 ease-gg",
          zone === "inside" && "bg-row-hover ring-1 ring-foreground ring-inset"
        )}
        style={{ paddingLeft: `calc(${branch.depth} * ${INDENT})` }}
        onPointerDown={onLongPress}
        onContextMenu={(event) => {
          if (drag) event.preventDefault()
        }}
      >
        <button
          type="button"
          aria-label={`Drag ${branch.name}. Arrow keys move it up or down.`}
          data-testid="category-grip"
          className="flex size-12 shrink-0 cursor-grab touch-none items-center justify-center rounded-[var(--radius)] text-muted-foreground-2 outline-none hover:text-foreground focus-visible:text-foreground active:cursor-grabbing"
          onPointerDown={(event) => {
            event.stopPropagation()
            onGrip(event)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault()
              onNudge(event.key === "ArrowUp" ? -1 : 1)
            }
          }}
        >
          <GripVerticalIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
        </button>
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Close" : "Open"} ${branch.name}`}
            className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-foreground outline-none hover:bg-secondary focus-visible:bg-secondary"
            onClick={onToggle}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-5 stroke-[1.25] transition-transform duration-150 ease-gg",
                open && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-10 shrink-0" />
        )}

        {renaming ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-1 py-1"
            onSubmit={(event) => {
              event.preventDefault()
              onRenamed(name)
            }}
          >
            <Input
              autoFocus
              aria-label={`New name for ${branch.name}`}
              maxLength={60}
              value={name}
              containerClassName="min-w-40 flex-1"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  onCancelRename()
                }
              }}
            />
            <span className="flex items-center gap-6">
              <Button type="submit" variant="text" loading={busy}>
                Save
              </Button>
              <Button type="button" variant="text" onClick={onCancelRename}>
                Cancel
              </Button>
            </span>
          </form>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span
              data-testid="category-name"
              className={cn("min-w-0 truncate text-[15px]", grey ? "text-muted-foreground-2" : "text-foreground")}
            >
              {branch.name}
            </span>
            {branch.active ? null : <Hint>Switched off</Hint>}
          </span>
        )}

        {renaming ? null : (
          <>
            {unsorted && count + branch.counts.products > 0 ? (
              <Button variant="text" className="mr-2" onClick={onFile}>
                File these
              </Button>
            ) : null}
            <span
              className={cn(
                "tnum w-12 shrink-0 text-right text-[13px]",
                grey ? "text-muted-foreground-2" : "text-muted-foreground"
              )}
              aria-label={`${count} on the shelf`}
            >
              {count}
            </span>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost-icon"
                    className="size-12 shrink-0"
                    aria-label={`More for ${branch.name}`}
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuContent className="min-w-60">
                <MenuItem className="min-h-12" onClick={onAdd}>
                  Add a branch beneath
                </MenuItem>
                <MenuItem className="min-h-12" onClick={onRename}>
                  Rename
                </MenuItem>
                <MenuItem className="min-h-12" onClick={onMove}>
                  Move to
                </MenuItem>
                <MenuItem className="min-h-12" onClick={onDefaults}>
                  Defaults and picture
                </MenuItem>
                {unsorted ? null : (
                  <>
                    <MenuItem className="min-h-12" onClick={onSwitch}>
                      {branch.active ? "Switch off" : "Switch on"}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem className="min-h-12 text-destructive" onClick={onDelete}>
                      Delete
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>
          </>
        )}
      </div>

      {confirmingDelete ? (
        <div
          className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-hairline-soft py-3"
          style={{ paddingLeft: `calc(${branch.depth} * ${INDENT} + 88px)` }}
        >
          <span className="text-[15px] text-foreground">Delete {branch.name} for good?</span>
          <span className="flex items-center gap-6">
            <Button variant="text-destructive" loading={busy} onClick={onConfirmDelete}>
              Delete {branch.name}
            </Button>
            <Button variant="text" onClick={onKeep}>
              Keep
            </Button>
          </span>
        </div>
      ) : null}
      {rowError ? (
        <p
          role="alert"
          className="border-b border-hairline-soft py-3 text-[13px] leading-[1.45] text-destructive"
          style={{ paddingLeft: `calc(${branch.depth} * ${INDENT} + 88px)` }}
        >
          {rowError}
        </p>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// The sheets
// ---------------------------------------------------------------------------

function AddForm({
  parent,
  branches,
  onDone,
  onCancel,
}: {
  parent: CategoryBranch | null
  branches: CategoryBranch[]
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState("")
  const [problem, setProblem] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) {
      setProblem("Give the branch a name.")
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const siblings = childrenOf(branches, parent?.id ?? "")
      await createCategory({
        name: clean,
        parent: parent?.id ?? "",
        sort: Math.max(0, ...siblings.map((branch) => branch.sort)) + 10,
      })
      onDone(clean)
    } catch (error) {
      setProblem(problemOf(error, "The branch was not added. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label="Add a branch">
      <SheetBody>
        <Field layout="stacked" label="Name" htmlFor="branch-name" error={problem}>
          <Input
            id="branch-name"
            autoFocus
            autoComplete="off"
            maxLength={60}
            placeholder="Promos"
            value={name}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <p className="mt-6 text-[13px] leading-[1.45] text-muted-foreground-2">
          {parent ? `Beneath ${parent.path}, last.` : "At the top level, last."}
        </p>
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Add branch
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

function DefaultsForm({
  branch,
  onDone,
  onCancel,
}: {
  branch: CategoryBranch
  onDone: () => void
  onCancel: () => void
}) {
  const games = useQuery({ queryKey: ["games"], queryFn: listGames, staleTime: 5 * 60_000 })
  const platforms = useQuery({ queryKey: ["platforms"], queryFn: listPlatforms, staleTime: 5 * 60_000 })
  const [kind, setKind] = React.useState<string>(branch.defaults.kind || NONE)
  const [game, setGame] = React.useState<string>(branch.defaults.game || NONE)
  const [platform, setPlatform] = React.useState<string>(branch.defaults.platform || NONE)
  const [tax, setTax] = React.useState<string>(branch.defaults.tax_scheme || NONE)
  const [image, setImage] = React.useState<File | null | undefined>(undefined)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const preview = React.useMemo(
    () => (image ? URL.createObjectURL(image) : image === null ? "" : branch.image_url),
    [image, branch.image_url]
  )
  React.useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(preview)
    },
    [image, preview]
  )

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setProblem(null)
    try {
      await updateCategory(branch.id, {
        default_kind: kind === NONE ? "" : (kind as CategoryKind),
        default_game: game === NONE ? "" : game,
        default_platform: platform === NONE ? "" : platform,
        default_tax_scheme: tax === NONE ? "" : (tax as CategoryTaxScheme),
        ...(image === undefined ? {} : { image }),
      })
      onDone()
    } catch (error) {
      setProblem(problemOf(error, "The defaults did not save. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const choice = (
    label: string,
    id: string,
    value: string,
    onChange: (next: string) => void,
    options: { value: string; label: string }[]
  ) => (
    <Field layout="stacked" label={label} htmlFor={id}>
      <Select value={value} onValueChange={(next) => onChange((next as string | null) ?? NONE)}>
        <SelectTrigger id={id}>
          <SelectValue>
            {(current: string) =>
              options.find((option) => option.value === current)?.label ?? "No default"
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No default</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col" aria-label={`Defaults for ${branch.name}`}>
      <SheetBody>
        <FieldRow>
          {choice(
            "Kind",
            "branch-kind",
            kind,
            setKind,
            CATEGORY_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))
          )}
          {choice(
            "Game",
            "branch-game",
            game,
            setGame,
            (games.data ?? []).map((row) => ({ value: row.id, label: row.name }))
          )}
          {choice(
            "Platform",
            "branch-platform",
            platform,
            setPlatform,
            (platforms.data ?? []).map((row) => ({ value: row.id, label: row.name }))
          )}
          {choice(
            "VAT treatment",
            "branch-vat",
            tax,
            setTax,
            (Object.keys(TAX_LABELS) as CategoryTaxScheme[]).map((value) => ({
              value,
              label: TAX_LABELS[value],
            }))
          )}
          <Field layout="stacked" label="Picture" htmlFor="branch-image">
            <div className="flex flex-col items-start gap-4">
              {preview ? (
                <ProductImage src={preview} alt="" platform="other" height={88} />
              ) : (
                <p className="text-[13px] text-muted-foreground-2">
                  No picture: the till shows a folder.
                </p>
              )}
              <input
                id="branch-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="max-w-full text-[13px] text-muted-foreground file:mr-4 file:h-10 file:cursor-pointer file:rounded-[var(--radius)] file:border file:border-hairline file:bg-transparent file:px-4 file:font-mono file:text-[11px] file:font-bold file:tracking-[0.16em] file:text-foreground file:uppercase"
                onChange={(event) => setImage(event.target.files?.[0] ?? undefined)}
              />
              {preview ? (
                <Button type="button" variant="text-destructive" onClick={() => setImage(null)}>
                  Take the picture off
                </Button>
              ) : null}
            </div>
          </Field>
        </FieldRow>
        <p className="mt-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Add stock fills these in when this branch is chosen. Staff can still change each one.
        </p>
        {problem ? (
          <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
            {problem}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={busy}>
          Save defaults
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

function FileList({
  unsorted,
  onChoose,
  onCancel,
}: {
  unsorted: CategoryBranch
  onChoose: (items: string[], products: string[]) => void
  onCancel: () => void
}) {
  const stock = useInfiniteQuery({
    queryKey: ["items", "unsorted", unsorted.id],
    queryFn: ({ pageParam }) => listItems({ category: unsorted.id }, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  })
  const products = useQuery({
    queryKey: ["category-products", unsorted.id],
    queryFn: () => listProductsInCategory(unsorted.id),
  })
  const rows = stock.data?.pages.flatMap((page) => page.items) ?? []
  const [items, setItems] = React.useState<string[]>([])
  const [chosenProducts, setChosenProducts] = React.useState<string[]>([])
  const total = items.length + chosenProducts.length

  function flip(list: string[], id: string, on: boolean): string[] {
    return on ? [...list.filter((entry) => entry !== id), id] : list.filter((entry) => entry !== id)
  }

  return (
    <>
      <SheetBody>
        <div className="flex flex-wrap items-center justify-between gap-4 pb-3">
          <MicroLabel tone="ink">
            {rows.length + (products.data?.length ?? 0)} in Unsorted
          </MicroLabel>
          <Button
            variant="text"
            onClick={() => {
              setItems(rows.map((row) => row.id))
              setChosenProducts((products.data ?? []).map((row) => row.id))
            }}
          >
            Choose all
          </Button>
        </div>
        {stock.isPending || products.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length + (products.data?.length ?? 0) === 0 ? (
          <p className="text-[15px] text-muted-foreground">Unsorted is empty. Everything is filed.</p>
        ) : (
          <ul className="border-t border-hairline-soft" data-testid="unsorted-rows">
            {rows.map((row) => (
              <li key={row.id}>
                <label className="flex min-h-14 cursor-pointer items-center gap-4 border-b border-hairline-soft py-2">
                  <RowCheck
                    label={`Choose ${row.title}`}
                    checked={items.includes(row.id)}
                    onChange={(on) => setItems((now) => flip(now, row.id, on))}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] text-foreground">{row.title}</span>
                    <span className="tnum truncate font-mono text-[13px] text-muted-foreground-2">
                      {row.sku}
                      {row.status === "in_stock" ? "" : `, ${row.status.replace("_", " ")}`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {(products.data ?? []).map((product) => (
              <li key={product.id}>
                <label className="flex min-h-14 cursor-pointer items-center gap-4 border-b border-hairline-soft py-2">
                  <RowCheck
                    label={`Choose ${product.name}`}
                    checked={chosenProducts.includes(product.id)}
                    onChange={(on) => setChosenProducts((now) => flip(now, product.id, on))}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] text-foreground">{product.name}</span>
                    <Hint>Till product</Hint>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {stock.hasNextPage ? (
          <div className="mt-4">
            <Button
              variant="text"
              loading={stock.isFetchingNextPage}
              onClick={() => void stock.fetchNextPage()}
            >
              Show more
            </Button>
          </div>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button
          trailingArrow
          disabled={total === 0}
          onClick={() => onChoose(items, chosenProducts)}
        >
          Choose a branch
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

type SheetState =
  | { kind: "add"; parent: string }
  | { kind: "defaults"; id: string }
  | { kind: "file" }
  | null

type PickerState =
  | { kind: "move"; id: string }
  | { kind: "file"; items: string[]; products: string[] }
  | null

interface DragSession extends DragView {
  pointerId: number
  x: number
  y: number
  /** The pointer has left where the drag began, so the page may scroll for it. */
  moved: boolean
}

export function CategoriesSection() {
  const queryClient = useQueryClient()
  const tree = useCategoryTree()
  const branches = React.useMemo(() => tree.data?.branches ?? [], [tree.data])

  const [openIds, setOpenIds] = React.useState<string[] | null>(readOpen)
  const open = React.useMemo(
    () => (openIds ? new Set(openIds) : defaultOpen(branches)),
    [openIds, branches]
  )
  const [sheet, setSheet] = React.useState<SheetState>(null)
  const [picker, setPicker] = React.useState<PickerState>(null)
  const [pickerError, setPickerError] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [said, setSaid] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [drag, setDrag] = React.useState<DragSession | null>(null)

  const rows = shownRows(branches, open)
  const unsorted = branches.find((branch) => branch.key === UNSORTED_KEY)

  function setOpen(next: Set<string>) {
    const ids = [...next]
    setOpenIds(ids)
    writeOpen(ids)
  }

  function toggle(id: string) {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

  /** Every read the tree feeds: the paths on stock rows, the till's rail and folders. */
  function refreshAround() {
    for (const key of [["items"], ["item"], ["till-catalogue"], ["till-branch"]]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }

  async function reload() {
    await queryClient.invalidateQueries({ queryKey: CATEGORY_TREE_KEY })
    refreshAround()
  }

  /** A drop, a nudge or a "Move to": through the route, then redrawn from its answer. */
  const run = React.useCallback(
    async (plan: DropPlan | null): Promise<string | null> => {
      if (!plan) return null
      if ("problem" in plan) return plan.problem
      setBusy(true)
      setError(null)
      try {
        const next =
          plan.route === "reorder"
            ? await reorderCategories(plan.parent, plan.order)
            : await moveCategory(plan.id, {
                parent: plan.parent,
                ...(plan.before ? { before: plan.before } : {}),
              })
        // Redrawn from the tree the route answered, not from what was asked.
        queryClient.setQueryData<CategoryTree>(CATEGORY_TREE_KEY, next)
        for (const key of [["items"], ["item"], ["till-catalogue"], ["till-branch"]]) {
          void queryClient.invalidateQueries({ queryKey: key })
        }
        // A branch moved into a closed one would vanish; open its new parent.
        if (plan.route === "move" && plan.parent) {
          setOpenIds((now) => {
            const ids = [...new Set([...(now ?? []), ...(now ? [] : defaultOpen(next.branches)), plan.parent])]
            writeOpen(ids)
            return ids
          })
        }
        setSaid(plan.sentence.replace(/^Put /, "Moved ").replace(/^Move /, "Moved "))
        return null
      } catch (cause) {
        return problemOf(cause, "That did not move. Reload and try again.")
      } finally {
        setBusy(false)
      }
    },
    [queryClient]
  )

  // ---- Dragging -----------------------------------------------------------

  const branchesRef = React.useRef(branches)
  React.useEffect(() => {
    branchesRef.current = branches
  }, [branches])
  const dragRef = React.useRef<DragSession | null>(null)
  const pressTimer = React.useRef<number | null>(null)

  const startDrag = React.useCallback((id: string, pointerId: number, x: number, y: number) => {
    const session: DragSession = {
      id,
      pointerId,
      x,
      y,
      moved: false,
      target: null,
      zone: null,
      plan: null,
    }
    dragRef.current = session
    setDrag(session)
    setError(null)
    setSaid(null)
  }, [])

  const dragging = drag !== null
  React.useEffect(() => {
    if (!dragging) return undefined
    let frame = 0

    function locate(x: number, y: number) {
      const session = dragRef.current
      if (!session) return
      const moved = session.moved || Math.hypot(x - session.x, y - session.y) > 4
      const row = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-branch-row]")
      const target = row?.dataset.branchRow ?? null
      let zone: DropZone | null = null
      let plan: DropPlan | null = null
      if (row && target) {
        const rect = row.getBoundingClientRect()
        zone = zoneFor(y - rect.top, rect.height)
        plan = planDrop(branchesRef.current, session.id, target, zone)
      }
      // Where the drag began is kept until it has moved, so the first few
      // pixels of a press are not read as a scroll toward an edge.
      const next = moved
        ? { ...session, x, y, moved, target, zone, plan }
        : { ...session, target, zone, plan }
      dragRef.current = next
      setDrag(next)
    }

    function move(event: PointerEvent) {
      if (event.pointerId !== dragRef.current?.pointerId) return
      locate(event.clientX, event.clientY)
    }

    function finish(event: PointerEvent) {
      if (event.pointerId !== dragRef.current?.pointerId) return
      const session = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (event.type !== "pointerup" || !session?.plan) return
      void run(session.plan).then((problem) => {
        if (problem) setError(problem)
      })
    }

    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      dragRef.current = null
      setDrag(null)
    }

    // A touch drag must not scroll the page under the finger.
    function hold(event: TouchEvent) {
      event.preventDefault()
    }

    // Near the top or the bottom of the window, the page scrolls itself,
    // and what is under the pointer is read again as the rows pass.
    function edge() {
      const session = dragRef.current
      if (session?.moved) {
        const band = 72
        const step = session.y < band ? -10 : session.y > window.innerHeight - band ? 10 : 0
        if (step !== 0) {
          window.scrollBy(0, step)
          locate(session.x, session.y)
        }
      }
      frame = window.requestAnimationFrame(edge)
    }
    frame = window.requestAnimationFrame(edge)

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
    window.addEventListener("keydown", escape)
    document.addEventListener("touchmove", hold, { passive: false })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      window.removeEventListener("keydown", escape)
      document.removeEventListener("touchmove", hold)
    }
  }, [dragging, run])

  function grip(id: string, event: React.PointerEvent) {
    if (event.button !== 0 && event.pointerType === "mouse") return
    event.preventDefault()
    startDrag(id, event.pointerId, event.clientX, event.clientY)
  }

  /** On a touch screen, a long press anywhere on the row picks it up. */
  function longPress(id: string, event: React.PointerEvent) {
    if (event.pointerType !== "touch") return
    if ((event.target as Element).closest("button, input, a, [role='menuitem']")) return
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const element = event.currentTarget
    const cancel = () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
      pressTimer.current = null
      element.removeEventListener("pointermove", wander)
      element.removeEventListener("pointerup", cancel)
      element.removeEventListener("pointercancel", cancel)
    }
    function wander(next: Event) {
      const point = next as PointerEvent
      if (Math.hypot(point.clientX - startX, point.clientY - startY) > 8) cancel()
    }
    element.addEventListener("pointermove", wander)
    element.addEventListener("pointerup", cancel)
    element.addEventListener("pointercancel", cancel)
    pressTimer.current = window.setTimeout(() => {
      cancel()
      navigator.vibrate?.(30)
      startDrag(id, pointerId, startX, startY)
    }, LONG_PRESS_MS)
  }

  // ---- The other writes ---------------------------------------------------

  async function rename(branch: CategoryBranch, name: string) {
    const clean = name.trim()
    if (clean === branch.name) {
      setRenaming(null)
      return
    }
    setBusy(true)
    setRowError(null)
    try {
      await updateCategory(branch.id, { name: clean })
      setRenaming(null)
      setSaid(`Renamed ${branch.name} to ${clean}.`)
      await reload()
    } catch (cause) {
      const problem = problemOf(cause, "The name did not save. Try again.")
      if (problem) setRowError({ id: branch.id, message: problem })
    } finally {
      setBusy(false)
    }
  }

  async function switchBranch(branch: CategoryBranch) {
    setRowError(null)
    try {
      await updateCategory(branch.id, { active: !branch.active })
      setSaid(
        branch.active
          ? `${branch.name} is switched off. It and everything beneath it are hidden from the till and the pickers.`
          : `${branch.name} is switched on.`
      )
      await reload()
    } catch (cause) {
      const problem = problemOf(cause, "That did not change. Try again.")
      if (problem) setRowError({ id: branch.id, message: problem })
    }
  }

  async function remove(branch: CategoryBranch) {
    setBusy(true)
    setRowError(null)
    try {
      await deleteCategory(branch.id)
      setDeleting(null)
      setSaid(`${branch.name} is deleted.`)
      await reload()
    } catch (cause) {
      setDeleting(null)
      const problem = problemOf(cause, "The branch was not deleted. Try again.")
      if (problem) setRowError({ id: branch.id, message: problem })
    } finally {
      setBusy(false)
    }
  }

  async function file(into: CategoryBranch, items: string[], products: string[]) {
    setBusy(true)
    setPickerError(null)
    try {
      const result = await assignCategory({ category: into.id, items, products })
      const count = result.items + result.products
      setPicker(null)
      setSaid(`${count} filed in ${lastLevels(into.path)}.`)
      await reload()
    } catch (cause) {
      setPickerError(problemOf(cause, "Those were not filed. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const moving = picker?.kind === "move" ? branchById(branches, picker.id) : undefined
  const defaultsFor = sheet?.kind === "defaults" ? branchById(branches, sheet.id) : undefined
  const addUnder = sheet?.kind === "add" ? (branchById(branches, sheet.parent) ?? null) : null
  const live =
    drag?.plan && "route" in drag.plan
      ? drag.plan.sentence
      : drag?.plan && "problem" in drag.plan
        ? drag.plan.problem
        : drag
          ? "Drop it on a row: the top or bottom edge puts it beside, the middle puts it inside."
          : said

  return (
    <section className="mt-24" aria-labelledby="categories-heading" data-testid="categories-section">
      <SectionHeading id="categories-heading">Categories</SectionHeading>
      <Note>
        The branches stock and till products are filed in, brand before type. The till
        browses them and Stock filters by them. Everything here takes effect straight
        away, not on Save.
      </Note>

      {/* What a drop will do, held at the top of the window while dragging
          so it is in view however far down the tree the finger is. */}
      <div
        className={cn("mt-8 min-h-12 py-3", drag && "sticky top-0 z-20 bg-background")}
        aria-live="polite"
        data-testid="categories-live"
      >
        {live ? (
          <p
            className={cn(
              "text-[13px] leading-[1.45]",
              drag?.plan && "problem" in drag.plan ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {live}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-4 text-[13px] leading-[1.45] text-destructive">
          {error}
        </p>
      ) : null}

      {tree.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : tree.isError ? (
        <p role="alert" className="text-[15px] text-destructive">
          {refusalOrFallback(tree.error, "The categories would not load. Try again.")}
        </p>
      ) : (
        <ul
          className="border-t border-hairline-soft [--gg-category-indent:16px] sm:[--gg-category-indent:28px]"
          data-testid="category-tree"
          aria-label="Categories"
        >
          {rows.map((branch) => (
            <BranchRow
              key={`${branch.id}-${renaming === branch.id ? "edit" : "view"}`}
              branch={branch}
              open={open.has(branch.id)}
              hasChildren={branch.counts.children > 0}
              drag={drag}
              renaming={renaming === branch.id}
              confirmingDelete={deleting === branch.id}
              rowError={rowError?.id === branch.id ? rowError.message : null}
              busy={busy}
              onToggle={() => toggle(branch.id)}
              onGrip={(event) => grip(branch.id, event)}
              onLongPress={(event) => longPress(branch.id, event)}
              onNudge={(step) =>
                void run(planNudge(branches, branch.id, step)).then((problem) => {
                  if (problem) setError(problem)
                })
              }
              onAdd={() => {
                setOpen(new Set([...open, branch.id]))
                setSheet({ kind: "add", parent: branch.id })
              }}
              onRename={() => {
                setRowError(null)
                setRenaming(branch.id)
              }}
              onRenamed={(name) => void rename(branch, name)}
              onCancelRename={() => setRenaming(null)}
              onMove={() => {
                setPickerError(null)
                setPicker({ kind: "move", id: branch.id })
              }}
              onDefaults={() => setSheet({ kind: "defaults", id: branch.id })}
              onSwitch={() => void switchBranch(branch)}
              onDelete={() => {
                setRowError(null)
                setDeleting(branch.id)
              }}
              onConfirmDelete={() => void remove(branch)}
              onKeep={() => setDeleting(null)}
              onFile={() => setSheet({ kind: "file" })}
            />
          ))}
        </ul>
      )}

      <div className="mt-6">
        <Button variant="text" onClick={() => setSheet({ kind: "add", parent: "" })}>
          Add a branch
        </Button>
      </div>

      <Sheet
        open={sheet !== null}
        onOpenChange={(next) => {
          if (!next) setSheet(null)
        }}
      >
        <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
          {sheet?.kind === "add" ? (
            <>
              <SheetHeader>
                <SheetTitle>Add a branch</SheetTitle>
                <SheetDescription>
                  Name it for what staff look for: the brand first, then the type.
                </SheetDescription>
              </SheetHeader>
              <AddForm
                parent={addUnder}
                branches={branches}
                onDone={(name) => {
                  setSheet(null)
                  setSaid(`${name} is added.`)
                  void reload()
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : sheet?.kind === "defaults" && defaultsFor ? (
            <>
              <SheetHeader>
                <SheetTitle>{defaultsFor.name}</SheetTitle>
                <SheetDescription>{defaultsFor.path}</SheetDescription>
              </SheetHeader>
              <DefaultsForm
                key={defaultsFor.id}
                branch={defaultsFor}
                onDone={() => {
                  setSheet(null)
                  setSaid(`Saved the defaults for ${defaultsFor.name}.`)
                  void reload()
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : sheet?.kind === "file" && unsorted ? (
            <>
              <SheetHeader>
                <SheetTitle>File these</SheetTitle>
                <SheetDescription>
                  Stock and till products the filing rules could not place. Tick them,
                  then choose where they go.
                </SheetDescription>
              </SheetHeader>
              <FileList
                unsorted={unsorted}
                onChoose={(items, products) => {
                  setSheet(null)
                  setPickerError(null)
                  setPicker({ kind: "file", items, products })
                }}
                onCancel={() => setSheet(null)}
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <CategoryPicker
        open={picker !== null}
        onOpenChange={(next) => {
          if (!next) setPicker(null)
        }}
        title={
          picker?.kind === "move" && moving
            ? `Move ${moving.name} to`
            : picker?.kind === "file"
              ? `File ${picker.items.length + picker.products.length}`
              : "Choose a branch"
        }
        description={
          picker?.kind === "move"
            ? "It goes last in the branch you choose, with everything beneath it."
            : "They move into the branch you choose."
        }
        initial={picker?.kind === "move" ? moving?.parent : null}
        allowTop={picker?.kind === "move"}
        offered={
          picker?.kind === "move" && moving
            ? (candidate) => canTake(moving.id, candidate)
            : (candidate) => candidate.key !== UNSORTED_KEY
        }
        pending={busy}
        error={pickerError}
        onChoose={(into) => {
          if (picker?.kind === "file") {
            if (into) void file(into, picker.items, picker.products)
            return
          }
          if (picker?.kind !== "move" || !moving) return
          const plan = planMoveTo(branches, moving.id, into?.id ?? "")
          if (!plan) {
            setPicker(null)
            setSaid(`${moving.name} is already there.`)
            return
          }
          void run(plan).then((problem) => {
            if (problem) setPickerError(problem)
            else setPicker(null)
          })
        }}
      />
    </section>
  )
}
