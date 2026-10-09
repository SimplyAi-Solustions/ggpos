/**
 * Settings: the numbers the whole counter runs on.
 *
 * Admin only, but for Tills: `settings` is one record and `pricing_rules` is
 * a handful of rows, both admin-only collections, so this screen writes
 * them straight through the collection API and then invalidates the config
 * query every other screen reads them through (docs/api-contract.md,
 * "Config"). A manager registers tills, so a manager sees the Tills section
 * and nothing else.
 *
 * Phase 8 adds the till's settings (`settings.epos`,
 * docs/api-contract-epos.md, section 1) to the same form and the same Save:
 * the discount limit, the card's last four digits, the auto-lock, the quick
 * cash notes, the default float, the Z's Tide total, the permissions
 * table, the receipt's header, footer and returns policy, the My Vault QR
 * and the VAT number. Tills and Printers act straight away and sit after
 * the Save, because nothing in them waits for it.
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
import { isManagerUp, useStaffRole } from "@/features/lock/role"
import { AgentsSection } from "@/features/settings/AgentsSection"
import { CategoriesSection } from "@/features/settings/CategoriesSection"
import { PermissionsTable } from "@/features/settings/PermissionsTable"
import { PrintersSection } from "@/features/settings/PrintersSection"
import { TillsSection } from "@/features/settings/TillsSection"
import { GuildSettingsSection } from "@/features/settings/GuildSettingsSection"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  getSettings,
  listGames,
  listPricingRules,
  savePricingRules,
  saveSettings,
} from "@/lib/api"
import { useVaultConfig } from "@/lib/api/config"
import {
  EMAIL_PROVIDER_LABEL,
  pushPublicKeyFrom,
} from "@/lib/api/notifications"
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
  QUICK_CASH_CHOICES,
  recordToForm,
  RETENTION_MONTHS,
  setPermission,
  ruleChanged,
  ruleRowToForm,
  validateRules,
  validateSettings,
  type MarkupBandForm,
  type RuleForm,
  type SettingsForm,
} from "@/features/settings/mapping"
import type { GameRecord, PricingRuleRow, SettingsRecord } from "@/lib/api/types"
import { formatGBP } from "@gg/shared"

/** The same treatment the Sell and Cash screens give a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

const RECEIPT_TERMS_MAX = 4000
const RECEIPT_TEXT_MAX = 500

/** A note under a control: what the setting actually does. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
      {children}
    </p>
  )
}

/** A switch with its state said in words beside it. */
function SwitchField({
  label,
  checked,
  onChange,
  on,
  off,
  note,
  testId,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  on: string
  off: string
  note?: React.ReactNode
  testId?: string
}) {
  return (
    <Field label={label} layout="auto">
      <div className="flex items-center gap-4" data-testid={testId}>
        <Switch
          checked={checked}
          onCheckedChange={(next: boolean) => onChange(next)}
          aria-label={label}
        />
        <span className="text-[15px] text-foreground">{checked ? on : off}</span>
      </div>
      {note ? <Note>{note}</Note> : null}
    </Field>
  )
}

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
    <section className={className ?? "mt-16"}>
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

  // Read only, and read from the config route rather than the form: the
  // key is the deploy's, not an admin's, and the provider is a column this
  // screen never writes.
  const { data: config } = useVaultConfig()
  const pushKey = pushPublicKeyFrom(config) || settings.push?.vapid_public_key || ""
  const provider = settings.email_provider || "none"
  const providerLabel = EMAIL_PROVIDER_LABEL[provider] ?? provider

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
      <Section title="Buy-in defaults" className="mt-8">
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
        </div>
      </Section>

      {/* ---- Notifications ---- */}
      <Section title="Notifications">
        <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          How a quote offer, a want-list match and a receipt reach a customer.
          The mail key and the private push key are held on the server and are
          never sent to this browser.
        </p>
        <div className="flex flex-col gap-10">
          <Field label="Send email" layout="auto">
            <div className="flex items-center gap-4">
              <Switch
                checked={!form.email.test_mode}
                onCheckedChange={(checked: boolean) =>
                  set({ email: { ...form.email, test_mode: !checked } })
                }
                aria-label="Send email"
              />
              <span className="text-[15px] text-foreground">
                {form.email.test_mode ? "Test mode" : "Sending"}
              </span>
            </div>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              {form.email.test_mode
                ? `In test mode nothing is sent: every email is written to the server log instead. Provider: ${providerLabel}.`
                : `Email goes out through ${providerLabel}.`}
              {provider === "none"
                ? " Set a provider and its key on the server before turning this on."
                : ""}
            </p>
          </Field>

          <Field label="Push key" layout="auto">
            <p
              data-testid="vapid-key"
              className="tnum font-mono text-[13px] leading-[1.5] break-all text-foreground"
            >
              {pushKey || "Set at deploy"}
            </p>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              The public half of the push keypair, read only. The private half
              lives with the notify service and never reaches a browser.
            </p>
          </Field>

          <CountField
            id="hold-hours"
            label="Hold"
            hint="Hours"
            value={form.holdHours}
            onChange={(next) => set({ holdHours: next })}
            error={shown.holdHours}
            note="How long an item is held for a customer after a want-list match."
          />
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

      {/* ---- Customer display ---- */}
      <Section title="Customer display">
        <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
          The tablet facing the customer. With it on, the till mirrors the
          basket to it and the buy-in wizard can send an offer over for the
          customer to accept.
        </p>
        <div className="flex flex-col gap-10">
          <Field label="Display" layout="auto">
            <div className="flex items-center gap-4">
              <Switch
                checked={form.displayEnabled}
                onCheckedChange={(checked: boolean) => set({ displayEnabled: checked })}
                aria-label="Use the customer display"
              />
              <span className="text-[15px] text-foreground">
                {form.displayEnabled ? "On the counter" : "Not in use"}
              </span>
            </div>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              Open /display on the tablet, signed in as staff, and leave it there.
            </p>
          </Field>
          <TextField
            id="display-ticker"
            label="Ticker"
            maxLength={120}
            value={form.displayTicker}
            onChange={(next) => set({ displayTicker: next })}
            error={shown.displayTicker}
            note="The line that scrolls across the idle screen."
          />
          <TextField
            id="display-signup"
            label="Sign-up link"
            maxLength={300}
            value={form.displaySignupUrl}
            onChange={(next) => set({ displaySignupUrl: next })}
            error={shown.displaySignupUrl}
            note="Where the QR on the idle screen sends a phone."
          />
        </div>
      </Section>

      {/* ---- The till ---- */}
      <Section title="Till">
        <div className="flex flex-col gap-10">
          <Field label="Card payments" layout="auto">
            <p className="pt-2 text-[15px] leading-[1.5] text-foreground" data-testid="card-provider">
              Tide Card Reader, keyed by hand.
            </p>
            <Note>
              The till shows the amount, staff key it on the reader and confirm
              it was approved. Nothing is sent to the reader.
            </Note>
          </Field>
          <SwitchField
            label="Last four digits"
            checked={form.requireCardLast4}
            onChange={(checked) => set({ requireCardLast4: checked })}
            on="Asked for on every card"
            off="Not asked for"
            note="The card step asks for the last four digits off the reader's slip, so a payment can be found later."
          />
          <PercentField
            id="discount-limit"
            label="Discount limit"
            value={form.discountLimitPct}
            onChange={(next) => set({ discountLimitPct: next })}
            error={shown.discountLimitPct}
            note="A line or ticket discount above this needs somebody allowed to give one, or a manager's PIN."
          />
          <CountField
            id="auto-lock"
            label="Auto-lock"
            hint="Minutes"
            value={form.autoLockMinutes}
            onChange={(next) => set({ autoLockMinutes: next })}
            error={shown.autoLockMinutes}
            note="How long a registered till waits without a touch before it locks to the PIN screen. Zero leaves it to the Lock key."
          />
          <Field label="Quick cash" layout="auto">
            <ChipGroup
              multiple
              aria-label="Quick cash notes"
              value={form.quickCash.map(String)}
              onValueChange={(next: string[]) =>
                set({
                  quickCash: next
                    .map(Number)
                    .filter((pence) => Number.isInteger(pence) && pence > 0)
                    .sort((a, b) => a - b),
                })
              }
            >
              {[...new Set<number>([...QUICK_CASH_CHOICES, ...form.quickCash])]
                .sort((a, b) => a - b)
                .map((pence) => (
                  <Chip key={pence} value={String(pence)}>
                    {formatGBP(pence).replace(/\.00$/, "")}
                  </Chip>
                ))}
            </ChipGroup>
            {shown.quickCash ? (
              <p role="alert" className="mt-2 text-[13px] leading-[1.45] text-destructive">
                {shown.quickCash}
              </p>
            ) : null}
            <Note>The notes the cash step offers beside Exact, smallest first.</Note>
          </Field>
          <PoundsField
            id="default-float"
            label="Default float"
            value={form.defaultFloat}
            onChange={(next) => set({ defaultFloat: next })}
            error={shown.defaultFloat}
            note="What the till suggests when it opens, for a shop that starts each day on the same float."
          />
          <SwitchField
            label="Tide total at the Z"
            checked={form.zRequiresCardTotal}
            onChange={(checked) => set({ zRequiresCardTotal: checked })}
            on="Needed to close"
            off="Optional"
            note="The Z asks for the day's card total from the Tide app whenever the till took card, so the two can be compared."
          />
        </div>
      </Section>

      {/* ---- Permissions ---- */}
      <Section title="Permissions">
        <PermissionsTable
          value={form.permissions}
          onChange={(capability, role) =>
            set({ permissions: setPermission(form.permissions, capability, role) })
          }
        />
      </Section>

      {/* ---- Receipts ---- */}
      <Section title="Receipts">
        <div className="flex flex-col gap-10">
          <Field label="Header" htmlFor="receipt-header">
            <Textarea
              id="receipt-header"
              maxLength={RECEIPT_TEXT_MAX}
              placeholder="A line under the shop's name and address"
              trailingHint={`${form.receiptHeader.length} / ${RECEIPT_TEXT_MAX}`}
              value={form.receiptHeader}
              onChange={(event) => set({ receiptHeader: event.target.value })}
            />
          </Field>
          <Field label="Footer" htmlFor="receipt-footer">
            <Textarea
              id="receipt-footer"
              maxLength={RECEIPT_TEXT_MAX}
              placeholder="Thank you for shopping with GG Entertainment."
              trailingHint={`${form.receiptFooter.length} / ${RECEIPT_TEXT_MAX}`}
              value={form.receiptFooter}
              onChange={(event) => set({ receiptFooter: event.target.value })}
            />
          </Field>
          <Field label="Returns policy" htmlFor="receipt-returns">
            <Textarea
              id="receipt-returns"
              maxLength={RECEIPT_TEXT_MAX * 2}
              placeholder="What a customer can bring back, and for how long"
              trailingHint={`${form.returnsPolicy.length} / ${RECEIPT_TEXT_MAX * 2}`}
              value={form.returnsPolicy}
              onChange={(event) => set({ returnsPolicy: event.target.value })}
            />
          </Field>
          <SwitchField
            label="My Vault QR"
            checked={form.showPortalQr}
            onChange={(checked) => set({ showPortalQr: checked })}
            on="At the foot of every receipt"
            off="Left off"
            note="A QR code a customer scans to open My Vault and see their points."
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
          <TextField
            id="vat-number"
            label="VAT number"
            maxLength={20}
            value={form.vatNumber}
            onChange={(next) => set({ vatNumber: next })}
            error={shown.vatNumber}
            note="Printed on receipts while the shop is VAT registered."
          />
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

      {/* ---- Acting straight away, outside the Save ---- */}
      <TillsSection admin />
      <GuildSettingsSection />

      <section className="mt-24" aria-labelledby="printers-heading">
        <SectionHeading id="printers-heading">Printers</SectionHeading>
        <PrintersSection />
      </section>

      <CategoriesSection />
      <AgentsSection />

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

/**
 * A manager registers tills and keeps the category tree: those two
 * sections, and a line about the rest.
 */
function ManagerSettings() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Settings</PageTitle>
      <Lede>Tills and categories are yours to set up. The rest of Settings is for admins.</Lede>
      <TillsSection admin={false} />
      <CategoriesSection />
    </section>
  )
}

export function SettingsScreen() {
  const role = useStaffRole()
  const admin = role === "admin"

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

  if (!admin) return isManagerUp(role) ? <ManagerSettings /> : <AdminsOnly />

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
