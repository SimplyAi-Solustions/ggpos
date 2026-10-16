/**
 * Open the till (docs/api-contract-epos.md, section 3, `POST
 * /api/vault/till/open`): count the float into the drawer by denomination,
 * or open on the float Settings suggests (`settings.epos.default_float`)
 * without counting it. One open session per register; the server refuses a
 * second with its own sentence.
 */
import * as React from "react"
import { formatGBP, type TillSession } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { SectionHeading } from "@/components/ui/micro-label"
import { CountTable } from "@/features/cash/CountTable"
import {
  badCountFields,
  countsFromFields,
  countsTotal,
  type CountFields,
} from "@/features/cash/count"
import { BLOCKED, DockedPrimary } from "@/features/cash/primary"
import { OverrideCancelled, withOverride } from "@/features/lock/override"
import { refusalOrFallback } from "@/lib/api/refusal"
import { openTill } from "@/lib/api/tillops"

export const COUNT_HELP =
  "Each count is a whole number of notes or coins. Check the ones underlined."

export function OpenTill({
  register,
  defaultFloat,
  onOpened,
}: {
  register: string
  defaultFloat: number
  onOpened: (session: TillSession) => void
}) {
  const [mode, setMode] = React.useState<"count" | "suggested">("count")
  const [fields, setFields] = React.useState<CountFields>({})
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const total = countsTotal(countsFromFields(fields))

  async function open() {
    setError(null)
    if (mode === "count") {
      if (badCountFields(fields).length) {
        setError(COUNT_HELP)
        return
      }
      if (total === 0) {
        setError("Count the float into the drawer, or open on the suggested float.")
        return
      }
    }
    const float = mode === "count" ? total : defaultFloat
    setBusy(true)
    try {
      const session = await withOverride(
        (headers) =>
          openTill(mode === "count" ? { counts: countsFromFields(fields) } : { float }, headers),
        { describe: () => `Open the till with a ${formatGBP(float)} float`, context: { amount: float } }
      )
      onOpened(session)
    } catch (cause) {
      if (cause instanceof OverrideCancelled) return
      setError(refusalOrFallback(cause, "The till did not open. Try again."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-14" aria-labelledby="open-till-heading">
      <SectionHeading id="open-till-heading">Open the till</SectionHeading>
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        {register} is closed, so nothing can be sold on it. Count the float into
        the drawer, or open on the suggested float and count it at the Z.
      </p>

      <ChipGroup
        aria-label="How to open the till"
        className="mt-8"
        value={[mode]}
        onValueChange={(next: string[]) => {
          const chosen = next[0]
          if (chosen === "count" || chosen === "suggested") {
            setMode(chosen)
            setError(null)
          }
        }}
      >
        <Chip value="count">Count the float</Chip>
        <Chip value="suggested">Suggested float, {formatGBP(defaultFloat)}</Chip>
      </ChipGroup>

      <div className="mt-10">
        {mode === "count" ? (
          <CountTable
            idPrefix="float"
            label="Count the float"
            totalLabel="Float"
            fields={fields}
            onChange={(next) => {
              setFields(next)
              setError(null)
            }}
          />
        ) : (
          <p data-testid="suggested-float" className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
            The till opens with <span className="tnum font-medium">{formatGBP(defaultFloat)}</span> in
            the drawer, the float Settings suggests.
          </p>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-6 text-[13px] leading-[1.45] text-destructive">
          {error}
        </p>
      ) : null}

      <DockedPrimary className="mt-12 hidden min-[900px]:block">
        <Button className={BLOCKED} trailingArrow loading={busy} onClick={() => void open()}>
          Open the till
        </Button>
      </DockedPrimary>
    </section>
  )
}
