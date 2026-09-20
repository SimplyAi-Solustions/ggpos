import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { displayCode, formatGBP, parseCode } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { CameraSheet } from "@/features/scan/CameraSheet"
import { setScanHandler } from "@/app/scan-bus"
import { registerSearchField } from "@/app/focus-registry"
import {
  FLAG_LABEL,
  FLAG_REASON,
  ID_STATUS_LABEL,
  PRIVACY_SENTENCE,
} from "@/features/customers/format"
import { customerSchema } from "@/features/customers/schema"
import type { WizardCustomer } from "@/features/tradein/machine"
import {
  createCustomer,
  getCustomer,
  refusalOrFallback,
  searchCustomers,
  type CustomerProfile,
  type IdStatus,
} from "@/lib/api"

function toWizardCustomer(profile: CustomerProfile): WizardCustomer {
  return {
    id: profile.customer.id,
    name: profile.customer.name,
    code: profile.customer.code,
    email: profile.customer.email ?? "",
    phone: profile.customer.phone ?? "",
    creditBalance: profile.private?.credit_balance ?? 0,
    facts: {
      flags: profile.private?.flags ?? [],
      idStatus: (profile.private?.id_status ?? "none") as IdStatus,
      idExpiry: profile.private?.id_expiry,
      dob: profile.private?.dob,
      address: profile.private?.address,
    },
  }
}

export interface CustomerStepProps {
  customer: WizardCustomer | null
  onChoose: (customer: WizardCustomer) => void
}

/**
 * Who is selling.
 *
 * Four ways in, in the order the counter actually uses them: the customer's
 * QR through the wedge or the camera, their code typed, their name or number
 * searched, or a new card made on the spot. Whichever way it goes, the step
 * ends with their ID status, their flags and their credit on screen, because
 * those are what decide whether the rest of the wizard can offer cash.
 */
export function CustomerStep({ customer, onChoose }: CustomerStepProps) {
  const [query, setQuery] = React.useState("")
  const [cameraOpen, setCameraOpen] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [newPhone, setNewPhone] = React.useState("")
  const [newEmail, setNewEmail] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => registerSearchField(searchRef.current), [])

  const load = useMutation({
    mutationFn: (idOrCode: string) => getCustomer(idOrCode),
    onSuccess: (profile) => {
      if (!profile) {
        setError("That card is not on file. Search by name, or make a new one.")
        return
      }
      setError(null)
      onChoose(toWizardCustomer(profile))
    },
    onError: (failure) =>
      setError(refusalOrFallback(failure, "That customer could not be read.")),
  })

  // A scan anywhere on this step lands here rather than routing away.
  React.useEffect(
    () =>
      setScanHandler((raw) => {
        const parsed = parseCode(raw)
        if (parsed?.kind === "customer") {
          load.mutate(parsed.encoded)
          return
        }
        setError("That is not a customer card. Scan the QR on their Guild card.")
      }),
    // `load` is a stable mutation object for the life of this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const deferred = React.useDeferredValue(query)
  const { data: results = [] } = useQuery({
    queryKey: ["customers", deferred.trim()],
    queryFn: () => searchCustomers(deferred),
    enabled: deferred.trim().length >= 2,
    staleTime: 10_000,
  })

  const create = useMutation({
    mutationFn: () =>
      createCustomer({ name: newName, phone: newPhone, email: newEmail }),
    onSuccess: async (record) => {
      const profile = await getCustomer(record.id)
      if (profile) onChoose(toWizardCustomer(profile))
      setCreating(false)
    },
    onError: (failure) =>
      setError(
        refusalOrFallback(failure, "That customer did not save. Try again.")
      ),
  })

  if (customer) {
    const { facts } = customer
    return (
      <div>
        <SectionHeading className="mt-0">Selling today</SectionHeading>
        <p className="text-[20px] leading-[1.3] text-foreground">{customer.name}</p>
        <p className="tnum mt-2 font-mono text-[13px] text-muted-foreground">
          {displayCode(customer.code)}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Badge variant="outline">ID {ID_STATUS_LABEL[facts.idStatus]}</Badge>
          {facts.flags.map((flag) => (
            <Badge key={flag} variant="outline">
              {FLAG_LABEL[flag]}
            </Badge>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-end gap-x-14 gap-y-6">
          <div>
            <MicroLabel className="mb-2">Store credit</MicroLabel>
            <p className="tnum font-mono text-[20px] leading-none text-foreground">
              {formatGBP(customer.creditBalance)}
            </p>
          </div>
          <div>
            <MicroLabel className="mb-2">Phone</MicroLabel>
            <p className="tnum font-mono text-[20px] leading-none text-foreground">
              {customer.phone || "Not on file"}
            </p>
          </div>
        </div>

        {facts.flags.map((flag) => (
          <p
            key={flag}
            className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-destructive"
          >
            {FLAG_REASON[flag]}
          </p>
        ))}

        <div className="mt-10">
          <Button
            variant="text"
            type="button"
            onClick={() => {
              setQuery("")
              onChooseNobody()
            }}
          >
            Choose someone else
          </Button>
        </div>
      </div>
    )

    function onChooseNobody() {
      // Reaching this clears the chosen customer by handing back a blank
      // one is wrong; the wizard owns that, so the button simply reopens
      // the search by clearing the field and asking the parent to forget.
      window.location.reload()
    }
  }

  return (
    <div>
      <SectionHeading className="mt-0">Who is selling</SectionHeading>

      <Field label="Find them" htmlFor="buyin-customer" layout="stacked">
        <Input
          id="buyin-customer"
          ref={searchRef}
          type="search"
          autoComplete="off"
          leadingIcon={<SearchIcon />}
          placeholder="Scan the card, or type a name, phone or GGC code"
          trailingHint={
            <button
              type="button"
              onClick={() => setCameraOpen(true)}
              className="font-mono text-[11px] font-bold tracking-[0.16em] text-foreground uppercase underline-offset-4 outline-none hover:underline"
            >
              Use camera
            </button>
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            const parsed = parseCode(query)
            if (parsed?.kind === "customer") load.mutate(parsed.encoded)
          }}
        />
      </Field>

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      {results.length > 0 ? (
        <ul className="mt-8" aria-label="Matching customers">
          {results.map((hit) => (
            <li key={hit.id} className="border-b border-hairline-soft">
              <button
                type="button"
                onClick={() => load.mutate(hit.id)}
                className="flex min-h-12 w-full flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 text-left outline-none hover:bg-row-hover"
              >
                <span className="text-[15px] text-foreground">{hit.name}</span>
                <span className="tnum font-mono text-[13px] text-muted-foreground">
                  {displayCode(hit.code)}
                </span>
                <span className="tnum text-[13px] text-muted-foreground-2">
                  {hit.phone || hit.email || "No contact"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {creating ? (
        <div className="mt-12 border-t border-hairline-soft pt-8">
          <MicroLabel className="mb-5">New customer</MicroLabel>
          <div className="flex max-w-[34rem] flex-col gap-8">
            <Field label="Name" htmlFor="buyin-new-name" layout="stacked">
              <Input
                id="buyin-new-name"
                autoComplete="off"
                placeholder="First and last name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="buyin-new-phone" layout="stacked" hint="Optional">
              <Input
                id="buyin-new-phone"
                type="tel"
                inputMode="tel"
                className="tnum"
                autoComplete="off"
                placeholder="07700 900123"
                value={newPhone}
                onChange={(event) => setNewPhone(event.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="buyin-new-email" layout="stacked" hint="Optional">
              <Input
                id="buyin-new-email"
                type="email"
                autoComplete="off"
                placeholder="name@example.co.uk"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
              />
            </Field>
          </div>
          <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
            {PRIVACY_SENTENCE}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-8">
            <Button
              variant="text"
              type="button"
              loading={create.isPending}
              disabled={!customerSchema.shape.name.safeParse(newName).success}
              onClick={() => create.mutate()}
            >
              Save and carry on
            </Button>
            <Button variant="text" type="button" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-10 flex flex-wrap items-center gap-8">
          <Button
            variant="text"
            type="button"
            onClick={() => {
              setNewName(query.trim())
              setCreating(true)
            }}
          >
            New customer
          </Button>
          <Hint>Or scan their Guild card</Hint>
        </div>
      )}

      <CameraSheet
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onResult={(value) => {
          const parsed = parseCode(value)
          if (parsed?.kind === "customer") load.mutate(parsed.encoded)
          else setError("That QR is not a Guild card. Try again, or search by name.")
        }}
      />
    </div>
  )
}
