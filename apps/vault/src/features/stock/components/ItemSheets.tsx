import * as React from "react"
import { Link } from "@tanstack/react-router"
import { displayCode } from "@gg/shared/sku"

import { Button, buttonClasses, Chip, Input, MoneyInput, Sheet } from "@/ui"

import { CONDITIONS, type InventoryItem, type NamedRecord } from "../types"
import { SelectField } from "./SelectField"

/** Location and quantity, the quick edit and the Move action. */
export function MoveSheet({
  open,
  onClose,
  item,
  locations,
  busy,
  onSave,
}: {
  open: boolean
  onClose: () => void
  item: InventoryItem
  locations: readonly NamedRecord[]
  busy: boolean
  onSave: (patch: { location?: string; qty?: number }) => void
}) {
  const [location, setLocation] = React.useState(item.location)
  const [qty, setQty] = React.useState(item.qty)
  // Start from the saved values each time the sheet opens.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setLocation(item.location)
      setQty(item.qty)
    }
  }
  const patch: { location?: string; qty?: number } = {}
  if (location !== item.location) patch.location = location
  if (qty !== item.qty) patch.qty = qty
  const dirty = Object.keys(patch).length > 0
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Location and quantity"
      description={displayCode(item.sku)}
      footer={
        <Button block size="lg" disabled={!dirty} loading={busy} onClick={() => onSave(patch)}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pt-2">
        <SelectField
          label="Location"
          value={location}
          onChange={setLocation}
          placeholder="Not shelved"
          options={locations.map((l) => ({ value: l.id, label: l.name }))}
        />
        <QtyStepper value={qty} onChange={setQty} />
      </div>
    </Sheet>
  )
}

export function QtyStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-mono text-fg-2" id="qty-label">
        Quantity
      </span>
      <div className="flex items-center gap-2" role="group" aria-labelledby="qty-label">
        <Button variant="secondary" className="w-14 text-xl" aria-label="One fewer" disabled={value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>
          -
        </Button>
        <output aria-live="polite" className="flex h-12 flex-1 items-center justify-center rounded-md border border-line-2 font-mono text-xl font-bold tnum">
          {value}
        </output>
        <Button variant="secondary" className="w-14 text-xl" aria-label="One more" onClick={() => onChange(value + 1)}>
          +
        </Button>
      </div>
      {value === 0 && <p className="text-sm text-warn">At 0 the item stays on file but shows as out of stock.</p>}
    </div>
  )
}

/** Name, condition, cost and notes: what the old edit form held. */
export function EditDetailsSheet({
  open,
  onClose,
  item,
  busy,
  onSave,
}: {
  open: boolean
  onClose: () => void
  item: InventoryItem
  busy: boolean
  onSave: (patch: { title?: string; condition?: string; cost?: number; notes?: string }) => void
}) {
  const [form, setForm] = React.useState({ title: item.title, condition: item.condition, cost: item.cost as number | null, notes: item.notes })
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setForm({ title: item.title, condition: item.condition, cost: item.cost, notes: item.notes })
  }
  const patch: { title?: string; condition?: string; cost?: number; notes?: string } = {}
  if (form.title.trim() && form.title.trim() !== item.title) patch.title = form.title.trim()
  if (form.condition !== item.condition) patch.condition = form.condition
  if ((form.cost ?? 0) !== item.cost) patch.cost = form.cost ?? 0
  if (form.notes !== item.notes) patch.notes = form.notes
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit details"
      description={displayCode(item.sku)}
      footer={
        <Button block size="lg" disabled={Object.keys(patch).length === 0} loading={busy} onClick={() => onSave(patch)}>
          Save changes
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pt-2">
        <Input label="Name" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        {item.kind === "single" && (
          <div className="flex flex-col gap-1.5">
            <span className="label-mono text-fg-2">Condition</span>
            <div role="radiogroup" aria-label="Condition" className="flex gap-1.5">
              {CONDITIONS.map((c) => (
                <Chip
                  key={c}
                  role="radio"
                  aria-checked={form.condition === c}
                  selected={form.condition === c}
                  onClick={() => setForm((f) => ({ ...f, condition: c }))}
                  className="h-11 flex-1 justify-center px-0 font-mono"
                >
                  {c}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <MoneyInput label="Cost each" value={form.cost} onChange={(v) => setForm((f) => ({ ...f, cost: v }))} />
        <Input label="Notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
      </div>
    </Sheet>
  )
}

/** A yes or no before a change that is awkward to undo. */
export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  confirm,
  danger,
  busy,
  onConfirm,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  confirm: string
  danger?: boolean
  busy: boolean
  onConfirm: () => void
  children?: React.ReactNode
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" block onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} block loading={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-2 text-sm text-fg-2">{children}</div>
    </Sheet>
  )
}

/**
 * Add to deal. A deal only takes buy-in lines today; trade-out lines are
 * not built, so this points at the deals and carries the SKU across by eye.
 */
export function AddToDealSheet({ open, onClose, item }: { open: boolean; onClose: () => void; item: InventoryItem }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add to a deal"
      description="As an item going out in a trade"
      footer={
        <div className="flex gap-2">
          <Link to="/deals" className={buttonClasses("secondary", "md", true)} onClick={onClose}>
            Open deals
          </Link>
          <Link to="/deals/new" className={buttonClasses("primary", "md", true)} onClick={onClose}>
            New deal
          </Link>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-2 text-sm text-fg-2">
        <p>Deals take buy-in lines only for now. Trade-out lines are on the way; until then, start or open the deal and note this item against it.</p>
        <div className="rounded-md border border-line bg-panel-2 px-3.5 py-3">
          <p className="label-mono text-[10px] text-fg-3">This item</p>
          <p className="font-semibold text-fg">{item.title}</p>
          <p className="font-mono text-base font-bold tracking-wider text-fg">{displayCode(item.sku)}</p>
        </div>
      </div>
    </Sheet>
  )
}
