/**
 * Settings, VAT (docs/api-contract-launch.md, section 3; admin): whether the
 * shop is registered, its VAT number, the day registration starts, the
 * first month of a VAT quarter and the standard rate, with one paragraph on
 * what each treatment means. They are part of the settings form and save
 * with its one Save, like every field above them.
 *
 * `VatProductsSection` is the till products' treatments, which act straight
 * away like Tills, Printers and Categories below the Save. A branch's
 * treatment is one of its defaults under Categories, and an item's is on
 * its own page and in Add stock.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  isVatTreatment,
  standardRateOf,
  treatmentLabel,
  treatmentOf,
  VAT_TREATMENTS,
  type VatTreatment,
} from "@gg/shared"

import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, SectionHeading } from "@/components/ui/micro-label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SkeletonText } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { TextField } from "@/features/settings/fields"
import type { FormErrors, SettingsForm } from "@/features/settings/mapping"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listTillProductsVat, saveTillProductVat } from "@/lib/api/vat"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
}

export function VatSection({
  form,
  set,
  errors,
}: {
  form: SettingsForm
  set: (patch: Partial<SettingsForm>) => void
  errors: FormErrors
}) {
  const rate = standardRateOf(form.vatStandardRate)
  return (
    <section className="mt-16" aria-labelledby="vat-heading" data-testid="vat-settings">
      <SectionHeading id="vat-heading">VAT</SectionHeading>
      <div className="flex flex-col gap-10">
        <Field label="VAT registered" layout="auto">
          <div className="flex items-center gap-4">
            <Switch
              checked={form.vatRegistered}
              onCheckedChange={(checked: boolean) => set({ vatRegistered: checked })}
              aria-label="VAT registered"
            />
            <span className="text-[15px] text-foreground">
              {form.vatRegistered ? "Registered" : "Not registered"}
            </span>
          </div>
          <Note>Off, nothing is charged as VAT and the VAT return reads 0.</Note>
        </Field>
        <TextField
          id="vat-number"
          label="VAT number"
          maxLength={20}
          value={form.vatNumber}
          onChange={(next) => set({ vatNumber: next })}
          error={errors.vatNumber}
          note="Printed on receipts while the shop is VAT registered."
        />
        <Field label="Registered from" htmlFor="vat-from">
          <Input
            id="vat-from"
            type="date"
            className="tnum"
            aria-invalid={Boolean(errors.vatRegisteredFrom) || undefined}
            value={form.vatRegisteredFrom}
            onChange={(event) => set({ vatRegisteredFrom: event.target.value })}
          />
          <Note>The date on the registration certificate. A sale before it is never charged VAT.</Note>
          <FieldError>{errors.vatRegisteredFrom}</FieldError>
        </Field>
        <Field label="Quarter starts" htmlFor="vat-quarter">
          <Select
            value={String(form.vatPeriodStartMonth)}
            onValueChange={(next) => set({ vatPeriodStartMonth: Number(next) || 1 })}
          >
            <SelectTrigger id="vat-quarter">
              <SelectValue>{(value: string) => MONTHS[Number(value) - 1] ?? "January"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((month, index) => (
                <SelectItem key={month} value={String(index + 1)}>
                  {month}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Note>The first month of any one of the shop&apos;s VAT quarters, from HMRC&apos;s letter.</Note>
        </Field>
        <Field label="Standard rate" htmlFor="vat-rate">
          <Input
            id="vat-rate"
            className="tnum"
            inputMode="decimal"
            autoComplete="off"
            maxLength={5}
            trailingHint="%"
            aria-invalid={Boolean(errors.vatStandardRate) || undefined}
            value={form.vatStandardRate}
            onChange={(event) => set({ vatStandardRate: event.target.value })}
          />
          <FieldError>{errors.vatStandardRate}</FieldError>
        </Field>
      </div>
      <p data-testid="vat-treatments" className="mt-10 max-w-[64ch] text-[15px] leading-[1.5] text-muted-foreground">
        Every line is charged by its treatment. Margin scheme is for second-hand goods bought from the
        public: the VAT is the rate&apos;s fraction of what the shop made on each one, one sixth at{" "}
        {rate}%, and the receipt shows none. Standard rate charges {rate}% inside the price, reduced
        rate 5%, and zero rate nothing, though it still counts as a sale for VAT. Exempt sits outside
        VAT altogether. Each branch has a default treatment under Categories, and an item or a till
        product can say otherwise.
      </p>
    </section>
  )
}

/** One till product's treatment, saved as soon as it is chosen. */
function ProductRow({
  product,
  standardRate,
  onSaved,
}: {
  product: { id: string; name: string; active: boolean; tax_scheme: string; vat_rate: number }
  standardRate: number
  onSaved: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const [error, setError] = React.useState<string | null>(null)
  const save = useMutation({
    mutationFn: (treatment: VatTreatment) => saveTillProductVat(product.id, treatment),
    onSuccess: (_, treatment) => {
      setError(null)
      onSaved(`${product.name}: ${treatmentLabel(treatment, standardRate)}.`)
      void queryClient.invalidateQueries({ queryKey: ["till-products-vat"] })
      void queryClient.invalidateQueries({ queryKey: ["till-catalogue"] })
    },
    onError: (err) => setError(refusalOrFallback(err, "That did not save. Try again.")),
  })
  const current = treatmentOf(product.tax_scheme, product.vat_rate) ?? "standard"
  return (
    <li className="flex min-h-14 flex-col gap-2 border-b border-hairline-soft py-3 first:border-t min-[560px]:flex-row min-[560px]:items-center min-[560px]:justify-between min-[560px]:gap-6">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[15px] text-foreground">{product.name}</span>
        {product.active ? null : <Hint>Switched off</Hint>}
        {error ? (
          <span role="alert" className="text-[13px] text-destructive">
            {error}
          </span>
        ) : null}
      </span>
      <div className="w-full min-[560px]:w-[220px]">
        <Select
          value={current}
          onValueChange={(next) => {
            if (isVatTreatment(next) && next !== current) save.mutate(next)
          }}
        >
          <SelectTrigger aria-label={`VAT on ${product.name}`}>
            <SelectValue>
              {(value: string) => (isVatTreatment(value) ? treatmentLabel(value, standardRate) : "")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {VAT_TREATMENTS.map((treatment) => (
              <SelectItem key={treatment} value={treatment}>
                {treatmentLabel(treatment, standardRate)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </li>
  )
}

/** The till products' treatments, below the Save: each acts straight away. */
export function VatProductsSection({ standardRate }: { standardRate: number }) {
  const [saved, setSaved] = React.useState<string | null>(null)
  const products = useQuery({ queryKey: ["till-products-vat"], queryFn: listTillProductsVat, staleTime: 60_000 })
  return (
    <section className="mt-24" aria-labelledby="vat-products-heading" data-testid="vat-products">
      <SectionHeading id="vat-products-heading">VAT on till products</SectionHeading>
      <p className="mb-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
        Saved as soon as it is chosen. A product with none takes its branch&apos;s.
      </p>
      {products.error ? (
        <p role="alert" className="text-[15px] text-destructive">
          {refusalOrFallback(products.error, "The till products would not load. Check the connection and try again.")}
        </p>
      ) : !products.data ? (
        <SkeletonText lines={3} className="max-w-[40rem]" />
      ) : (
        <ul>
          {products.data.map((product) => (
            <ProductRow key={product.id} product={product} standardRate={standardRate} onSaved={setSaved} />
          ))}
        </ul>
      )}
      {saved ? (
        <p aria-live="polite" data-testid="vat-products-saved" className="mt-4 text-[13px] text-muted-foreground">
          {saved}
        </p>
      ) : null}
    </section>
  )
}
