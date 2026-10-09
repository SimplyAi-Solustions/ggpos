/**
 * The Z report: cash up and close the till (docs/api-contract-epos.md,
 * section 3, `POST /api/vault/till/z`; DESIGN.md section 10, "Cashing up").
 *
 * In the order DESIGN.md gives: the blind count by denomination, then the
 * Tide card total with the sentence that says where to find it, an
 * optional bank drop, and notes. Nothing on this screen says what the
 * drawer should hold until the count is saved: the variance is on the
 * report that follows, in words and in figures. A Z is numbered, stored
 * and cannot be changed, so the server is the one that refuses, in its own
 * sentences, and the screen only checks what it can see for itself first.
 */
import * as React from "react"
import { formatGBP, parseDecimalToMinor, type TillReport } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { SectionHeading } from "@/components/ui/micro-label"
import { Textarea } from "@/components/ui/textarea"
import { CountTable } from "@/features/cash/CountTable"
import { badCountFields, countsFromFields, countsTotal, type CountFields } from "@/features/cash/count"
import { COUNT_HELP } from "@/features/cash/OpenTill"
import { BLOCKED, DockedPrimary } from "@/features/cash/primary"
import { MoneyInput } from "@/features/sell/money-input"
import { OverrideCancelled, withOverride } from "@/features/lock/override"
import { refusalOrFallback } from "@/lib/api/refusal"
import { runZReport } from "@/lib/api/tillops"

/** The sentence under the Tide field, word for word from DESIGN.md. */
export const TIDE_SENTENCE = "From the Tide app, Payments, today's card total."

type Problem = { field: "count" | "tide" | "drop" | "form"; message: string }

export function CloseTill({
  register,
  tideRequired,
  onClosed,
  onBack,
}: {
  register: string
  /** `settings.epos.z_requires_card_total` and the till took card today. */
  tideRequired: boolean
  onClosed: (report: TillReport) => void
  onBack: () => void
}) {
  const [fields, setFields] = React.useState<CountFields>({})
  const [tide, setTide] = React.useState("")
  const [drop, setDrop] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [problem, setProblem] = React.useState<Problem | null>(null)
  const [busy, setBusy] = React.useState(false)

  const errorFor = (field: Problem["field"]) => (problem?.field === field ? problem.message : null)

  async function close() {
    setProblem(null)
    if (badCountFields(fields).length) {
      setProblem({ field: "count", message: COUNT_HELP })
      return
    }
    const counts = countsFromFields(fields)
    if (countsTotal(counts) === 0) {
      setProblem({ field: "count", message: "Count the drawer before closing the till." })
      return
    }
    let tidePence: number | null = null
    if (tide.trim()) {
      tidePence = parseDecimalToMinor(tide)
      if (tidePence === null || tidePence < 0) {
        setProblem({
          field: "tide",
          message: "Enter the Tide total in pounds and pence, for example 132.43.",
        })
        return
      }
    } else if (tideRequired) {
      setProblem({ field: "tide", message: "Enter the Tide card total for today from the Tide app." })
      return
    }
    let dropPence: number | undefined
    if (drop.trim()) {
      const parsed = parseDecimalToMinor(drop)
      if (parsed === null || parsed < 0) {
        setProblem({
          field: "drop",
          message: "Enter the bank drop in pounds and pence, for example 200.00, or leave it empty.",
        })
        return
      }
      // The drop comes out of what was counted, so it cannot be more than
      // the count. Saying so names only the count, never what the drawer
      // should hold.
      const counted = countsTotal(counts)
      if (parsed > counted) {
        setProblem({
          field: "drop",
          message: `The bank drop cannot be more than the ${formatGBP(counted)} counted.`,
        })
        return
      }
      dropPence = parsed || undefined
    }

    setBusy(true)
    try {
      const result = await withOverride(
        (headers) =>
          runZReport(
            {
              counts,
              card_reported_total: tidePence,
              bank_drop: dropPence,
              notes: notes.trim() || undefined,
            },
            headers
          ),
        { describe: () => `Cash up and close ${register}` }
      )
      onClosed(result.report)
    } catch (cause) {
      if (cause instanceof OverrideCancelled) return
      setProblem({
        field: "form",
        message: refusalOrFallback(cause, "The Z report did not save. Check the count and try again."),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-12" data-testid="z-close">
      <section aria-labelledby="z-count-heading">
        <SectionHeading id="z-count-heading">Count the drawer</SectionHeading>
        <p className="mb-8 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          Count every note and coin in the drawer, before anything comes out
          for the bank. What it should hold is on the Z report once the count
          is saved.
        </p>
        <CountTable
          idPrefix="z"
          label="Count the drawer"
          fields={fields}
          onChange={(next) => {
            setFields(next)
            if (problem?.field === "count") setProblem(null)
          }}
        />
        {errorFor("count") ? (
          <p role="alert" className="mt-4 text-[13px] leading-[1.45] text-destructive">
            {errorFor("count")}
          </p>
        ) : null}
      </section>

      <section className="mt-16" aria-labelledby="z-card-heading">
        <SectionHeading id="z-card-heading">Card and bank</SectionHeading>
        <FieldRow>
          <Field
            label="Tide card total"
            hint={tideRequired ? "Required" : "Optional"}
            htmlFor="z-tide"
            error={errorFor("tide")}
          >
            <MoneyInput
              id="z-tide"
              value={tide}
              invalid={problem?.field === "tide"}
              onChange={(next) => {
                setTide(next)
                if (problem?.field === "tide") setProblem(null)
              }}
            />
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              {TIDE_SENTENCE}
            </p>
          </Field>
          <Field label="To the bank" hint="Optional" htmlFor="z-drop" error={errorFor("drop")}>
            <MoneyInput
              id="z-drop"
              value={drop}
              invalid={problem?.field === "drop"}
              onChange={(next) => {
                setDrop(next)
                if (problem?.field === "drop") setProblem(null)
              }}
            />
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              How much of what you counted is going to the bank tonight. The
              rest stays in the drawer.
            </p>
          </Field>
          <Field label="Notes" hint="Optional" htmlFor="z-notes">
            <Textarea
              id="z-notes"
              maxLength={500}
              placeholder="Anything that explains the count"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </FieldRow>
      </section>

      {errorFor("form") ? (
        <p role="alert" className="mt-10 text-[13px] leading-[1.45] text-destructive">
          {errorFor("form")}
        </p>
      ) : null}

      <div className="mt-12 flex flex-wrap items-center gap-8">
        <DockedPrimary>
          <Button className={BLOCKED} trailingArrow loading={busy} onClick={() => void close()}>
            Close the till
          </Button>
        </DockedPrimary>
        <Button variant="text" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  )
}
