/**
 * Settings, Guild (docs/api-contract-launch.md, section 2): the price of the
 * paid upgrade, the terms a member agrees to and the points they start with.
 *
 * Three numbers and a paragraph from two records: the price is the Guild
 * Membership till product's own (so the till sells at what is set here), the
 * terms and the welcome bonus are the loyalty programme's. It saves on its
 * own, like the Tills section beside it, rather than with the page's Save,
 * because neither record is the settings row that button writes.
 */
import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { SectionHeading } from "@/components/ui/micro-label"
import { Textarea } from "@/components/ui/textarea"
import { CountField, PoundsField } from "@/features/settings/fields"
import { parseCount, penceToPounds, poundsToPence } from "@/features/settings/mapping"
import { refusalOrFallback } from "@/lib/api/refusal"
import { getGuildSettings, saveGuildSettings, type GuildSettings } from "@/lib/api/guild-settings"

const GUILD_KEY = ["guild-settings"] as const

function GuildForm({ settings }: { settings: GuildSettings }) {
  const queryClient = useQueryClient()
  const [price, setPrice] = React.useState(() => penceToPounds(settings.product?.price ?? 0))
  const [bonus, setBonus] = React.useState(() => String(settings.welcomeBonus))
  const [terms, setTerms] = React.useState(settings.terms)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const pence = poundsToPence(price)
  const points = parseCount(bonus)
  const priceError = settings.product && (pence === null || pence < 0) ? "Enter the price in pounds and pence, for example 24.00." : undefined
  const bonusError = points === null ? "The welcome bonus is a whole number of points." : undefined

  async function save() {
    if (priceError || bonusError || points === null) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const saved = await saveGuildSettings({
        programmeId: settings.programmeId,
        terms,
        welcomeBonus: points,
        productId: settings.product?.id ?? null,
        price: settings.product ? pence : null,
      })
      queryClient.setQueryData(GUILD_KEY, saved)
      for (const key of [["loyalty-admin"], ["counter-config"], ["vault-config"], ["till-catalogue"], ["offer-products"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
      setNote("Saved. The till sells at the new price from the next sale.")
    } catch (cause) {
      setError(refusalOrFallback(cause, "The Guild settings did not save. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const product = settings.product
  return (
    <div className="flex flex-col gap-10">
      {product ? (
        <PoundsField
          id="guild-price"
          label="Membership price"
          hint={product.months ? `${product.months} months` : undefined}
          value={price}
          onChange={setPrice}
          error={priceError}
          note={`${product.name} sells ${product.tierName || "the paid plan"} at the till${product.active ? "" : ", once it is switched on"}. Now ${formatGBP(product.price)}.`}
        />
      ) : (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          There is no Guild Membership till product, so the paid upgrade cannot be sold yet.
        </p>
      )}
      <CountField
        id="guild-welcome"
        label="Welcome bonus"
        hint="points"
        value={bonus}
        onChange={setBonus}
        error={bonusError}
        note="Paid once, when a customer joins the Guild."
      />
      <Field label="Terms" htmlFor="guild-terms">
        <Textarea
          id="guild-terms"
          maxLength={4000}
          placeholder="What a member is agreeing to"
          trailingHint={`${terms.length} / 4000`}
          value={terms}
          onChange={(event) => setTerms(event.target.value)}
        />
        <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          Shown in My Vault before a customer joins, and read out at the till.
        </p>
      </Field>
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="text" type="button" disabled={busy} onClick={() => void save()}>
          Save the Guild
        </Button>
        {note ? (
          <p aria-live="polite" data-testid="guild-settings-saved" className="text-[13px] text-muted-foreground">
            {note}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function GuildSettingsSection() {
  const settings = useQuery({ queryKey: GUILD_KEY, queryFn: getGuildSettings, staleTime: 60_000 })
  return (
    <section className="mt-24" aria-labelledby="guild-heading" data-testid="guild-settings">
      <SectionHeading id="guild-heading">Guild</SectionHeading>
      {settings.data ? (
        <GuildForm key={settings.data.programmeId} settings={settings.data} />
      ) : (
        <p className="text-[15px] text-muted-foreground-2">
          {settings.error
            ? refusalOrFallback(settings.error, "The Guild settings would not load. Check the connection and try again.")
            : "Loading the Guild settings."}
        </p>
      )}
    </section>
  )
}
