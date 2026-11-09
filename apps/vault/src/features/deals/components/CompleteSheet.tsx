import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Camera, CheckCircle2, IdCard, Printer, ShieldCheck } from "lucide-react"
import type { Deal, DealPayout } from "@gg/shared/deal"
import { formatGBP } from "@gg/shared/money"

import { cn } from "@/lib/cn"
import { Button, Input, Segmented, Sheet, Skeleton } from "@/ui"

import * as api from "../api"
import {
  cashRefusal,
  EMPTY_CAPTURE,
  ID_TYPES,
  idCaptureProblem,
  idCheckForm,
  idCheckFrom,
  idGate,
  type IdCaptureValues,
  type IdGate,
  type IdType,
} from "../id-capture"
import { downscaleToJpeg } from "../id-photo"
import type { CompletionResult, DealDraft, Seller } from "../types"
import { SellerPicker } from "./SellerPicker"

const PRIVACY_SENTENCE =
  "We keep your details to run the shop, to meet tax law, and to prevent crime. " +
  "You can ask us to see, correct or delete them at any time."

const ID_PRIVACY_SENTENCE =
  "We photograph the ID to prevent and detect crime, keep it for up to twelve months, " +
  "and keep the name, address, ID type, last four digits and expiry for six years."

export interface CompleteSheetProps {
  open: boolean
  onClose: () => void
  draft: DealDraft
  deal: Deal
  payout: DealPayout
  onSeller: (seller: Seller | null) => void
  /** Waits for autosave to reach the server. */
  flush: () => Promise<void>
  onDone: (result: CompletionResult) => void
}

/**
 * The last step: who is selling, the ID check for any cash at all, the
 * terms, then POST /api/vault/deals/{id}/complete. The server runs every
 * check again; nothing here is a way round it.
 */
export function CompleteSheet({ open, onClose, draft, deal, payout, onSeller, flush, onDone }: CompleteSheetProps) {
  const seller = draft.seller
  const cash = payout.cash > 0
  const [values, setValues] = React.useState<IdCaptureValues>(EMPTY_CAPTURE)
  const [terms, setTerms] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<CompletionResult | null>(null)

  const facts = useQuery({
    queryKey: ["deals", "seller-facts", seller?.id ?? ""],
    queryFn: () => api.getSellerFacts(seller!.id),
    enabled: open && cash && Boolean(seller),
    staleTime: 0,
  })

  // A new seller starts a new check; their address on file fills the form.
  const valuesFor = `${seller?.id ?? ""}|${facts.data?.address ?? ""}`
  const [valuesKey, setValuesKey] = React.useState(valuesFor)
  if (valuesKey !== valuesFor) {
    setValuesKey(valuesFor)
    setValues({ ...EMPTY_CAPTURE, address: facts.data?.address ?? "" })
  }

  const gate: IdGate | null = cash && facts.data ? idGate(facts.data) : null
  const refusal = cash && facts.data ? cashRefusal(facts.data) : null
  const idProblem = gate ? idCaptureProblem(values, gate) : null

  const blocker = !seller
    ? "Pick or add the seller."
    : cash && facts.isPending
      ? "Checking the seller's ID on file."
      : cash && facts.isError
        ? api.explain(facts.error, "The seller's ID record did not load. Try again.")
        : refusal
          ? refusal
          : idProblem
            ? idProblem
            : !terms
              ? "Read the terms to the customer and tick to agree."
              : null

  const submit = async () => {
    if (blocker || !seller) return
    setBusy(true)
    setError(null)
    try {
      await flush()
      // The server prices the stored deal with the same maths; a difference
      // means the screen and the record disagree, so nobody is paid on it.
      const server = await api.getServerDeal(draft.id)
      if (server.trade_total !== deal.trade || server.cash_total !== deal.cash) {
        throw new Error(
          `The server has this deal at ${formatGBP(server.trade_total)} credit or ${formatGBP(server.cash_total)} cash, not what is on screen. Close this, wait for Saved, and try again.`
        )
      }
      let idCheck: api.IdCheckPayload | null = null
      if (cash && gate?.needed) {
        if (gate.reason === "full") {
          const stored = await api.submitIdCheck(seller.id, idCheckForm(values))
          idCheck = idCheckFrom(values, stored.id_document)
        } else {
          idCheck = { address: values.address.trim() }
        }
      }
      const done = await api.completeDeal(draft.id, {
        cash_taken: payout.cash,
        credit_given: payout.credit,
        terms_accepted: terms,
        id_check: idCheck,
      })
      setResult(done)
    } catch (err) {
      setError(api.explain(err, "The deal did not complete. Nothing was booked in. Try again."))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <Sheet
        open={open}
        onClose={() => onDone(result)}
        title="Deal completed"
        footer={
          <Button block size="lg" onClick={() => onDone(result)}>
            Done
          </Button>
        }
      >
        <CompletionSummary result={result} />
      </Sheet>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Complete deal"
      description={`${payout.credit ? `${formatGBP(payout.credit)} credit` : ""}${payout.credit && payout.cash ? " and " : ""}${payout.cash ? `${formatGBP(payout.cash)} cash` : ""}`}
      footer={
        <div className="flex flex-col gap-2">
          {(error || blocker) && (
            <p className={cn("text-sm", error ? "font-medium text-pop-text" : "text-fg-2")} role={error ? "alert" : undefined} data-testid="complete-blocker">
              {error ?? blocker}
            </p>
          )}
          <Button block size="lg" onClick={submit} loading={busy} disabled={Boolean(blocker)}>
            Complete deal, {formatGBP(payout.cash + payout.credit)}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6 pt-1">
        <Section n={1} title="Seller">
          <SellerPicker seller={seller} onChange={onSeller} />
        </Section>

        {cash && (
          <Section n={2} title="ID check" icon={<IdCard className="size-4" aria-hidden />}>
            {!seller ? (
              <p className="text-sm text-fg-2">Any cash needs the seller's ID on file. Pick the seller first.</p>
            ) : facts.isPending ? (
              <Skeleton className="h-24" />
            ) : facts.isError ? (
              <p className="text-sm text-pop-text" role="alert">
                {api.explain(facts.error, "The seller's ID record did not load. Try again.")}
              </p>
            ) : refusal ? (
              <p className="text-sm font-medium text-pop-text" role="alert">
                {refusal}
              </p>
            ) : gate && !gate.needed ? (
              <p className="flex items-start gap-2 text-sm" data-testid="id-on-file">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                ID on file and in date until {formatDay(facts.data!.idExpiry)}, with a photo. Nothing else needed.
              </p>
            ) : gate?.needed && gate.reason === "address" ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-fg-2">ID is on file. The buy-in record needs the seller's address as well.</p>
                <Input
                  label="Address with postcode"
                  value={values.address}
                  onChange={(e) => setValues((v) => ({ ...v, address: e.target.value }))}
                />
              </div>
            ) : (
              <IdCaptureForm values={values} onChange={(patch) => setValues((v) => ({ ...v, ...patch }))} />
            )}
          </Section>
        )}

        <Section n={cash ? 3 : 2} title="Terms">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-1 size-5 shrink-0 accent-[var(--volt-deep)]"
            />
            <span className="text-sm text-fg-2">
              The customer confirms the items are theirs to sell and agrees to the buy-in terms. {PRIVACY_SENTENCE}
            </span>
          </label>
        </Section>
      </div>
    </Sheet>
  )
}

function Section({ n, title, icon, children }: { n: number; title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="label-mono flex items-center gap-2 text-fg-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-ink font-mono text-[10px] text-paper dark:bg-paper dark:text-ink">
          {n}
        </span>
        {title}
        {icon}
      </h3>
      {children}
    </section>
  )
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** Photo, type, expiry, last four, date of birth, address and the attestation. */
function IdCaptureForm({ values, onChange }: { values: IdCaptureValues; onChange: (patch: Partial<IdCaptureValues>) => void }) {
  const [preview, setPreview] = React.useState<string | null>(null)
  const [photoError, setPhotoError] = React.useState<string | null>(null)
  const [resizing, setResizing] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const take = async (file: File) => {
    setResizing(true)
    setPhotoError(null)
    try {
      const result = await downscaleToJpeg(file)
      setPreview(result.dataUrl)
      onChange({ photo: result.blob })
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "That photo could not be read. Take it again.")
    } finally {
      setResizing(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">{ID_PRIVACY_SENTENCE}</p>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label="Photograph of the identity document"
        data-testid="id-photo-input"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void take(file)
        }}
      />
      {preview ? (
        <div className="flex items-center gap-3">
          <img src={preview} alt="The ID just photographed" className="h-20 w-auto rounded-sm border border-line-2" data-testid="id-photo-preview" />
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
            Retake
          </Button>
        </div>
      ) : (
        <Button variant="secondary" icon={<Camera className="size-4" aria-hidden />} loading={resizing} onClick={() => fileRef.current?.click()}>
          Photograph the ID
        </Button>
      )}
      {photoError && (
        <p className="text-sm text-pop-text" role="alert">
          {photoError}
        </p>
      )}
      <p className="text-xs text-fg-3">Resized to 1600px and re-encoded, so no location data is kept.</p>
      <Segmented<IdType>
        label="ID type"
        size="sm"
        block
        value={values.idType}
        onChange={(idType) => onChange({ idType })}
        options={ID_TYPES.map((t) => ({ value: t.value, label: t.value === "other" ? "Other" : t.value === "driving_licence" ? "Licence" : t.label }))}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Expires" type="date" mono value={values.idExpiry} onChange={(e) => onChange({ idExpiry: e.target.value })} />
        <Input
          label="Last 4 of ID number"
          mono
          maxLength={4}
          autoComplete="off"
          value={values.idRefLast4}
          onChange={(e) => onChange({ idRefLast4: e.target.value.toUpperCase().slice(0, 4) })}
        />
      </div>
      <Input label="Date of birth" type="date" mono value={values.dob} onChange={(e) => onChange({ dob: e.target.value })} />
      <Input label="Address with postcode" value={values.address} onChange={(e) => onChange({ address: e.target.value })} />
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={values.attested}
          onChange={(e) => onChange({ attested: e.target.checked })}
          className="mt-1 size-5 shrink-0 accent-[var(--volt-deep)]"
        />
        <span className="text-sm text-fg-2">
          I have seen the original document, it matches the person in front of me, and the details above are what it
          says.
        </span>
      </label>
    </div>
  )
}

/** What the server booked in. */
export function CompletionSummary({ result }: { result: CompletionResult }) {
  const { tradeIn } = result
  return (
    <div className="flex flex-col gap-4" data-testid="completion">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="size-8 shrink-0 text-ok" aria-hidden />
        <div>
          <p className="font-mono text-lg font-bold tnum">{tradeIn.number}</p>
          <p className="text-sm text-fg-2">
            {tradeIn.creditGiven > 0 && `${formatGBP(tradeIn.creditGiven)} trade credit`}
            {tradeIn.creditGiven > 0 && tradeIn.cashTaken > 0 && " and "}
            {tradeIn.cashTaken > 0 && `${formatGBP(tradeIn.cashTaken)} cash`}
          </p>
        </div>
      </div>
      {tradeIn.creditGiven > 0 && (
        <p className="rounded-md border border-warn/40 px-3 py-2 text-sm text-fg-2">
          The credit is recorded on this buy-in, not on the customer's balance yet. Note it for the till.
        </p>
      )}
      <div>
        <p className="label-mono mb-1.5 text-fg-2">
          {result.items.length} {result.items.length === 1 ? "item" : "items"} into stock
        </p>
        <ul className="divide-y divide-line border-y border-line">
          {result.items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-sm">{item.title}</span>
              <span className="shrink-0 font-mono text-xs font-bold tnum">{item.sku}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="flex items-center gap-2 text-sm text-fg-2">
        <Printer className="size-4" aria-hidden />
        {result.labelsQueued} {result.labelsQueued === 1 ? "label" : "labels"} queued to print.
      </p>
    </div>
  )
}
