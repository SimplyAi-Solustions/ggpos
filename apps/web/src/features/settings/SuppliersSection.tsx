/**
 * Settings, Suppliers (docs/api-contract-reorder.md, section 4.4): who the
 * shop orders from, for the supplier calls on Reports. A manager's or an
 * admin's, acting straight away like Tills: hairline rows of name, rep and
 * whether it is switched on, Add a supplier, and editing in a sheet.
 *
 * A supplier is never deleted from here: stock and requests point at it,
 * so one that is finished with is switched off and drops out of the calls,
 * the palette and the Supplier selects.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, SectionHeading } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listSuppliers, saveSupplier, SUPPLIERS_KEY, suppliersKey } from "@/lib/api/reorder"
import type { Supplier, SupplierInput } from "@/lib/api/types"

const NOTES_MAX = 500

function Note({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
}

/** "Rep: Dan, 07700 900321", or nothing when no rep is set. */
function repSummary(supplier: Supplier): string {
  const parts = [supplier.repName, supplier.repPhone || supplier.repEmail].filter(Boolean)
  return parts.length ? `Rep: ${parts.join(", ")}` : "No rep set"
}

function SupplierForm({
  supplier,
  onDone,
  onCancel,
}: {
  supplier: Supplier | null
  onDone: (saved: Supplier) => void
  onCancel: () => void
}) {
  const [form, setForm] = React.useState<SupplierInput>(() => ({
    id: supplier?.id,
    name: supplier?.name ?? "",
    accountNumber: supplier?.accountNumber ?? "",
    repName: supplier?.repName ?? "",
    repEmail: supplier?.repEmail ?? "",
    repPhone: supplier?.repPhone ?? "",
    notes: supplier?.notes ?? "",
    active: supplier?.active ?? true,
  }))
  const [nameProblem, setNameProblem] = React.useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => saveSupplier(form),
    onSuccess: onDone,
  })

  function set(patch: Partial<SupplierInput>) {
    setForm((current) => ({ ...current, ...patch }))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) {
      setNameProblem("Give the supplier a name.")
      return
    }
    setNameProblem(null)
    save.mutate()
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={supplier ? `Edit ${supplier.name}` : "Add a supplier"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody>
        <FieldRow>
          <Field layout="stacked" label="Name" hint="Required" htmlFor="supplier-name" error={nameProblem}>
            <Input
              id="supplier-name"
              autoFocus
              autoComplete="off"
              maxLength={80}
              placeholder="Games Workshop"
              aria-invalid={nameProblem ? true : undefined}
              value={form.name}
              onChange={(event) => {
                set({ name: event.target.value })
                setNameProblem(null)
              }}
            />
          </Field>
          <Field layout="stacked" label="Account number" hint="Optional" htmlFor="supplier-account">
            <Input
              id="supplier-account"
              autoComplete="off"
              maxLength={40}
              className="tnum font-mono"
              placeholder="The shop's account with them"
              value={form.accountNumber}
              onChange={(event) => set({ accountNumber: event.target.value })}
            />
          </Field>
          <Field layout="stacked" label="Rep name" hint="Optional" htmlFor="supplier-rep-name">
            <Input
              id="supplier-rep-name"
              autoComplete="off"
              maxLength={80}
              value={form.repName}
              onChange={(event) => set({ repName: event.target.value })}
            />
          </Field>
          <Field layout="stacked" label="Rep email" hint="Optional" htmlFor="supplier-rep-email">
            <Input
              id="supplier-rep-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              maxLength={120}
              value={form.repEmail}
              onChange={(event) => set({ repEmail: event.target.value })}
            />
          </Field>
          <Field layout="stacked" label="Rep phone" hint="Optional" htmlFor="supplier-rep-phone">
            <Input
              id="supplier-rep-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={40}
              className="tnum"
              value={form.repPhone}
              onChange={(event) => set({ repPhone: event.target.value })}
            />
          </Field>
          <Field layout="stacked" label="Notes" hint="Optional" htmlFor="supplier-notes">
            <Textarea
              id="supplier-notes"
              maxLength={NOTES_MAX}
              placeholder="Order cut-off, delivery day, minimum order"
              value={form.notes}
              onChange={(event) => set({ notes: event.target.value })}
              trailingHint={`${form.notes.length} / ${NOTES_MAX}`}
            />
          </Field>
          <Field layout="stacked" label="Active">
            <div className="flex items-center gap-4">
              <Switch
                checked={form.active}
                onCheckedChange={(next: boolean) => set({ active: next })}
                aria-label="Active"
              />
              <span className="text-[15px] text-foreground">
                {form.active ? "On the supplier calls" : "Switched off"}
              </span>
            </div>
          </Field>
        </FieldRow>
        {save.error ? (
          <p role="alert" className="mt-8 text-[13px] leading-[1.45] text-destructive">
            {refusalOrFallback(save.error, "The supplier did not save. Check the connection and try again.")}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={save.isPending}>
          {supplier ? "Save supplier" : "Add supplier"}
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

export function SuppliersSection() {
  const queryClient = useQueryClient()
  // `undefined` is closed, `null` is a new one, a supplier is that one.
  const [editing, setEditing] = React.useState<Supplier | null | undefined>(undefined)
  const [note, setNote] = React.useState<string | null>(null)

  const suppliers = useQuery({
    queryKey: suppliersKey(false),
    queryFn: () => listSuppliers(),
    staleTime: 30_000,
  })
  const rows = suppliers.data ?? []

  return (
    <section className="mt-24" aria-labelledby="suppliers-heading" data-testid="suppliers-section">
      <SectionHeading id="suppliers-heading">Suppliers</SectionHeading>
      <Note>
        Who the shop orders from. Each one switched on gets a supplier call under Reports. Changes
        take effect straight away, not on Save.
      </Note>

      <div className="mt-8">
        {suppliers.error ? (
          <p role="alert" className="text-[15px] text-destructive">
            {refusalOrFallback(suppliers.error, "The suppliers would not load. Check the connection and try again.")}
          </p>
        ) : suppliers.isSuccess && rows.length === 0 ? (
          <p className="text-[15px] text-muted-foreground-2">No suppliers yet. Add the first one.</p>
        ) : (
          <ul data-testid="supplier-list">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="supplier-row"
                className="flex min-h-14 flex-wrap items-center justify-between gap-x-8 gap-y-2 border-b border-hairline-soft py-3 first:border-t"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-baseline gap-3">
                    <span className="text-[15px] text-foreground">{row.name}</span>
                    {row.active ? null : <Hint>Switched off</Hint>}
                  </span>
                  <span className="tnum text-[13px] leading-[1.45] text-muted-foreground-2">
                    {repSummary(row)}
                  </span>
                </span>
                <Button
                  variant="text"
                  aria-label={`Edit ${row.name}`}
                  onClick={() => {
                    setNote(null)
                    setEditing(row)
                  }}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-2">
          <Button
            variant="text"
            onClick={() => {
              setNote(null)
              setEditing(null)
            }}
          >
            Add a supplier
          </Button>
          {note ? (
            <span data-testid="suppliers-note" aria-live="polite" className="text-[13px] text-muted-foreground">
              {note}
            </span>
          ) : null}
        </div>
      </div>

      <Sheet
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
      >
        <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="supplier-sheet">
          <SheetHeader>
            <SheetTitle>{editing ? `Edit ${editing.name}` : "Add a supplier"}</SheetTitle>
            <SheetDescription>
              The rep and the account are said at the top of the supplier call, ready for the phone.
            </SheetDescription>
          </SheetHeader>
          {editing !== undefined ? (
            <SupplierForm
              key={editing?.id ?? "new"}
              supplier={editing}
              onDone={(saved) => {
                setEditing(undefined)
                setNote(`${saved.name} saved.`)
                void queryClient.invalidateQueries({ queryKey: SUPPLIERS_KEY })
                void queryClient.invalidateQueries({ queryKey: ["reorder"] })
              }}
              onCancel={() => setEditing(undefined)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  )
}
