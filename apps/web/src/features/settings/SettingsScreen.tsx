/**
 * Settings: the numbers the whole counter runs on.
 *
 * Admin only. `settings` is one record and `pricing_rules` is a handful of
 * rows, both admin-only collections, so this screen writes them straight
 * through the collection API and then invalidates the config query every
 * other screen reads them through (docs/api-contract.md, "Config").
 *
 * Sections are tracked headings down one page, divided by whitespace the way
 * every other counter screen is. One block button saves the lot, docked in
 * the thumb zone on a phone, with the dirty state said in words beside it.
 *
 * No key, secret or mail setting is on this page: they stay on the server.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useCounterDock } from "@/app/counter-dock"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getSettings,
  listGames,
  listPricingRules,
  savePricingRules,
  saveSettings,
} from "@/lib/api"
import { RulesMatrix } from "@/features/settings/RulesMatrix"
import { SourceOrder } from "@/features/settings/SourceOrder"
import { OfferPreview, SellPreview } from "@/features/settings/previews"
import { CountField, PercentField, PoundsField, TextField } from "@/features/settings/fields"
import {
  CONDITION_KEYS,
  emptyRuleForm,
  formToMarkupBands,
  formToMultipliers,
  formToOfferSettings,
  formToPatch,
  formToPricingRule,
  formToRuleWrite,
  recordToForm,
  RETENTION_MONTHS,
  ruleChanged,
  ruleRowToForm,
  validateRules,
  validateSettings,
  type MarkupBandForm,
  type RuleForm,
  type SettingsForm,
} from "@/features/settings/mapping"
import type { GameRecord, PricingRuleRow, SettingsRecord } from "@/lib/api/types"

/** The same treatment the Sell and Cash screens give a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

const RECEIPT_TERMS_MAX = 4000

function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={className ?? "mt-24"}>
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  )
}

function Editor({
  settings,
  rules: ruleRows,
  games,
}: {
  settings: SettingsRecord
  rules: PricingRuleRow[]
  games: GameRecord[]
}) {
  const dock = useCounterDock()
  const queryClient = useQueryClient()

  const [form, setForm] = React.useState<SettingsForm>(() => recordToForm(settings))
  const [baseline, setBaseline] = React.useState<SettingsForm>(() => recordToForm(settings))
  const [rules, setRules] = React.useState<RuleForm[]>(() =>
    ruleRows.map((row, index) => ruleRowToForm(row, index))
  )
  const [ruleBaseline, setRuleBaseline] = React.useState<RuleForm[]>(() =>
    ruleRows.map((row, index) => ruleRowToForm(row, index))
  )
  const [showErrors, setShowErrors] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  const set = React.useCallback((patch: Partial<SettingsForm>) => {
    setSaved(false)
    setForm((current) => ({ ...current, ...patch }))
  }, [])

  const changedRules = rules.filter((rule) =>
    ruleChanged(
      rule,
      ruleBaseline.find((original) => original.key === rule.key)
    )
  )
  const dirty =
    JSON.stringify(form) !== JSON.stringify(baseline) || changedRules.length > 0

  const settingsErrors = validateSettings(form)
  const rulesErrors = validateRules(rules)
  const errorCount =
    Object.keys(settingsErrors).length + Object.keys(rulesErrors).length
  const shown = showErrors ? settingsErrors : {}
  const shownRules = showErrors ? rulesErrors : {}

  const save = useMutation({
    mutationFn: async () => {
      // The settings record goes first because it is an update and can be
      // repeated safely; the rules write can create rows, and a row created
      // twice is a second band nobody asked for. Its ids are folded into
      // state the moment it resolves, so a failure after it cannot send the
      // same new rule again.
      const record = await saveSettings(form.id, formToPatch(form))
      if (!changedRules.length) return { record }
      const written = await savePricingRules(changedRules.map(formToRuleWrite))
      return { record, written }
    },
    onMutate: () => {
      setError(null)
    },
    onSuccess: ({ written, record }) => {
      const next = recordToForm(record)
      setForm(next)
      setBaseline(next)
      if (written) adoptRules(written)
      setError(null)
      setSaved(true)
      // Every counter screen prices through GET /api/vault/config, so the
      // change reaches the till on the next read rather than the next login.
      void queryClient.invalidateQueries({ queryKey: ["vault-config"] })
      void queryClient.invalidateQueries({ queryKey: ["counter-config"] })
      void queryClient.invalidateQueries({ queryKey: ["settings"] })
      void queryClient.invalidateQueries({ queryKey: ["pricing-rules"] })
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "Those settings did not save. Try again.")),
  })

  function submit() {
    setShowErrors(true)
    if (errorCount > 0) {
      setError(
        `${errorCount} ${errorCount === 1 ? "field needs" : "fields need"} fixing before this saves. Each one has a message under it.`
      )
      return
    }
    setError(null)
    save.mutate()
  }

  function discard() {
    setForm(baseline)
    setRules(ruleBaseline)
    setShowErrors(false)
    setError(null)
    setSaved(false)
  }

  const updateRule = React.useCallback((key: string, patch: Partial<RuleForm>) => {
    setSaved(false)
    setRules((current) =>
      current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule))
    )
  }, [])

  const addRule = React.useCallback(() => {
    setSaved(false)
    setRules((current) => [...current, emptyRuleForm(`new-${Date.now()}`)])
  }, [])

  /**
   * A row that was never saved is not a rule yet, so it goes away rather
   * than being switched off. A saved one never does: the band that priced
   * last week has to stay readable.
   */
  const removeRule = React.useCallback((key: string) => {
    setSaved(false)
    setRules((current) =>
      current.filter((rule) => rule.id !== "" || rule.key !== key)
    )
  }, [])

  /**
   * Take the server's rows as the new truth, ids and all. Called as soon as
   * the rules write resolves, so a retry updates rather than re-creates.
   */
  const adoptRules = React.useCallback((written: PricingRuleRow[]) => {
    const next = written.map((row, index) => ruleRowToForm(row, index))
    setRules(next)
    setRuleBaseline(next)
  }, [])

  function setBand(index: number, patch: Partial<MarkupBandForm>) {
    set({
      markupBands: form.markupBands.map((band, at) =>
        at === index ? { ...band, ...patch } : band
      ),
    })
  }

  const primary = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={save.isPending}
      disabled={!dirty || save.isPending}
      onClick={submit}
    >
      Save settings
    </Button>
  )

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Settings</PageTitle>
      <Lede>The numbers the counter prices, pays and prints with.</Lede>

      {/* ---- Buy-in defaults ---- */}
      <Section title="Buy-in defaults" className="mt-16">
        <div className="flex flex-col gap-10">
          <PoundsField
            id="minimum-offer"
            label="Minimum offer"
            value={form.minimumOffer}
            onChange={(next) => set({ minimumOffer: next })}
            error={shown.minimumOffer}
            note="The least we pay for a single card that is not bulk."
          />
          <PoundsField
            id="bulk-threshold"
            label="Bulk threshold"
            value={form.bulkThreshold}
            onChange={(next) => set({ bulkThreshold: next })}
            error={shown.bulkThreshold}
            note="At or under this value a card is paid at the bulk rate below."
          />
          <PoundsField
            id="bulk-cash"
            label="Bulk, cash"
            value={form.bulkCash}
            onChange={(next) => set({ bulkCash: next })}
            error={shown.bulkCash}
            note="Per card, cash."
          />
          <PoundsField
            id="bulk-credit"
            label="Bulk, credit"
            value={form.bulkCredit}
            onChange={(next) => set({ bulkCredit: next })}
            error={shown.bulkCredit}
            note="Per card, store credit."
          />
          <PercentField
            id="bulk-rate"
            label="Bulk lot rate"
            value={form.bulkRatePct}
            onChange={(next) => set({ bulkRatePct: next })}
            error={shown.bulkRatePct}
            note="What a whole bulk lot is worth as a percent of market, for the lot line on a buy-in."
          />
        </div>

        <SectionHeading className="mt-12 mb-4">Condition</SectionHeading>
        <p className="mb-6 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          What each condition is worth against a near-mint copy. The market value
          is adjusted by these before a pricing rule is picked, so the bands
          below are read in near-mint money.
        </p>
        <div className="flex flex-col gap-10">
          {CONDITION_KEYS.map((key) => (
            <PercentField
              key={key}
              id={`condition-${key}`}
              label={key}
              value={form.conditionPct[key]}
              onChange={(next) =>
                set({ conditionPct: { ...form.conditionPct, [key]: next } })
              }
              error={shown[`conditionPct.${key}`]}
            />
          ))}
        </div>
      </Section>

      {/* ---- Pricing rules, with the live preview under them ---- */}
      <Section title="Pricing rules">
        <RulesMatrix
          rules={rules}
          games={games}
          errors={shownRules}
          onChange={updateRule}
          onAdd={addRule}
          onRemove={removeRule}
        />
        {/* Twelve editable columns and a side panel do not both fit the
            1,040px column, and a matrix you have to scroll sideways to read
            is worse than a preview under it. */}
        <div className="mt-16 border-t border-hairline-soft pt-8">
          <OfferPreview
            rules={rules.map(formToPricingRule)}
            settings={formToOfferSettings(form)}
            multipliers={formToMultipliers(form)}
            games={games}
          />
        </div>
      </Section>

      {/* ---- Sell price ---- */}
      <Section title="Sell price">
        <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          What we add to market value to get the shelf price, by band. Every
          suggested price is rounded up to the next .49 or .99.
        </p>
        <div className="flex flex-col gap-10">
          {form.markupBands.map((band, index) => (
            <div key={band.key} className="flex flex-col gap-10">
              <PoundsField
                id={`band-from-${index}`}
                label={`Band ${index + 1} from`}
                value={band.from}
                onChange={(next) => setBand(index, { from: next })}
                error={shown[`markupBands.${index}.from`]}
              />
              <PercentField
                id={`band-markup-${index}`}
                label={`Band ${index + 1} markup`}
                value={band.markupPct}
                onChange={(next) => setBand(index, { markupPct: next })}
                error={shown[`markupBands.${index}.markupPct`]}
              />
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-8">
          <Button
            variant="text"
            onClick={() =>
              set({
                markupBands: [
                  ...form.markupBands,
                  { key: `band-${Date.now()}`, from: "0.00", markupPct: "0" },
                ],
              })
            }
          >
            Add a band
          </Button>
          {form.markupBands.length > 1 ? (
            <Button
              variant="text"
              onClick={() => set({ markupBands: form.markupBands.slice(0, -1) })}
            >
              Remove the last band
            </Button>
          ) : null}
        </div>
        <SectionHeading className="mt-12 mb-4">What that prices at</SectionHeading>
        <SellPreview bands={formToMarkupBands(form)} />
      </Section>

      {/* ---- Limits ---- */}
      <Section title="Limits">
        <div className="flex flex-col gap-10">
          <PoundsField
            id="cash-cap"
            label="Cash cap"
            value={form.cashCap}
            onChange={(next) => set({ cashCap: next })}
            error={shown.cashCap}
            note="The most that can go out as cash on one buy-in, or come in on one cash sale. Zero switches cash off altogether."
          />
          <PoundsField
            id="cash-variance"
            label="Variance alert"
            value={form.cashVarianceAlert}
            onChange={(next) => set({ cashVarianceAlert: next })}
            error={shown.cashVarianceAlert}
            note="A drawer closing further out than this is recorded for the admin to look at."
          />
          <Field label="ID photo retention" layout="auto">
            <ChipGroup
              aria-label="ID photo retention"
              value={[String(form.retentionMonths)]}
              onValueChange={(next: string[]) =>
                set({ retentionMonths: Number(next[0] ?? form.retentionMonths) })
              }
            >
              {RETENTION_MONTHS.map((months) => (
                <Chip key={months} value={String(months)}>
                  {months} months
                </Chip>
              ))}
            </ChipGroup>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              How long an ID photo is kept after the last cash buy-in. The ID
              details stay on the customer record either way.
            </p>
          </Field>
          <CountField
            id="quote-expiry"
            label="Quote expiry"
            hint="Days"
            value={form.quoteExpiryDays}
            onChange={(next) => set({ quoteExpiryDays: next })}
            error={shown.quoteExpiryDays}
            note="How long a remote quote stands before it lapses."
          />
        </div>
      </Section>

      {/* ---- Shop ---- */}
      <Section title="Shop">
        <div className="flex flex-col gap-10">
          <TextField
            id="shop-name"
            label="Name"
            maxLength={200}
            value={form.shopName}
            onChange={(next) => set({ shopName: next })}
            error={shown.shopName}
          />
          <TextField
            id="shop-address"
            label="Address"
            maxLength={500}
            value={form.shopAddress}
            onChange={(next) => set({ shopAddress: next })}
          />
          <TextField
            id="shop-town"
            label="Town"
            maxLength={100}
            value={form.shopTown}
            onChange={(next) => set({ shopTown: next })}
          />
          <TextField
            id="shop-postcode"
            label="Postcode"
            maxLength={20}
            value={form.shopPostcode}
            onChange={(next) => set({ shopPostcode: next })}
          />
          <TextField
            id="shop-phone"
            label="Phone"
            inputMode="tel"
            maxLength={40}
            value={form.shopPhone}
            onChange={(next) => set({ shopPhone: next })}
          />
          <TextField
            id="shop-email"
            label="Email"
            type="email"
            inputMode="email"
            value={form.shopEmail}
            onChange={(next) => set({ shopEmail: next })}
            error={shown.shopEmail}
          />
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
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              Second-hand goods bought from the public are margin scheme lines
              either way. New supplier stock is standard rated.
            </p>
          </Field>
        </div>
      </Section>

      {/* ---- Receipt terms ---- */}
      <Section title="Receipt terms">
        {/* The count is the textarea's own trailing hint, as DESIGN.md has
            it; a second copy on the label row says the same thing twice. */}
        <Field label="Terms" htmlFor="receipt-terms">
          <Textarea
            id="receipt-terms"
            maxLength={RECEIPT_TERMS_MAX}
            placeholder="What the seller is agreeing to when they sign"
            trailingHint={`${form.receiptTerms.length} / ${RECEIPT_TERMS_MAX}`}
            value={form.receiptTerms}
            onChange={(event) => set({ receiptTerms: event.target.value })}
          />
          <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            Printed on the buy-in receipt and sent with the emailed copy.
          </p>
        </Field>
      </Section>

      {/* ---- Price sources ---- */}
      <Section title="Price sources">
        <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          The order a value is looked for in. The first source with a fresh
          price wins, and a foreign amount is converted to pounds before
          anything sees it.
        </p>
        <div className="flex flex-col gap-12 min-[900px]:flex-row min-[900px]:gap-16">
          <div className="min-[900px]:flex-1">
            <SourceOrder
              label="Cards"
              scope="card order"
              testId="card-sources"
              value={form.sourcePriority}
              onChange={(next) => set({ sourcePriority: next })}
            />
          </div>
          <div className="min-[900px]:flex-1">
            <SourceOrder
              label="Retro"
              scope="retro order"
              testId="retro-sources"
              value={form.retroSourcePriority}
              onChange={(next) => set({ retroSourcePriority: next })}
            />
          </div>
        </div>
        <div className="mt-12">
          <PercentField
            id="haircut"
            label="eBay haircut"
            value={form.haircutPct}
            onChange={(next) => set({ haircutPct: next })}
            error={shown.haircutPct}
            note="Taken off an eBay UK asking price before it is used, because asking prices sit above what things sell for."
          />
        </div>
        <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          API keys for the price sources are held on the server and are never
          sent to this browser. An admin sets them in the PocketBase dashboard
          under the settings record.
        </p>
      </Section>

      {/* ---- Save ---- */}
      <div className="mt-24">
        {error ? (
          <p role="alert" className="mb-6 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-8">
          <div className="hidden min-[900px]:block">{primary}</div>
          {dirty ? (
            <>
              <Badge variant="outline" data-testid="dirty-hint">
                Unsaved changes
              </Badge>
              <Button variant="text" onClick={discard}>
                Discard
              </Button>
            </>
          ) : null}
          {saved ? (
            <span data-testid="settings-saved" aria-live="polite" className="text-[13px] text-muted-foreground">
              Saved.
            </span>
          ) : null}
        </div>
      </div>

      {dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {primary}
            </div>,
            dock
          )
        : null}
    </section>
  )
}

/** Everything under Settings is an admin decision, so staff get one line. */
function AdminsOnly() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Settings</PageTitle>
      <Lede>Settings are for admins. Ask Richard if something needs changing.</Lede>
    </section>
  )
}

export function SettingsScreen() {
  const staff = useStaff()
  const admin = staff?.role === "admin"

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled: admin,
    staleTime: 60_000,
  })
  const rules = useQuery({
    queryKey: ["pricing-rules"],
    queryFn: listPricingRules,
    enabled: admin,
    staleTime: 60_000,
  })
  const games = useQuery({
    queryKey: ["games"],
    queryFn: listGames,
    enabled: admin,
    staleTime: 5 * 60_000,
  })

  if (!admin) return <AdminsOnly />

  if (settings.error || rules.error || games.error) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Settings</PageTitle>
        <Lede>
          {refusalOrFallback(
            settings.error ?? rules.error ?? games.error,
            "The settings would not load. Check the connection and try again."
          )}
        </Lede>
      </section>
    )
  }

  if (!settings.data || !rules.data || !games.data) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Settings</PageTitle>
        <Lede>The numbers the counter prices, pays and prints with.</Lede>
        <p className="mt-14 text-[15px] text-muted-foreground-2">Loading the settings.</p>
      </section>
    )
  }

  return (
    <Editor
      key={settings.data.id}
      settings={settings.data}
      rules={rules.data}
      games={games.data}
    />
  )
}
