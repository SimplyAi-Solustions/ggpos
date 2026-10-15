/**
 * The rack (docs/api-contract-reorder.md, section 4.2): the supplier's
 * products as a hairline table from 900px and as one readable line each
 * below it, behind four chips. In Everything, Keep on shelf is a small
 * underline number field: Enter or leaving it saves the target on every row
 * of the product, and the line moves to its new place when the report comes
 * back.
 *
 * Decided in script rather than CSS (`useWide`), because the two layouts
 * carry fields: one Keep on shelf field per product, never a hidden copy.
 */
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { REORDER_STATUS_LABELS, type ReorderLine } from "@gg/shared"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useWide } from "@/features/till/use-wide"
import {
  noStockLine,
  RACK_VIEWS,
  rackEmptyLine,
  rackLines,
  shelfTargetFromText,
  type RackView,
} from "@/features/reorder/rack"

export interface RackProps {
  lines: ReorderLine[]
  view: RackView
  onViewChange: (view: RackView) => void
  supplierName: string
  /** "between 9 and 15 Oct 2026", for an empty Sold chip. */
  when: string
  saving: boolean
  onTarget: (line: ReorderLine, value: number | null) => void
  /** A target that cannot be saved, said once under the rack. */
  onProblem: (message: string) => void
}

function codesOf(line: ReorderLine): string {
  return [line.supplierCode, line.ean].filter(Boolean).join(" · ")
}

function Product({ line }: { line: ReorderLine }) {
  const codes = codesOf(line)
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <Link
        to="/counter/stock/$sku"
        params={{ sku: line.sku }}
        className="text-[15px] text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
      >
        {line.title}
      </Link>
      {codes ? (
        <span className="tnum font-mono text-[13px] text-muted-foreground-2">{codes}</span>
      ) : null}
    </span>
  )
}

/**
 * Keep on shelf as a small underline field. Keyed by its caller on the
 * saved target, so it starts again from the server's figure after a save.
 */
function TargetField({
  line,
  disabled,
  onTarget,
  onProblem,
}: {
  line: ReorderLine
  disabled: boolean
  onTarget: RackProps["onTarget"]
  onProblem: RackProps["onProblem"]
}) {
  const saved = line.shelfTarget > 0 ? String(line.shelfTarget) : ""
  const [text, setText] = React.useState(saved)
  const [invalid, setInvalid] = React.useState(false)

  function commit() {
    const parsed = shelfTargetFromText(text)
    if (!parsed.ok) {
      setInvalid(true)
      onProblem(`${parsed.message} ${line.title} still keeps ${saved || "no target"}.`)
      return
    }
    setInvalid(false)
    const current = line.shelfTarget > 0 ? line.shelfTarget : null
    if (parsed.value === current) {
      setText(saved)
      return
    }
    onTarget(line, parsed.value)
  }

  return (
    <Input
      aria-label={`Keep on shelf for ${line.title}`}
      inputMode="numeric"
      autoComplete="off"
      placeholder="None"
      disabled={disabled}
      // Shorter than a form field from 640px, so its figure sits on the
      // row's line with the others; a phone keeps the 48px target.
      containerClassName="ml-auto w-16 sm:min-h-0 sm:pt-1.5 sm:pb-1.5"
      className="tnum text-right"
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        setInvalid(false)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return
        event.preventDefault()
        // Leaving the field is what saves, so Enter saves exactly once.
        event.currentTarget.blur()
      }}
    />
  )
}

function Target({
  line,
  editable,
  ...field
}: {
  line: ReorderLine
  editable: boolean
  disabled: boolean
  onTarget: RackProps["onTarget"]
  onProblem: RackProps["onProblem"]
}) {
  if (editable) return <TargetField key={`${line.key}:${line.shelfTarget}`} line={line} {...field} />
  return line.shelfTarget > 0 ? (
    <span>{line.shelfTarget}</span>
  ) : (
    <span className="text-muted-foreground-2">None</span>
  )
}

function RackTable({
  lines,
  editable,
  ...field
}: {
  lines: ReorderLine[]
  editable: boolean
  disabled: boolean
  onTarget: RackProps["onTarget"]
  onProblem: RackProps["onProblem"]
}) {
  return (
    <Table data-testid="rack-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Product</TableHead>
          <TableHead numeric>In stock</TableHead>
          <TableHead numeric>Keep on shelf</TableHead>
          <TableHead numeric>Sold</TableHead>
          <TableHead numeric>To order</TableHead>
          <TableHead className="pl-8">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => (
          <TableRow key={line.key} data-testid="rack-row" data-product={line.title}>
            <TableCell className="py-3">
              <Product line={line} />
            </TableCell>
            <TableCell numeric data-testid="rack-in-stock">
              {line.inStock}
            </TableCell>
            <TableCell numeric data-testid="rack-target" className={editable ? "py-1" : undefined}>
              <Target line={line} editable={editable} {...field} />
            </TableCell>
            <TableCell numeric data-testid="rack-sold">
              {line.sold}
            </TableCell>
            <TableCell numeric data-testid="rack-to-order" className="font-medium">
              {line.toOrder}
            </TableCell>
            <TableCell data-testid="rack-status" className="pl-8 whitespace-nowrap">
              {REORDER_STATUS_LABELS[line.status]}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Below 900px: the product, then its figures in words, then its status. */
function RackList({
  lines,
  editable,
  ...field
}: {
  lines: ReorderLine[]
  editable: boolean
  disabled: boolean
  onTarget: RackProps["onTarget"]
  onProblem: RackProps["onProblem"]
}) {
  return (
    <ul data-testid="rack-list">
      {lines.map((line) => (
        <li
          key={line.key}
          data-testid="rack-row"
          data-product={line.title}
          className="border-b border-hairline-soft py-4 first:border-t"
        >
          <div className="flex items-baseline justify-between gap-4">
            <Product line={line} />
            {line.toOrder > 0 ? (
              <span data-testid="rack-to-order" className="tnum shrink-0 text-[15px] font-medium text-foreground">
                {line.toOrder} to order
              </span>
            ) : null}
          </div>
          <div className="tnum mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted-foreground">
            <span data-testid="rack-in-stock">{line.inStock} in stock</span>
            <span data-testid="rack-sold">{line.sold} sold</span>
            {editable ? (
              <span className="flex items-center gap-3">
                <span aria-hidden="true">Keep on shelf</span>
                <span data-testid="rack-target">
                  <Target line={line} editable {...field} />
                </span>
              </span>
            ) : line.shelfTarget > 0 ? (
              <span data-testid="rack-target">Keep on shelf {line.shelfTarget}</span>
            ) : null}
            <span data-testid="rack-status" className="text-foreground">
              {REORDER_STATUS_LABELS[line.status]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Rack({
  lines,
  view,
  onViewChange,
  supplierName,
  when,
  saving,
  onTarget,
  onProblem,
}: RackProps) {
  const wide = useWide()

  if (lines.length === 0) {
    return (
      <p data-testid="rack-empty" className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
        {noStockLine(supplierName)}
      </p>
    )
  }

  const shown = rackLines(lines, view)
  const editable = view === "all"
  const field = { editable, disabled: saving, onTarget, onProblem }

  return (
    <>
      <ChipGroup
        aria-label="Show"
        value={[view]}
        onValueChange={(next: string[]) => {
          const chosen = next[0] as RackView | undefined
          if (chosen) onViewChange(chosen)
        }}
      >
        {RACK_VIEWS.map((entry) => (
          <Chip key={entry.key} value={entry.key} data-testid={`rack-view-${entry.key}`}>
            {entry.label}
          </Chip>
        ))}
      </ChipGroup>

      {editable ? (
        <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Change Keep on shelf here. Enter, or leaving the field, saves it on every stock row of
          the product.
        </p>
      ) : null}

      <div className="mt-6">
        {shown.length === 0 ? (
          <p data-testid="rack-empty" className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
            {rackEmptyLine(view, supplierName, when)}
          </p>
        ) : wide ? (
          <RackTable lines={shown} {...field} />
        ) : (
          <RackList lines={shown} {...field} />
        )}
      </div>
    </>
  )
}
