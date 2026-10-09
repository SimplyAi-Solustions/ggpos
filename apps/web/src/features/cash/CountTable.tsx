/**
 * The drawer count (DESIGN.md section 10, "Cashing up"): a hairline table,
 * one row per denomination from £50 down to 1p, the denomination in Jost
 * 500, a count field (underline, numeric keyboard, 56px tall) and the row's
 * total right-aligned, with the running total under it in Jost 500 at 20px.
 *
 * From 900px the keypad sits beside the table and types into the count
 * last touched, so the tablet never needs its on-screen keyboard. The row
 * being typed into is tinted, the way a row under the pointer is, so it is
 * plain which count the keypad is filling even after a key has taken the
 * focus.
 *
 * It says nothing about what the drawer should hold: the Z count is blind
 * until it is saved, and the same table counts the opening float.
 */
import * as React from "react"
import { cn } from "cn"
import { DENOMINATIONS, formatGBP, type Denomination } from "@gg/shared"

import { Input } from "@/components/ui/input"
import { Keypad, applyKey, type KeypadKey } from "@/components/ui/keypad"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  countsFromFields,
  countsTotal,
  denominationLabel,
  parseCountField,
  rowTotal,
  type CountFields,
} from "@/features/cash/count"

export function CountTable({
  idPrefix,
  fields,
  onChange,
  label,
  totalLabel = "Counted",
}: {
  idPrefix: string
  fields: CountFields
  onChange: (next: CountFields) => void
  /** Names the table for a screen reader, e.g. "Count the drawer". */
  label: string
  totalLabel?: string
}) {
  const [active, setActive] = React.useState<Denomination>(DENOMINATIONS[0])
  const inputs = React.useRef(new Map<Denomination, HTMLInputElement>())
  const total = countsTotal(countsFromFields(fields))

  const set = (value: Denomination, text: string) => {
    onChange({ ...fields, [`${value}`]: text.replace(/[^\d]/g, "").slice(0, 5) })
  }

  const press = (key: KeypadKey) => {
    const current = fields[`${active}`] ?? ""
    set(active, applyKey(current, key, 5))
    inputs.current.get(active)?.focus({ preventScroll: true })
  }

  return (
    <div className="flex flex-col gap-10 min-[900px]:flex-row min-[900px]:items-start min-[900px]:gap-12">
      <div className="min-w-0 flex-1">
        <Table aria-label={label} data-testid={`${idPrefix}-count`}>
          <TableHeader>
            <TableRow>
              <TableHead>Denomination</TableHead>
              <TableHead>Count</TableHead>
              <TableHead numeric>Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {DENOMINATIONS.map((value) => {
              const text = fields[`${value}`] ?? ""
              const count = parseCountField(text)
              const invalid = count === null
              const id = `${idPrefix}-${value}`
              return (
                <TableRow
                  key={value}
                  data-active={active === value || undefined}
                  className="min-[900px]:data-[active]:bg-row-hover"
                >
                  <TableCell className="w-28 text-[16px] font-medium">
                    <label htmlFor={id}>{denominationLabel(value)}</label>
                  </TableCell>
                  <TableCell className="py-1">
                    <Input
                      id={id}
                      ref={(element: HTMLInputElement | null) => {
                        if (element) inputs.current.set(value, element)
                        else inputs.current.delete(value)
                      }}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="0"
                      containerClassName="min-h-14 max-sm:min-h-14 max-w-[8rem] pt-3"
                      className="tnum"
                      aria-label={`How many ${denominationLabel(value)}`}
                      aria-invalid={invalid || undefined}
                      value={text}
                      onFocus={() => setActive(value)}
                      onChange={(event) => set(value, event.target.value)}
                    />
                  </TableCell>
                  <TableCell numeric className="text-[16px]">
                    {count ? formatGBP(rowTotal(value, count)) : ""}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="mt-6 flex items-baseline justify-between gap-6">
          <MicroLabel tone="ink">{totalLabel}</MicroLabel>
          <span
            data-testid={`${idPrefix}-total`}
            aria-live="polite"
            className="tnum text-[20px] leading-none font-medium text-foreground"
          >
            {formatGBP(total)}
          </span>
        </p>
      </div>

      {/* The tablet's keypad. A press keeps the caret in the count it is
          filling rather than moving the focus to the key. */}
      <div
        className={cn("hidden w-[320px] shrink-0 min-[900px]:sticky min-[900px]:top-8 min-[900px]:block")}
        onMouseDown={(event) => event.preventDefault()}
      >
        <MicroLabel className="mb-3">
          {denominationLabel(active)} count
        </MicroLabel>
        <Keypad mode="pin" aria-label={`Count of ${denominationLabel(active)}`} onKey={press} />
      </div>
    </div>
  )
}
