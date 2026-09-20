/**
 * Loyalty: the GG Guild as the owner shapes it.
 *
 * Admin only. The programme, its rules and its tiers are edited here and
 * saved together with the screen's one block button, which is what lets the
 * live preview answer for rules that have not been written yet: an admin
 * sees what a change pays before it reaches a till.
 *
 * Rewards carry a picture, and memberships, adjustments and the stats are
 * routes rather than collection writes, so each of those saves on its own.
 * Nothing on this page is a card: sections are whitespace and a tracked
 * heading, the same as Settings.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Field } from "@/components/ui/field"
import { useCounterDock } from "@/app/counter-dock"
import { useStaff } from "@/lib/auth"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listGames } from "@/lib/api"
import { CountField, TextField } from "@/features/settings/fields"
import { AdjustSheet } from "@/features/loyalty/AdjustSheet"
import { MembershipsSection } from "@/features/loyalty/MembershipsSection"
import { PreviewPanel } from "@/features/loyalty/PreviewPanel"
import { RewardsSection } from "@/features/loyalty/RewardsSection"
import { RulesSection } from "@/features/loyalty/RulesSection"
import { StatsSection } from "@/features/loyalty/StatsSection"
import { TiersSection } from "@/features/loyalty/TiersSection"
import { EMPTY_PREVIEW, type PreviewInput } from "@/features/loyalty/preview"
import {
  formToEvaluatorRule,
  formToEvaluatorTier,
  formToProgramme,
  formToReward,
  formToRule,
  formToTier,
  programmeToForm,
  ruleToForm,
  tierToForm,
  validateProgramme,
  type ProgrammeForm,
  type MembershipForm,
  type RewardForm,
  type RuleForm,
  type TierForm,
} from "@/features/loyalty/mapping"
import { poundsToPence, parseCount } from "@/features/settings/mapping"
import {
  cancelMembership,
  getLoyaltyAdmin,
  listMemberships,
  recordMembership,
  renewMembership,
  saveProgramme,
  saveReward,
  saveRules,
  saveTiers,
  type LoyaltyAdmin,
} from "@/lib/api/loyalty"
import type { GameRecord, LoyaltyProgramme } from "@/lib/api/types"

/** The same treatment the Sell and Settings screens give a blocked block button. */
const BLOCKED = "disabled:opacity-100 disabled:bg-surface-3 disabled:text-muted-foreground"

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
      <SectionHeading className="mt-0">{title}</SectionHeading>
      {children}
    </section>
  )
}

/** The programme in the shared evaluator's shape, for the live preview. */
function programmeForPreview(form: ProgrammeForm): LoyaltyProgramme {
  return {
    enabled: form.enabled,
    earnPerPoundSales: parseCount(form.earnPerPoundSales) ?? 0,
    earnPerPoundTradeInCredit: parseCount(form.earnOnTradeInCredit) ?? 0,
    pointsPerPoundRedemption: parseCount(form.pointsPerPoundRedemption) ?? 100,
    minRedeemPoints: parseCount(form.minRedeemPoints) ?? 0,
    maxPointsShareOfSale: parseCount(form.maxPointsShareOfSale) ?? 0,
    expiryMonthsInactive: parseCount(form.expiryMonthsInactive) ?? 0,
    tierWindowMonths: parseCount(form.tierWindowMonths) ?? 0,
    welcomeBonus: parseCount(form.welcomeBonus) ?? 0,
    referralBonusReferrer: parseCount(form.referralBonusReferrer) ?? 0,
    referralBonusReferee: parseCount(form.referralBonusReferee) ?? 0,
  }
}

function Editor({ admin, games }: { admin: LoyaltyAdmin; games: GameRecord[] }) {
  const dock = useCounterDock()
  const queryClient = useQueryClient()

  const [programme, setProgramme] = React.useState<ProgrammeForm>(() =>
    programmeToForm(admin.programme)
  )
  const [baseline, setBaseline] = React.useState<ProgrammeForm>(() =>
    programmeToForm(admin.programme)
  )
  const [rules, setRules] = React.useState<RuleForm[]>(() =>
    admin.rules.map((rule, index) => ruleToForm(rule, index))
  )
  const [ruleBaseline, setRuleBaseline] = React.useState<RuleForm[]>(() =>
    admin.rules.map((rule, index) => ruleToForm(rule, index))
  )
  const [tiers, setTiers] = React.useState<TierForm[]>(() =>
    admin.tiers.map((tier, index) => tierToForm(tier, index))
  )
  const [tierBaseline, setTierBaseline] = React.useState<TierForm[]>(() =>
    admin.tiers.map((tier, index) => tierToForm(tier, index))
  )
  const [rewards, setRewards] = React.useState(admin.rewards)
  const [preview, setPreview] = React.useState<PreviewInput>(EMPTY_PREVIEW)
  const [showErrors, setShowErrors] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [rewardError, setRewardError] = React.useState<string | null>(null)
  const [planError, setPlanError] = React.useState<string | null>(null)
  const [adjustOpen, setAdjustOpen] = React.useState(false)
  const [adjustNote, setAdjustNote] = React.useState<string | null>(null)

  const { data: memberships = [] } = useQuery({
    queryKey: ["memberships", "all"],
    queryFn: () => listMemberships("all"),
    staleTime: 30_000,
  })

  const changedRules = rules.filter((rule) => {
    const original = ruleBaseline.find((row) => row.key === rule.key)
    return !original || JSON.stringify(original) !== JSON.stringify(rule)
  })
  const changedTiers = tiers.filter((tier) => {
    const original = tierBaseline.find((row) => row.key === tier.key)
    return !original || JSON.stringify(original) !== JSON.stringify(tier)
  })
  const dirty =
    JSON.stringify(programme) !== JSON.stringify(baseline) ||
    changedRules.length > 0 ||
    changedTiers.length > 0

  const errors = validateProgramme(programme)
  const shown = showErrors ? errors : {}
  const errorCount = Object.keys(errors).length

  function set(patch: Partial<ProgrammeForm>) {
    setSaved(false)
    setProgramme((current) => ({ ...current, ...patch }))
  }

  const save = useMutation({
    mutationFn: async () => {
      const record = await saveProgramme(programme.id, formToProgramme(programme))
      const written = {
        rules: changedRules.length
          ? await saveRules(changedRules.map(formToRule))
          : null,
        tiers: changedTiers.length
          ? await saveTiers(changedTiers.map(formToTier))
          : null,
      }
      return { record, ...written }
    },
    onMutate: () => setError(null),
    onSuccess: ({ record, rules: writtenRules, tiers: writtenTiers }) => {
      const nextProgramme = programmeToForm(record)
      setProgramme(nextProgramme)
      setBaseline(nextProgramme)
      if (writtenRules) {
        const next = writtenRules.map((rule, index) => ruleToForm(rule, index))
        setRules(next)
        setRuleBaseline(next)
      }
      if (writtenTiers) {
        const next = writtenTiers.map((tier, index) => tierToForm(tier, index))
        setTiers(next)
        setTierBaseline(next)
      }
      setSaved(true)
      // Every counter screen prices points through GET /api/vault/config, so
      // the change reaches the till on the next read rather than the next
      // sign-in.
      for (const key of [["vault-config"], ["counter-config"], ["loyalty-admin"]]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
    onError: (problem) =>
      setError(refusalOrFallback(problem, "That did not save. Try it again.")),
  })

  const writeReward = useMutation({
    mutationFn: (form: RewardForm) => saveReward(formToReward(form)),
    onSuccess: (record) => {
      setRewardError(null)
      setRewards((current) => {
        const index = current.findIndex((row) => row.id === record.id)
        if (index < 0) return [...current, record]
        return current.map((row) => (row.id === record.id ? record : row))
      })
      void queryClient.invalidateQueries({ queryKey: ["loyalty-admin"] })
    },
    onError: (problem) =>
      setRewardError(
        refusalOrFallback(problem, "That reward did not save. Try it again.")
      ),
  })

  const settleMemberships = () => {
    void queryClient.invalidateQueries({ queryKey: ["memberships"] })
    void queryClient.invalidateQueries({ queryKey: ["customer"] })
    void queryClient.invalidateQueries({ queryKey: ["customer-guild"] })
  }

  const plan = useMutation({
    mutationFn: (form: MembershipForm) =>
      recordMembership({
        customer: form.customer,
        tier: form.tier,
        months: parseCount(form.months) ?? 12,
        price: poundsToPence(form.price) ?? 0,
        payment_note: form.note.trim() || undefined,
      }),
    onSuccess: () => {
      setPlanError(null)
      settleMemberships()
    },
    onError: (problem) =>
      setPlanError(refusalOrFallback(problem, "That plan was not recorded.")),
  })

  const renew = useMutation({
    mutationFn: ({ id, form }: { id: string; form: MembershipForm }) =>
      renewMembership(id, {
        months: parseCount(form.months) ?? 12,
        price: poundsToPence(form.price) ?? 0,
        payment_note: form.note.trim() || undefined,
      }),
    onSuccess: () => {
      setPlanError(null)
      settleMemberships()
    },
    onError: (problem) =>
      setPlanError(refusalOrFallback(problem, "That renewal did not go through.")),
  })

  const stop = useMutation({
    mutationFn: (id: string) => cancelMembership(id),
    onSuccess: () => {
      setPlanError(null)
      settleMemberships()
    },
    onError: (problem) =>
      setPlanError(refusalOrFallback(problem, "That plan was not cancelled.")),
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

  const primary = (
    <Button
      className={`w-full min-[900px]:w-auto ${BLOCKED}`}
      trailingArrow
      loading={save.isPending}
      disabled={!dirty || save.isPending}
      onClick={submit}
    >
      Save programme
    </Button>
  )

  const previewProgramme = programmeForPreview(programme)
  const previewRules = rules.map(formToEvaluatorRule)
  const previewTiers = tiers.map(formToEvaluatorTier)

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Loyalty</PageTitle>
      <Lede>The GG Guild: what a sale earns, what a tier gives, what points buy.</Lede>

      {/* ---- Programme ---- */}
      <Section title="Programme" className="mt-8">
        <div className="flex flex-col gap-10">
          <Field label="Running" layout="auto">
            <div className="flex items-center gap-4">
              <Switch
                checked={programme.enabled}
                onCheckedChange={(next: boolean) => set({ enabled: next })}
                aria-label="The loyalty programme is running"
              />
              <span className="text-[15px] text-foreground">
                {programme.enabled ? "Earning and redeeming" : "Switched off"}
              </span>
            </div>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              With it off, no sale earns and no reward can be redeemed. Balances
              stay where they are.
            </p>
          </Field>

          <TextField
            id="programme-name"
            label="Name"
            maxLength={100}
            value={programme.name}
            onChange={(next) => set({ name: next })}
            error={shown.name}
          />
          <TextField
            id="points-name"
            label="Points called"
            maxLength={100}
            value={programme.pointsName}
            onChange={(next) => set({ pointsName: next })}
            error={shown.pointsName}
            note="What the customer sees on their card and in My Vault."
          />
          <CountField
            id="earn-sales"
            label="Earn on sales"
            hint="per £1"
            value={programme.earnPerPoundSales}
            onChange={(next) => set({ earnPerPoundSales: next })}
            error={shown.earnPerPoundSales}
          />
          <CountField
            id="earn-credit"
            label="Earn on credit"
            hint="per £1"
            value={programme.earnOnTradeInCredit}
            onChange={(next) => set({ earnOnTradeInCredit: next })}
            error={shown.earnOnTradeInCredit}
            note="Points for taking a buy-in as store credit rather than cash."
          />
          <CountField
            id="redemption-rate"
            label="Points to £1"
            hint="points"
            value={programme.pointsPerPoundRedemption}
            onChange={(next) => set({ pointsPerPoundRedemption: next })}
            error={shown.pointsPerPoundRedemption}
            note="What a pound off a sale costs in points."
          />
          <CountField
            id="min-redeem"
            label="Least redeemable"
            hint="points"
            value={programme.minRedeemPoints}
            onChange={(next) => set({ minRedeemPoints: next })}
            error={shown.minRedeemPoints}
          />
          <CountField
            id="max-share"
            label="Most of a sale"
            hint="%"
            value={programme.maxPointsShareOfSale}
            onChange={(next) => set({ maxPointsShareOfSale: next })}
            error={shown.maxPointsShareOfSale}
            note="The share of one sale that points may cover."
          />
          <CountField
            id="expiry-months"
            label="Points expire after"
            hint="months"
            value={programme.expiryMonthsInactive}
            onChange={(next) => set({ expiryMonthsInactive: next })}
            error={shown.expiryMonthsInactive}
            note="Months without a purchase before a balance goes. Zero never expires."
          />
          <CountField
            id="tier-window"
            label="Tier window"
            hint="months"
            value={programme.tierWindowMonths}
            onChange={(next) => set({ tierWindowMonths: next })}
            error={shown.tierWindowMonths}
            note="The rolling window a tier is worked out over. Zero counts all time."
          />
          <CountField
            id="welcome-bonus"
            label="Welcome bonus"
            hint="points"
            value={programme.welcomeBonus}
            onChange={(next) => set({ welcomeBonus: next })}
            error={shown.welcomeBonus}
          />
          <CountField
            id="referral-referrer"
            label="Referrer earns"
            hint="points"
            value={programme.referralBonusReferrer}
            onChange={(next) => set({ referralBonusReferrer: next })}
            error={shown.referralBonusReferrer}
          />
          <CountField
            id="referral-referee"
            label="Referee earns"
            hint="points"
            value={programme.referralBonusReferee}
            onChange={(next) => set({ referralBonusReferee: next })}
            error={shown.referralBonusReferee}
            note="Both are paid when the referred customer's first sale or buy-in lands."
          />
          <Field label="Terms" htmlFor="programme-terms">
            <Textarea
              id="programme-terms"
              maxLength={4000}
              placeholder="What a member is agreeing to"
              trailingHint={`${programme.terms.length} / 4000`}
              value={programme.terms}
              onChange={(event) => set({ terms: event.target.value })}
            />
            <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              Shown in My Vault and on the sign-up card.
            </p>
          </Field>
        </div>
      </Section>

      {/* ---- Rules, with the live preview above them ---- */}
      <Section title="Rules">
        <RulesSection
          rules={rules}
          games={games}
          onSave={(rule) => {
            setSaved(false)
            setRules((current) =>
              current.some((row) => row.key === rule.key)
                ? current.map((row) => (row.key === rule.key ? rule : row))
                : [...current, rule]
            )
          }}
        >
          <PreviewPanel
            input={preview}
            onChange={(patch) => setPreview((current) => ({ ...current, ...patch }))}
            programme={previewProgramme}
            rules={previewRules}
            tiers={previewTiers}
            games={games}
          />
        </RulesSection>
      </Section>

      {/* ---- Tiers ---- */}
      <Section title="Tiers and perks">
        <TiersSection
          tiers={tiers}
          onSave={(tier) => {
            setSaved(false)
            setTiers((current) =>
              current.some((row) => row.key === tier.key)
                ? current.map((row) => (row.key === tier.key ? tier : row))
                : [...current, tier]
            )
          }}
        />
      </Section>

      {/* ---- Rewards ---- */}
      <Section title="Rewards">
        <RewardsSection
          rewards={rewards}
          saving={writeReward.isPending}
          error={rewardError}
          onDismissError={() => setRewardError(null)}
          onSave={(form) => writeReward.mutateAsync(form)}
        />
      </Section>

      {/* ---- Memberships ---- */}
      <Section title="Memberships">
        <MembershipsSection
          memberships={memberships}
          tiers={admin.tiers}
          busy={plan.isPending || renew.isPending || stop.isPending}
          error={planError}
          onDismissError={() => setPlanError(null)}
          onRecord={(form) => plan.mutateAsync(form)}
          onRenew={(id, form) => renew.mutateAsync({ id, form })}
          onCancel={(id) => stop.mutateAsync(id)}
        />
      </Section>

      {/* ---- Adjustments ---- */}
      <Section title="Adjustments">
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
          Points added or taken away by hand. It asks for your password, and the
          reason is written onto the customer's record.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-8">
          <Button variant="text" type="button" onClick={() => setAdjustOpen(true)}>
            Adjust points
          </Button>
          {adjustNote ? (
            <p aria-live="polite" className="text-[13px] text-muted-foreground">
              {adjustNote}
            </p>
          ) : null}
        </div>
      </Section>

      {/* ---- Stats ---- */}
      <Section title="The last 30 days">
        <StatsSection programme={previewProgramme} />
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
              <Badge variant="outline" data-testid="loyalty-dirty">
                Unsaved changes
              </Badge>
              <Button
                variant="text"
                onClick={() => {
                  setProgramme(baseline)
                  setRules(ruleBaseline)
                  setTiers(tierBaseline)
                  setShowErrors(false)
                  setError(null)
                }}
              >
                Discard
              </Button>
            </>
          ) : null}
          {saved ? (
            <span
              data-testid="loyalty-saved"
              aria-live="polite"
              className="text-[13px] text-muted-foreground"
            >
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

      <AdjustSheet
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onDone={({ balance }) => {
          setAdjustNote(
            `Adjusted. They now hold ${balance.toLocaleString("en-GB")} points.`
          )
          void queryClient.invalidateQueries({ queryKey: ["customer"] })
          void queryClient.invalidateQueries({ queryKey: ["customer-guild"] })
        }}
      />
    </section>
  )
}

/** Everything on this screen is an admin decision, so staff get one line. */
function AdminsOnly() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Loyalty</PageTitle>
      <Lede>
        The Guild is set up by an admin. Ask Richard if something needs changing.
      </Lede>
      <div className="mt-10">
        <Button variant="text" render={<Link to="/counter/customers" />}>
          Back to customers
        </Button>
      </div>
    </section>
  )
}

export function LoyaltyScreen() {
  const staff = useStaff()
  const isAdmin = staff?.role === "admin"

  const admin = useQuery({
    queryKey: ["loyalty-admin"],
    queryFn: getLoyaltyAdmin,
    enabled: isAdmin,
    staleTime: 60_000,
  })
  const games = useQuery({
    queryKey: ["games"],
    queryFn: listGames,
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  })

  if (!isAdmin) return <AdminsOnly />

  if (admin.error || games.error) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Loyalty</PageTitle>
        <Lede>
          {refusalOrFallback(
            admin.error ?? games.error,
            "The programme would not load. Check the connection and try again."
          )}
        </Lede>
      </section>
    )
  }

  if (!admin.data || !games.data) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>Loyalty</PageTitle>
        <Lede>The GG Guild: what a sale earns, what a tier gives, what points buy.</Lede>
        <p className="mt-14 text-[15px] text-muted-foreground-2">
          Loading the programme.
        </p>
      </section>
    )
  }

  return <Editor key={admin.data.programme.id} admin={admin.data} games={games.data} />
}
