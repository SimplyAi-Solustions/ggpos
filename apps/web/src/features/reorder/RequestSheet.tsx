/**
 * Add a request (docs/api-contract-reorder.md, section 4.2): something a
 * customer wants that the supplier can get. What they are after, how many,
 * who to tell (a Guild member found the way the till's Add customer finds
 * one, or a name and a phone number), and notes. The supplier is the
 * call's own.
 *
 * The form lives inside `SheetContent`, which Base UI mounts only while the
 * sheet is open, so it starts empty every time without an effect clearing it.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { displayCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { findCustomersForSale } from "@/lib/api"
import { refusalOrFallback } from "@/lib/api/refusal"
import { createRequest, reorderKeys } from "@/lib/api/reorder"
import type { SaleCustomer } from "@/lib/api/types"
import { Stepper } from "@/features/stock/Stepper"
import { requestProblems, type RequestDraft } from "@/features/reorder/request-form"

const NOTES_MAX = 500

/** The Guild member search, as the till's Add customer runs it. */
function CustomerField({
  chosen,
  onChoose,
}: {
  chosen: SaleCustomer | null
  onChoose: (customer: SaleCustomer | null) => void
}) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query)
  const searching = deferred.trim().length >= 2
  const { data = [], isFetching } = useQuery({
    queryKey: ["sale-customers", deferred],
    queryFn: () => findCustomersForSale(deferred),
    enabled: searching && !chosen,
    staleTime: 10_000,
  })

  if (chosen) {
    return (
      <div data-testid="request-customer-chosen" className="flex flex-wrap items-baseline gap-x-6 gap-y-1 pt-1">
        <span className="text-base text-foreground">{chosen.name}</span>
        <span className="tnum font-mono text-[13px] text-muted-foreground-2">{displayCode(chosen.code)}</span>
        <Button variant="text" type="button" onClick={() => onChoose(null)}>
          Change
        </Button>
      </div>
    )
  }

  const hits = data.slice(0, 5)
  return (
    <>
      <Input
        id="request-customer"
        autoComplete="off"
        placeholder="Name, phone or GGC code"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searching ? (
        hits.length === 0 ? (
          <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground-2">
            {isFetching
              ? "Searching."
              : "No Guild member matches that. Take a name and phone number below instead."}
          </p>
        ) : (
          <ul className="mt-3" aria-label="Guild members">
            {hits.map((customer) => (
              <li key={customer.id} className="border-b border-hairline-soft first:border-t">
                <button
                  type="button"
                  onClick={() => onChoose(customer)}
                  className="flex min-h-12 w-full items-center gap-4 py-2 text-left transition-colors duration-150 ease-gg outline-none hover:bg-row-hover focus-visible:bg-row-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-foreground">{customer.name}</span>
                    <span className="tnum block truncate font-mono text-[13px] text-muted-foreground-2">
                      {displayCode(customer.code)}
                    </span>
                  </span>
                  {customer.tierName ? <Badge variant="volt">{customer.tierName}</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </>
  )
}

function RequestForm({
  supplier,
  onDone,
  onCancel,
}: {
  supplier: { id: string; name: string }
  onDone: (title: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = React.useState<RequestDraft>({
    title: "",
    qty: 1,
    customer: null,
    contactName: "",
    contactPhone: "",
    notes: "",
  })
  const [shown, setShown] = React.useState(false)
  const problems = shown ? requestProblems(draft) : {}

  const save = useMutation({
    mutationFn: () =>
      createRequest({
        supplierId: supplier.id,
        title: draft.title.trim(),
        qty: draft.qty === "" ? 0 : draft.qty,
        customerId: draft.customer?.id,
        contactName: draft.contactName.trim(),
        contactPhone: draft.contactPhone.trim(),
        notes: draft.notes.trim(),
      }),
    onSuccess: (request) => {
      void queryClient.invalidateQueries({ queryKey: reorderKeys.all })
      onDone(request.title)
    },
  })

  function set(patch: Partial<RequestDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setShown(true)
    if (Object.keys(requestProblems(draft)).length > 0) return
    save.mutate()
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Add a request" className="flex min-h-0 flex-1 flex-col">
      <SheetBody>
        <FieldRow>
          <Field
            layout="stacked"
            label="What are they after"
            hint="Required"
            htmlFor="request-title"
            error={problems.title}
          >
            <Input
              id="request-title"
              autoFocus
              autoComplete="off"
              maxLength={200}
              placeholder="Combat Patrol: Necrons"
              aria-invalid={problems.title ? true : undefined}
              value={draft.title}
              onChange={(event) => set({ title: event.target.value })}
            />
          </Field>

          <Field layout="stacked" label="Quantity" htmlFor="request-qty" error={problems.qty}>
            <Stepper id="request-qty" value={draft.qty} onChange={(qty) => set({ qty })} />
          </Field>

          <Field layout="stacked" label="Guild member" htmlFor="request-customer" error={problems.who}>
            <CustomerField chosen={draft.customer} onChoose={(customer) => set({ customer })} />
          </Field>

          <Field
            layout="stacked"
            label={draft.customer ? "Name to contact" : "Or a name to contact"}
            hint={draft.customer ? "Optional" : undefined}
            htmlFor="request-contact-name"
          >
            <Input
              id="request-contact-name"
              autoComplete="off"
              maxLength={100}
              placeholder="Sam Whitlock"
              aria-invalid={problems.who ? true : undefined}
              value={draft.contactName}
              onChange={(event) => set({ contactName: event.target.value })}
            />
          </Field>

          <Field layout="stacked" label="Phone" hint="Optional" htmlFor="request-contact-phone">
            <Input
              id="request-contact-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={40}
              className="tnum"
              placeholder="07700 900000"
              value={draft.contactPhone}
              onChange={(event) => set({ contactPhone: event.target.value })}
            />
          </Field>

          <Field layout="stacked" label="Notes" hint="Optional" htmlFor="request-notes">
            <Textarea
              id="request-notes"
              maxLength={NOTES_MAX}
              placeholder="Anything the rep or the next person needs to know"
              value={draft.notes}
              onChange={(event) => set({ notes: event.target.value })}
              trailingHint={`${draft.notes.length} / ${NOTES_MAX}`}
            />
          </Field>
        </FieldRow>

        {save.error ? (
          <p role="alert" className="mt-8 text-[13px] leading-[1.45] text-destructive">
            {refusalOrFallback(save.error, "The request did not save. Check the connection and try again.")}
          </p>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button type="submit" trailingArrow loading={save.isPending}>
          Add request
        </Button>
        <Button type="button" variant="text" onClick={onCancel}>
          Cancel
        </Button>
      </SheetFooter>
    </form>
  )
}

export function RequestSheet({
  open,
  onOpenChange,
  supplier,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  supplier: { id: string; name: string }
  /** Said once the request is saved, with what it was for. */
  onAdded?: (title: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]" data-testid="request-sheet">
        <SheetHeader>
          <SheetTitle>Add a request</SheetTitle>
          <SheetDescription>
            For {supplier.name}. Find the Guild member, or take a name and number to ring when it
            comes in.
          </SheetDescription>
        </SheetHeader>
        <RequestForm
          supplier={supplier}
          onDone={(title) => {
            onOpenChange(false)
            onAdded?.(title)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
