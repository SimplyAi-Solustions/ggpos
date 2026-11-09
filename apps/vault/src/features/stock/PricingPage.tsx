import * as React from "react"
import { Check, Play, Plus, Save, Trash2, X } from "lucide-react"

import { cn } from "@/lib/cn"
import { useStaff } from "@/lib/auth"
import { Badge, Button, Card, Chip, Input, Money, MoneyInput, PageHeader, Panel, PercentStepper, Segmented, Skeleton, useToast } from "@/ui"

import {
  createProposals,
  decideProposals,
  deleteRule,
  errorText,
  saveRule,
  useInventory,
  useLookups,
  useProposals,
  useRules,
  useStockMutation,
  type Proposal,
} from "./api"
import { ROUNDING_OPTIONS } from "./pricing/bulk"
import { ItemThumb } from "./components/ItemThumb"
import { SelectField } from "./components/SelectField"
import { StockNav } from "./components/StockNav"
import { NEW_RULE, preview, splitForApply, type Outcome, type RuleRounding, type RuleStart, type SellRule } from "./pricing/rules"
import type { InventoryItem } from "./types"

const OUTCOMES: { key: Outcome; label: string; tone: "ok" | "warn" | "pop" | "neutral" }[] = [
  { key: "update", label: "Will update", tone: "ok" },
  { key: "limited", label: "Limited", tone: "warn" },
  { key: "approval", label: "Needs approval", tone: "pop" },
  { key: "skip", label: "Left alone", tone: "neutral" },
]

const KIND_OPTIONS = [
  { value: "single", label: "Singles" },
  { value: "graded", label: "Graded" },
  { value: "sealed", label: "Sealed" },
  { value: "retro", label: "Retro" },
  { value: "accessory", label: "Accessories" },
  { value: "other", label: "Other" },
]

export function PricingPage() {
  const toast = useToast()
  const staff = useStaff()
  const canDecide = staff?.role === "admin" || staff?.role === "manager"
  const inventory = useInventory()
  const lookups = useLookups()
  const rules = useRules()
  const proposals = useProposals()

  const [rule, setRule] = React.useState<SellRule>(NEW_RULE)
  const ctx = React.useMemo(
    () => ({ categoryPaths: Object.fromEntries((lookups.data?.categories ?? []).map((c) => [c.id, c.path || c.name])) }),
    [lookups.data]
  )
  const result = React.useMemo(() => preview(rule, inventory.data ?? [], ctx), [rule, inventory.data, ctx])
  const set = <K extends keyof SellRule>(key: K, value: SellRule[K]) => setRule((r) => ({ ...r, [key]: value }))

  const save = useStockMutation(() => saveRule(rule))
  const remove = useStockMutation((id: string) => deleteRule(id))
  const run = useStockMutation(async () => {
    const saved = rule.id ? rule : await saveRule(rule)
    const split = splitForApply(rule, result.results)
    const rows = (list: typeof split.apply) =>
      list.map((r) => ({ item: r.item.id, old_price: r.item.price, new_price: r.proposed ?? 0, reason: r.reason || "Rule price" }))
    const queued = await createProposals(saved.id, rows(split.queue))
    const auto = await createProposals(saved.id, rows(split.apply))
    if (auto.length) await decideProposals(auto, "approve")
    return { queued: queued.length, applied: auto.length, saved }
  })
  const decide = useStockMutation(({ ids, decision }: { ids: string[]; decision: "approve" | "reject" }) => decideProposals(ids, decision))

  return (
    <section className="pb-6">
      <PageHeader eyebrow="Inventory" title="Pricing">
        Rules that work out sticker prices from market or cost. Nothing changes until it is approved.
      </PageHeader>
      <StockNav />

      <ApprovalQueue
        proposals={proposals.data ?? []}
        loading={proposals.isPending}
        items={inventory.data ?? []}
        canDecide={canDecide}
        busy={decide.isPending}
        onDecide={(ids, decision) =>
          decide.mutate(
            { ids, decision },
            {
              onSuccess: (res) =>
                toast({
                  message: decision === "approve" ? `${res.approved} ${res.approved === 1 ? "price" : "prices"} changed.` : `${res.rejected} rejected.`,
                  tone: "ok",
                }),
              onError: (error) => toast({ message: errorText(error, "Nothing was changed. Try again."), tone: "alert" }),
            }
          )
        }
      />

      <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        <div className="flex w-max gap-2">
          <Chip selected={!rule.id} icon={<Plus aria-hidden />} onClick={() => setRule(NEW_RULE)}>
            New rule
          </Chip>
          {(rules.data ?? []).map((r) => (
            <Chip key={r.id} selected={rule.id === r.id} onClick={() => setRule({ ...NEW_RULE, ...r })}>
              {r.name}
              {!r.active && <span className="text-fg-3">(off)</span>}
            </Chip>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.05fr_1fr]">
        <Card className="flex flex-col gap-5">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Input label="Rule name" value={rule.name} onChange={(e) => set("name", e.target.value)} />
            <Toggle label="On" checked={rule.active} onChange={(v) => set("active", v)} />
          </div>

          <Group title="Match">
            <Segmented
              label="Which stock"
              size="sm"
              block
              value={rule.match}
              onChange={(v) => set("match", v)}
              options={[
                { value: "all", label: "All" },
                { value: "category", label: "Category" },
                { value: "game", label: "Game" },
                { value: "kind", label: "Type" },
              ]}
            />
            {rule.match === "category" && (
              <SelectField
                aria-label="Category"
                value={rule.match_category}
                onChange={(v) => set("match_category", v)}
                placeholder="Choose a branch"
                options={(lookups.data?.categories ?? []).map((c) => ({ value: c.id, label: c.path || c.name }))}
              />
            )}
            {rule.match === "game" && (
              <SelectField
                aria-label="Game"
                value={rule.match_game}
                onChange={(v) => set("match_game", v)}
                placeholder="Choose a game"
                options={(lookups.data?.games ?? []).map((g) => ({ value: g.id, label: g.name }))}
              />
            )}
            {rule.match === "kind" && (
              <SelectField aria-label="Type" value={rule.match_kind} onChange={(v) => set("match_kind", v)} placeholder="Choose a type" options={KIND_OPTIONS} />
            )}
          </Group>

          <Group title="Price">
            <Segmented
              label="Start from"
              size="sm"
              block
              value={rule.start}
              onChange={(v: RuleStart) => setRule((r) => ({ ...r, start: v, start_value: v === "market_pct" ? 100 : v === "cost_markup" ? 50 : 100 }))}
              options={[
                { value: "market_pct", label: "Market %" },
                { value: "cost_markup", label: "Cost +" },
                { value: "fixed", label: "Fixed" },
              ]}
            />
            {rule.start === "fixed" ? (
              <MoneyInput label="Fixed price" value={rule.start_value} onChange={(v) => set("start_value", v ?? 0)} />
            ) : (
              <PercentStepper
                label={rule.start === "market_pct" ? "Percent of market" : "Markup on cost"}
                value={rule.start_value}
                onChange={(v) => set("start_value", v)}
                min={rule.start === "market_pct" ? 10 : 0}
                max={rule.start === "market_pct" ? 300 : 500}
              />
            )}
            <PercentStepper label="Then adjust by" value={rule.adjust_pct} onChange={(v) => set("adjust_pct", v)} min={-50} max={100} tone="pop" />
            <div className="grid grid-cols-2 gap-3">
              <SelectField label="Rounding" value={rule.rounding} onChange={(v) => set("rounding", v as RuleRounding)} options={ROUNDING_OPTIONS.map((o) => (o.value === "round_to" ? { ...o, label: "Round to" } : o))} />
              {rule.rounding === "round_to" && (
                <SelectField
                  label="Nearest"
                  value={String(rule.round_step || 50)}
                  onChange={(v) => set("round_step", Number(v))}
                  options={[
                    { value: "25", label: "25p" },
                    { value: "50", label: "50p" },
                    { value: "100", label: "£1" },
                  ]}
                />
              )}
            </div>
          </Group>

          <Group title="Safety checks">
            <Toggle label="Never below cost" checked={rule.never_below_cost} onChange={(v) => set("never_below_cost", v)} wide />
            <Toggle label="Protect hand-stickered items" checked={rule.protect_hand} onChange={(v) => set("protect_hand", v)} wide />
            <PercentStepper
              label={rule.max_change_pct ? "Bigger changes wait for approval" : "No limit on the change"}
              value={rule.max_change_pct}
              onChange={(v) => set("max_change_pct", v)}
              min={0}
              max={100}
            />
          </Group>

          <Group title="Approval">
            <Segmented
              label="Approval"
              size="sm"
              block
              value={rule.approval}
              onChange={(v) => set("approval", v)}
              options={[
                { value: "ask", label: "Ask me first" },
                { value: "auto", label: "Automatic" },
              ]}
            />
            <p className="text-sm text-fg-3">
              {rule.approval === "ask"
                ? "Every change goes to the approval queue."
                : "Changes inside the limits go straight on. Bigger ones wait for approval."}
            </p>
          </Group>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              block
              icon={<Save className="size-4" aria-hidden />}
              loading={save.isPending}
              disabled={!rule.name.trim() || !canDecide}
              onClick={() =>
                save.mutate(undefined, {
                  onSuccess: (saved) => {
                    setRule({ ...NEW_RULE, ...saved })
                    toast({ message: "Rule saved.", tone: "ok" })
                  },
                  onError: (error) => toast({ message: errorText(error, "Not saved. Try again."), tone: "alert" }),
                })
              }
            >
              Save rule
            </Button>
            {rule.id && (
              <Button
                variant="ghost"
                aria-label="Delete rule"
                icon={<Trash2 className="size-4" aria-hidden />}
                disabled={!canDecide}
                onClick={() =>
                  remove.mutate(rule.id ?? "", {
                    onSuccess: () => {
                      setRule(NEW_RULE)
                      toast("Rule deleted.")
                    },
                  })
                }
              />
            )}
          </div>
          {!canDecide && <p className="-mt-3 text-sm text-fg-3">Only an admin or a manager can save rules and approve prices.</p>}
        </Card>

        <div className="flex flex-col gap-4 md:sticky md:top-20 md:h-fit">
          <Card accent="volt">
            <p className="label-mono mb-3 text-fg-2">Live preview</p>
            {inventory.isPending ? (
              <Skeleton lines={3} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {OUTCOMES.map((o) => (
                    <div key={o.key} className="rounded-md border border-line bg-panel-2 p-3">
                      <p className="label-mono text-[10px] text-fg-3">{o.label}</p>
                      <p
                        className={cn(
                          "font-mono text-2xl font-bold tnum",
                          o.tone === "ok" && "text-ok",
                          o.tone === "warn" && "text-warn",
                          o.tone === "pop" && "text-pop-text"
                        )}
                      >
                        {result.counts[o.key]}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
                  <span className="text-sm text-fg-2">
                    Total change, {result.matched} {result.matched === 1 ? "line" : "lines"} matched
                  </span>
                  <Money pence={result.totalChange} tween tone={result.totalChange < 0 ? "pop" : "ok"} className="text-lg font-bold" />
                </div>
              </>
            )}
            <Button
              size="lg"
              block
              className="mt-4"
              icon={<Play className="size-5" aria-hidden />}
              loading={run.isPending}
              disabled={!canDecide || result.counts.update + result.counts.limited + result.counts.approval === 0}
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (res) => {
                    setRule({ ...NEW_RULE, ...res.saved })
                    toast({
                      message:
                        res.applied > 0
                          ? `${res.applied} changed, ${res.queued} waiting for approval.`
                          : `${res.queued} ${res.queued === 1 ? "change" : "changes"} waiting for approval.`,
                      tone: "ok",
                    })
                  },
                  onError: (error) => toast({ message: errorText(error, "The rule did not run. Try again."), tone: "alert" }),
                })
              }
            >
              {rule.approval === "ask" ? "Send to approval" : "Run rule"}
            </Button>
          </Card>

          <Panel flush className="overflow-hidden">
            <ul className="divide-y divide-line">
              {result.results.filter((r) => r.proposed !== null).slice(0, 8).map((r) => (
                <li key={r.item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <ItemThumb item={r.item} className="w-8" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{r.item.title}</p>
                    <p className="text-xs text-fg-3">
                      {OUTCOMES.find((o) => o.key === r.outcome)?.label}
                      {r.reason && `, ${r.reason.toLowerCase()}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <Money pence={r.proposed ?? 0} size="sm" className="font-bold" />
                    <Money pence={r.item.price} className="text-xs text-fg-3 line-through" />
                  </div>
                </li>
              ))}
              {result.results.every((r) => r.proposed === null) && (
                <li className="px-4 py-6 text-center text-sm text-fg-3">No price would change under this rule.</li>
              )}
            </ul>
          </Panel>
        </div>
      </div>
    </section>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="label-mono mb-2.5 text-pop-text">{title}</legend>
      {children}
    </fieldset>
  )
}

function Toggle({ label, checked, onChange, wide }: { label: string; checked: boolean; onChange: (v: boolean) => void; wide?: boolean }) {
  return (
    <label className={cn("flex min-h-12 cursor-pointer items-center gap-3", wide && "justify-between rounded-md border border-line bg-panel-2 px-3.5")}>
      <span className={cn("text-[15px]", !wide && "label-mono text-fg-2")}>{label}</span>
      <span className="relative inline-flex">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-7 w-12 rounded-full border border-line-2 bg-line transition-colors peer-checked:border-transparent peer-checked:bg-volt peer-focus-visible:outline-2 peer-focus-visible:outline-volt" />
        <span className="absolute top-1 left-1 size-5 rounded-full bg-paper shadow transition-transform peer-checked:translate-x-5 peer-checked:bg-ink" />
      </span>
    </label>
  )
}

function ApprovalQueue({
  proposals,
  loading,
  items,
  canDecide,
  busy,
  onDecide,
}: {
  proposals: Proposal[]
  loading: boolean
  items: InventoryItem[]
  canDecide: boolean
  busy: boolean
  onDecide: (ids: string[], decision: "approve" | "reject") => void
}) {
  const byId = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const [picked, setPicked] = React.useState<Set<string>>(new Set())
  if (loading) return <Skeleton className="mb-4 h-24 rounded-lg" />
  if (proposals.length === 0)
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-dashed border-line-2 px-4 py-3">
        <Check className="size-5 shrink-0 text-ok" aria-hidden />
        <p className="text-sm text-fg-2">
          <span className="font-semibold text-fg">Approval queue is clear.</span> Changes from a rule wait here for Approve or Reject.
        </p>
      </div>
    )
  const ids = picked.size ? [...picked] : proposals.map((p) => p.id)
  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <Card accent="pop" className="mb-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="label-mono text-fg-2">Approval queue</p>
        <Badge tone="pop" dot>
          {proposals.length} waiting
        </Badge>
      </div>
      <ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
        {proposals.map((p) => {
          const item = byId.get(p.item)
          const on = picked.has(p.id)
          return (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(p.id)}
                className={cn("flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-line/50", on && "bg-volt/15")}
              >
                {item && <ItemThumb item={item} className="w-8" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{item?.title ?? "Item no longer in stock"}</span>
                  <span className="block truncate text-xs text-fg-3">
                    {p.expand?.rule?.name ?? "Rule"}
                    {p.reason && `, ${p.reason.toLowerCase()}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  <Money pence={p.old_price} size="sm" tone="muted" />
                  <span className="text-xs text-fg-3">to</span>
                  <Money pence={p.new_price} size="sm" className="font-bold" />
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          icon={<X className="size-4" aria-hidden />}
          disabled={!canDecide || busy}
          onClick={() => {
            onDecide(ids, "reject")
            setPicked(new Set())
          }}
        >
          Reject {picked.size ? picked.size : "all"}
        </Button>
        <Button
          icon={<Check className="size-4" aria-hidden />}
          loading={busy}
          disabled={!canDecide}
          onClick={() => {
            onDecide(ids, "approve")
            setPicked(new Set())
          }}
        >
          Approve {picked.size ? picked.size : "all"}
        </Button>
      </div>
    </Card>
  )
}
