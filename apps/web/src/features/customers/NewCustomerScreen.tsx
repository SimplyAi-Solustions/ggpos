import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { displayCode } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Switch } from "@/components/ui/switch"
import { useCounterDock } from "@/app/counter-dock"
import { PRIVACY_SENTENCE } from "@/features/customers/format"
import {
  customerSchema,
  duplicateQuery,
  matchesQuery,
  type CustomerValues,
} from "@/features/customers/schema"
import { createCustomer, refusalOrFallback, searchCustomers } from "@/lib/api"

const DEFAULTS: CustomerValues = {
  name: "",
  phone: "",
  email: "",
  marketingConsent: false,
  referredBy: "",
}

export interface NewCustomerScreenProps {
  /** Typed into the list's search box before pressing "New customer". */
  initialName?: string
  /** Where to go once the card exists. Defaults to the new profile. */
  onCreated?: (customerId: string, code: string) => void
}

/**
 * A new card at the counter: a name, and everything else optional.
 *
 * The duplicate warning does the work of the "is that you already?" question
 * staff would otherwise have to ask: as soon as a full phone number or a
 * plausible email is typed, any existing customer on it appears under the
 * field with a link, so a second card is a decision rather than an accident.
 */
export function NewCustomerScreen({
  initialName,
  onCreated,
}: NewCustomerScreenProps) {
  const navigate = useNavigate()
  const dock = useCounterDock()
  const formRef = React.useRef<HTMLFormElement>(null)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const form = useForm<CustomerValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: { ...DEFAULTS, name: initialName ?? "" },
    mode: "onSubmit",
  })
  const { control, formState, handleSubmit } = form
  const errors = formState.errors

  const phone = useWatch({ control, name: "phone" })
  const email = useWatch({ control, name: "email" })
  const query = duplicateQuery({ phone, email })
  const deferredQuery = React.useDeferredValue(query)

  const { data: candidates = [] } = useQuery({
    queryKey: ["customer-duplicates", deferredQuery?.phone, deferredQuery?.email],
    queryFn: () => searchCustomers(deferredQuery?.phone || deferredQuery?.email || ""),
    enabled: Boolean(deferredQuery),
    staleTime: 10_000,
  })
  const duplicates = deferredQuery
    ? candidates.filter((candidate) => matchesQuery(candidate, deferredQuery))
    : []

  const save = useMutation({
    mutationFn: (values: CustomerValues) =>
      createCustomer({
        name: values.name,
        phone: values.phone,
        email: values.email,
        marketingConsent: values.marketingConsent,
        referredBy: values.referredBy?.trim() || undefined,
      }),
    onSuccess: (customer) => {
      setServerError(null)
      if (onCreated) {
        onCreated(customer.id, customer.code)
        return
      }
      void navigate({
        to: "/counter/customers/$code",
        params: { code: customer.code },
      })
    },
    onError: (error) => {
      const message = refusalOrFallback(
        error,
        "That did not save. Check the connection and try again."
      )
      // The one refusal that belongs to a field rather than the form: the
      // server is the only thing that can say whether a code is anybody's,
      // and its sentence already says what to do about it.
      if (/\bcode\b/.test(message) && form.getValues("referredBy")) {
        form.setError("referredBy", { message })
        setServerError(null)
        return
      }
      setServerError(message)
    },
  })

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>New customer</PageTitle>
      <Lede>A name is enough. The card and code are made for you.</Lede>

      <form
        ref={formRef}
        noValidate
        aria-label="New customer"
        onSubmit={handleSubmit((values) => save.mutate(values))}
        className="mt-14 max-[899px]:[&_*]:scroll-mb-[calc(var(--gg-dock-h,5rem)+1.5rem)]"
      >
        <FieldRow>
          <Field label="Name" htmlFor="customer-name" error={errors.name?.message}>
            <Controller
              control={control}
              name="name"
              render={({ field }) => (
                <Input
                  id="customer-name"
                  autoComplete="off"
                  placeholder="First and last name"
                  aria-invalid={!!errors.name}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </Field>

          <Field
            label="Phone"
            htmlFor="customer-phone"
            hint="Optional"
            error={errors.phone?.message}
          >
            <Controller
              control={control}
              name="phone"
              render={({ field }) => (
                <Input
                  id="customer-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  className="tnum"
                  placeholder="07700 900123"
                  aria-invalid={!!errors.phone}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </Field>

          <Field
            label="Email"
            htmlFor="customer-email"
            hint="Optional"
            error={errors.email?.message}
          >
            <Controller
              control={control}
              name="email"
              render={({ field }) => (
                <Input
                  id="customer-email"
                  type="email"
                  autoComplete="off"
                  placeholder="name@example.co.uk"
                  aria-invalid={!!errors.email}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </Field>

          <Field
            label="Referred by"
            htmlFor="customer-referred-by"
            hint="Optional"
            error={errors.referredBy?.message}
          >
            <Controller
              control={control}
              name="referredBy"
              render={({ field }) => (
                <Input
                  id="customer-referred-by"
                  autoComplete="off"
                  className="tnum font-mono"
                  placeholder="GGC-4K7M2"
                  aria-invalid={!!errors.referredBy}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              The code on the card of whoever sent them in. Both of them earn
              points when this customer first buys or sells something.
            </p>
          </Field>

          <Field label="Marketing">
            <Controller
              control={control}
              name="marketingConsent"
              render={({ field }) => (
                <div className="flex min-h-10 items-center gap-4 pt-1 pb-2">
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="Send offers and news to this customer"
                  />
                  <span className="text-[15px] text-muted-foreground">
                    Send offers and news
                  </span>
                </div>
              )}
            />
          </Field>
        </FieldRow>

        {duplicates.length > 0 ? (
          <div
            aria-live="polite"
            data-testid="duplicate-warning"
            className="mt-10 border-t border-hairline-soft pt-5"
          >
            <Hint>Already on file</Hint>
            <ul className="mt-3 flex flex-col">
              {duplicates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hairline-soft py-3 last:border-b-0"
                >
                  <Link
                    to="/counter/customers/$code"
                    params={{ code: candidate.code }}
                    className="text-[15px] text-foreground underline-offset-4 outline-none hover:underline"
                  >
                    {candidate.name}
                  </Link>
                  <span className="tnum font-mono text-[13px] text-muted-foreground">
                    {displayCode(candidate.code)}
                  </span>
                  <span className="tnum text-[13px] text-muted-foreground-2">
                    {candidate.phone || candidate.email}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
              Open that customer instead, or carry on if this is a different
              person on the same number.
            </p>
          </div>
        ) : null}

        <p className="mt-10 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          {PRIVACY_SENTENCE}
        </p>

        {serverError ? (
          <p role="alert" className="mt-8 text-[13px] text-destructive">
            {serverError}
          </p>
        ) : null}

        <div className="mt-14 hidden flex-wrap items-center gap-8 min-[900px]:flex">
          <Button type="submit" trailingArrow loading={save.isPending}>
            Save customer
          </Button>
          <Button
            variant="text"
            type="button"
            onClick={() => void navigate({ to: "/counter/customers" })}
          >
            Cancel
          </Button>
        </div>

        <div className="mt-14 flex items-center justify-center min-[900px]:hidden">
          <Button
            variant="text"
            type="button"
            onClick={() => void navigate({ to: "/counter/customers" })}
          >
            Cancel
          </Button>
        </div>
      </form>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3">
              <Button
                type="button"
                trailingArrow
                loading={save.isPending}
                className="w-full"
                onClick={() => formRef.current?.requestSubmit()}
              >
                Save customer
              </Button>
            </div>,
            dock
          )
        : null}
    </section>
  )
}
