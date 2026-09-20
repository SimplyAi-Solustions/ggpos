import * as React from "react"
import { formatGBP } from "@gg/shared"

import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ID_PRIVACY_SENTENCE,
  formatDate,
} from "@/features/customers/format"
import {
  ageAt,
  cashBlock,
  needsIdGate,
  type Payout,
  type WizardCustomer,
} from "@/features/tradein/machine"
import { downscaleToJpeg } from "@/features/tradein/id-photo"
import type { IdCaptureValues } from "@/features/tradein/id-capture"
import type { IdType } from "@/lib/api"

const ID_TYPES: { value: IdType; label: string }[] = [
  { value: "passport", label: "Passport" },
  { value: "driving_licence", label: "Driving licence" },
  { value: "other", label: "Other" },
]

export interface IdStepProps {
  customer: WizardCustomer
  payout: Payout
  cashCap: number
  values: IdCaptureValues
  onChange: (patch: Partial<IdCaptureValues>) => void
  /** The server's own refusal, shown under the control that caused it. */
  serverError: string | null
}

/**
 * The cash gate.
 *
 * A cash buy-in is the one place GG Vault takes identity documents, and
 * `docs/privacy-notice.md` is read to the customer here rather than buried.
 * The photo never leaves this screen at full size: it is drawn into a canvas
 * at 1600px on the long edge and re-encoded as JPEG, which drops the EXIF the
 * phone wrote with it.
 */
export function IdStep({
  customer,
  payout,
  cashCap,
  values,
  onChange,
  serverError,
}: IdStepProps) {
  const [preview, setPreview] = React.useState<string | null>(null)
  const [photoError, setPhotoError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const alreadyGood = !needsIdGate(customer.facts)
  const block = cashBlock(customer.facts, payout.cash, cashCap)
  const typedAge = ageAt(values.dob, new Date())
  const underAge = typedAge !== null && typedAge < 18

  async function takePhoto(file: File) {
    setBusy(true)
    setPhotoError(null)
    try {
      const result = await downscaleToJpeg(file)
      setPreview(result.dataUrl)
      onChange({ photo: result.blob })
    } catch (error) {
      setPhotoError(
        error instanceof Error
          ? error.message
          : "That photo could not be read. Take it again."
      )
    } finally {
      setBusy(false)
    }
  }

  if (block.kind === "cap") {
    return (
      <div>
        <SectionHeading className="mt-0">ID check</SectionHeading>
        <p className="max-w-[56ch] text-base leading-[1.5] text-destructive">
          {block.message}
        </p>
        <p className="mt-5 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          The cash on this buy-in is {formatGBP(payout.cash)}. Go back to the
          offer and move the difference to store credit.
        </p>
      </div>
    )
  }

  if (alreadyGood) {
    return (
      <div>
        <SectionHeading className="mt-0">ID check</SectionHeading>
        <p
          data-testid="id-already-verified"
          className="max-w-[56ch] text-base leading-[1.5] text-foreground"
        >
          {customer.name}&rsquo;s {customer.facts.idType || "ID"} is on file and
          runs to {formatDate(customer.facts.idExpiry)}. Nothing else is needed.
        </p>
        <p className="mt-5 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          Paying {formatGBP(payout.cash)} in cash
          {payout.credit > 0
            ? ` and ${formatGBP(payout.credit)} as store credit.`
            : "."}
        </p>
        {serverError ? (
          <p role="alert" className="mt-8 max-w-[56ch] text-[13px] text-destructive">
            {serverError}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      <SectionHeading className="mt-0">ID check</SectionHeading>
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        {ID_PRIVACY_SENTENCE}
      </p>

      <div className="mt-10">
        <MicroLabel className="mb-3">Photo of the ID</MicroLabel>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          data-testid="id-photo-input"
          aria-label="Photograph of the identity document"
          className="block w-full text-[15px] text-muted-foreground file:mr-4 file:border file:border-hairline file:bg-transparent file:px-4 file:py-2 file:font-mono file:text-[11px] file:font-bold file:tracking-[0.16em] file:text-foreground file:uppercase"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void takePhoto(file)
          }}
        />
        {busy ? <Hint className="mt-3 block">Resizing the photo</Hint> : null}
        {photoError ? (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {photoError}
          </p>
        ) : null}
        {preview ? (
          <img
            src={preview}
            alt="The identity document just photographed"
            data-testid="id-photo-preview"
            className="mt-5 max-h-56 w-auto border border-hairline"
          />
        ) : null}
        {/* Sentence case, not a tracked label: DESIGN.md caps an uppercase
            run at about 24 characters and this is an explanation. */}
        <p className="mt-3 max-w-[46ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Resized to 1600px and re-encoded, so no location data is kept.
        </p>
      </div>

      <div className="mt-12 flex max-w-[34rem] flex-col gap-8">
        <Field label="ID type" htmlFor="id-type" layout="stacked">
          <Select
            value={values.idType}
            onValueChange={(next) => {
              if (next) onChange({ idType: next as IdType })
            }}
          >
            <SelectTrigger id="id-type">
              <SelectValue>
                {(value: string) =>
                  ID_TYPES.find((option) => option.value === value)?.label ??
                  "Passport"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ID_TYPES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Expires" htmlFor="id-expiry" layout="stacked">
          <Input
            id="id-expiry"
            type="date"
            className="tnum"
            value={values.idExpiry}
            onChange={(event) => onChange({ idExpiry: event.target.value })}
          />
        </Field>

        <Field label="Last four digits" htmlFor="id-last4" layout="stacked">
          <Input
            id="id-last4"
            inputMode="numeric"
            maxLength={4}
            className="tnum"
            placeholder="1234"
            value={values.idRefLast4}
            onChange={(event) =>
              onChange({ idRefLast4: event.target.value.replace(/\D/g, "").slice(0, 4) })
            }
          />
        </Field>

        <Field
          label="Date of birth"
          htmlFor="id-dob"
          layout="stacked"
          error={
            underAge
              ? "This customer is under 18, so cash is not an option. Go back and offer store credit."
              : undefined
          }
        >
          <Input
            id="id-dob"
            type="date"
            className="tnum"
            aria-invalid={underAge || undefined}
            value={values.dob}
            onChange={(event) => onChange({ dob: event.target.value })}
          />
        </Field>

        <Field label="Address" htmlFor="id-address" layout="stacked">
          <Textarea
            id="id-address"
            maxLength={300}
            placeholder="1 High Street, Bolsover, S44 6AA"
            value={values.address}
            onChange={(event) => onChange({ address: event.target.value })}
          />
        </Field>

        <div className="flex items-start gap-4">
          <Switch
            checked={values.attested}
            onCheckedChange={(next) => onChange({ attested: next })}
            aria-label="I have seen the original document and it matches"
          />
          <p className="max-w-[46ch] text-[15px] leading-[1.5] text-muted-foreground">
            I have seen the original document, it matches the person in front of
            me, and the details above are what it says.
          </p>
        </div>
      </div>

      {serverError ? (
        <p role="alert" className="mt-10 max-w-[56ch] text-[13px] text-destructive">
          {serverError}
        </p>
      ) : null}
    </div>
  )
}
