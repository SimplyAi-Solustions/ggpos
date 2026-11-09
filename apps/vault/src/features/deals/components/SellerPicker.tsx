import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, UserPlus, UserRound, X } from "lucide-react"

import { Button, Input, Skeleton } from "@/ui"

import { createSeller, explain, searchSellers, type NewSeller } from "../api"
import type { Seller } from "../types"

export interface SellerPickerProps {
  seller: Seller | null
  onChange: (seller: Seller | null) => void
}

const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i

/** Who is selling: search the customers, or add one in a few fields. */
export function SellerPicker({ seller, onChange }: SellerPickerProps) {
  const [mode, setMode] = React.useState<"search" | "add">("search")
  const [query, setQuery] = React.useState("")
  const [debounced, setDebounced] = React.useState("")

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const results = useQuery({
    queryKey: ["deals", "sellers", debounced],
    queryFn: ({ signal }) => searchSellers(debounced, signal),
    enabled: !seller && mode === "search" && debounced.length >= 2,
  })

  if (seller) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-line-2 bg-panel-2 px-3.5 py-3" data-testid="seller">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pop font-mono text-xs font-bold text-on-pop">
          <UserRound className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{seller.name}</p>
          <p className="truncate font-mono text-xs text-fg-3">
            {[seller.code, seller.phone || seller.email].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    )
  }

  if (mode === "add") {
    return (
      <QuickAdd
        initialName={/\d|@/.test(query) ? "" : query}
        onCancel={() => setMode("search")}
        onAdded={(added) => {
          onChange(added)
          setMode("search")
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label="Search customers"
        placeholder="Name, phone, email or GGC code"
        leading={<Search aria-hidden />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {debounced.length >= 2 &&
        (results.isPending ? (
          <Skeleton className="h-14" />
        ) : results.isError ? (
          <p className="text-sm text-pop-text" role="alert">
            {explain(results.error, "Customer search did not answer. Try again.")}
          </p>
        ) : results.data.length === 0 ? (
          <p className="text-sm text-fg-2">No customer matches "{debounced}". Add them below.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {results.data.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onChange(row)}
                  className="flex w-full flex-col items-start px-3.5 py-2.5 text-left hover:bg-line/50"
                >
                  <span className="font-medium">{row.name}</span>
                  <span className="font-mono text-xs text-fg-3">
                    {[row.code, row.phone, row.email].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      <Button variant="secondary" size="sm" icon={<UserPlus className="size-4" aria-hidden />} onClick={() => setMode("add")} className="self-start">
        New customer
      </Button>
    </div>
  )
}

function QuickAdd({
  initialName,
  onCancel,
  onAdded,
}: {
  initialName: string
  onCancel: () => void
  onAdded: (seller: Seller) => void
}) {
  const [values, setValues] = React.useState<NewSeller>({ name: initialName, phone: "", email: "", address: "" })
  const [tried, setTried] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const set = (patch: Partial<NewSeller>) => setValues((v) => ({ ...v, ...patch }))

  const nameError = tried && values.name.trim().length < 2 ? "Enter the customer's name." : null
  const contactError =
    tried && !values.phone.trim() && !values.email.trim() ? "Add a phone number or an email." : null
  const emailError = tried && values.email.trim() && !/^\S+@\S+\.\S+$/.test(values.email.trim()) ? "Check the email address." : null
  const addressError =
    tried && values.address.trim() && !POSTCODE.test(values.address)
      ? "Include the postcode, for example S44 6PP."
      : null

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setTried(true)
    setError(null)
    if (values.name.trim().length < 2 || (!values.phone.trim() && !values.email.trim())) return
    if (values.email.trim() && !/^\S+@\S+\.\S+$/.test(values.email.trim())) return
    if (values.address.trim() && !POSTCODE.test(values.address)) return
    setBusy(true)
    try {
      onAdded(await createSeller(values))
    } catch (err) {
      setError(explain(err, "The customer was not saved. Check the details and try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3" noValidate>
      <Input label="Name" value={values.name} onChange={(e) => set({ name: e.target.value })} error={nameError} autoComplete="off" />
      <Input
        label="Phone"
        inputMode="tel"
        value={values.phone}
        onChange={(e) => set({ phone: e.target.value })}
        error={contactError}
        autoComplete="off"
      />
      <Input
        label="Email"
        type="email"
        inputMode="email"
        value={values.email}
        onChange={(e) => set({ email: e.target.value })}
        error={emailError}
        autoComplete="off"
      />
      <Input
        label="Address with postcode"
        hint="Needed before any cash is paid."
        placeholder="12 Castle Street, Bolsover, S44 6PP"
        value={values.address}
        onChange={(e) => set({ address: e.target.value })}
        error={addressError}
        autoComplete="off"
      />
      {error && (
        <p className="text-sm font-medium text-pop-text" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Back to search
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          Save customer
        </Button>
      </div>
    </form>
  )
}
