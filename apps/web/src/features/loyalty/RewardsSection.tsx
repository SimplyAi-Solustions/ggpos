/**
 * The rewards catalogue: what points buy, with the picture the customer sees
 * in My Vault.
 *
 * A reward carries a file, so its sheet writes on its own rather than
 * waiting for the page's block button: an image upload is a multipart write
 * and half of one is worse than none. Every other section on this screen is
 * saved together.
 */
import * as React from "react"
import { formatGBP } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { ProductImage } from "@/components/product-image"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { MoneyInput } from "@/features/sell/money-input"
import {
  REWARD_TYPES,
  REWARD_TYPE_LABEL,
  emptyReward,
  rewardToForm,
  rewardValueIsMoney,
  validateReward,
  type RewardForm,
} from "@/features/loyalty/mapping"
import type { LoyaltyRewardRecord, RewardType } from "@/lib/api/types"

const DESCRIPTION_MAX = 500

/**
 * A preview URL for a picked file, revoked when it changes or the sheet
 * closes. Built in an effect rather than during render, so a re-render does
 * not leak a new blob URL every keystroke.
 */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!file) {
      setUrl(null)
      return undefined
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}

/** What a reward is worth, in the right units for its type. */
export function rewardWorth(reward: LoyaltyRewardRecord): string {
  if (reward.type === "money_off") return `${formatGBP(reward.value ?? 0)} off`
  if (reward.type === "store_credit") return `${formatGBP(reward.value ?? 0)} credit`
  if (reward.type === "event_entry") return "One entry"
  if (reward.type === "free_item") return "One item"
  return "Custom"
}

/** "20 left, 1 each" or "No limit", the grey line on a row. */
export function rewardLimits(reward: LoyaltyRewardRecord): string {
  const parts: string[] = []
  if (reward.stock_limit) parts.push(`${reward.stock_limit} in total`)
  if (reward.per_customer_limit) parts.push(`${reward.per_customer_limit} each`)
  if (parts.length === 0) parts.push("No limit")
  if (reward.starts_at) parts.push(`from ${reward.starts_at.slice(0, 10)}`)
  if (reward.ends_at) parts.push(`to ${reward.ends_at.slice(0, 10)}`)
  return parts.join(" · ")
}

function RewardFormBody({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: RewardForm
  onChange: (patch: Partial<RewardForm>) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  error: string | null
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const preview = useObjectUrl(draft.image)
  const [showErrors, setShowErrors] = React.useState(false)
  const errors = validateReward(draft)
  const shown = showErrors ? errors : {}
  const money = rewardValueIsMoney(draft.type)

  return (
    <>
      <SheetBody>
        <div className="flex flex-col gap-8">
          <Field label="Name" htmlFor="reward-name" layout="stacked" error={shown.name}>
            <Input
              id="reward-name"
              autoComplete="off"
              placeholder="£5 off a single"
              value={draft.name}
              aria-invalid={Boolean(shown.name) || undefined}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>

          <Field label="Description" htmlFor="reward-description" layout="stacked">
            <Textarea
              id="reward-description"
              maxLength={DESCRIPTION_MAX}
              placeholder="What the customer gets"
              trailingHint={`${draft.description.length} / ${DESCRIPTION_MAX}`}
              value={draft.description}
              onChange={(event) => onChange({ description: event.target.value })}
            />
          </Field>

          <Field label="Type" layout="stacked">
            <Select
              value={draft.type}
              onValueChange={(next: string | null) =>
                onChange({ type: (next as RewardType) ?? draft.type })
              }
            >
              <SelectTrigger aria-label="What kind of reward this is">
                <SelectValue>
                  {(value: string) => REWARD_TYPE_LABEL[value as RewardType] ?? value}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {REWARD_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {REWARD_TYPE_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="Costs"
            htmlFor="reward-cost"
            layout="stacked"
            error={shown.costPoints}
          >
            <Input
              id="reward-cost"
              className="tnum"
              inputMode="numeric"
              autoComplete="off"
              maxLength={7}
              trailingHint="points"
              value={draft.costPoints}
              aria-invalid={Boolean(shown.costPoints) || undefined}
              onChange={(event) => onChange({ costPoints: event.target.value })}
            />
          </Field>

          <Field label="Worth" htmlFor="reward-value" layout="stacked" error={shown.value}>
            {money ? (
              <MoneyInput
                id="reward-value"
                value={draft.value}
                invalid={Boolean(shown.value)}
                onChange={(next) => onChange({ value: next })}
              />
            ) : (
              <Input
                id="reward-value"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                value={draft.value}
                aria-invalid={Boolean(shown.value) || undefined}
                onChange={(event) => onChange({ value: event.target.value })}
              />
            )}
            <p className="mt-2 max-w-[48ch] text-[13px] leading-[1.45] text-muted-foreground-2">
              {money
                ? "What comes off the sale, or goes on the account."
                : "A count, for example one entry. Zero when nothing is counted."}
            </p>
          </Field>

          <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
            <Field
              label="In total"
              htmlFor="reward-stock"
              layout="stacked"
              error={shown.stockLimit}
            >
              <Input
                id="reward-stock"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="No limit"
                value={draft.stockLimit}
                aria-invalid={Boolean(shown.stockLimit) || undefined}
                onChange={(event) => onChange({ stockLimit: event.target.value })}
              />
            </Field>
            <Field
              label="Each"
              htmlFor="reward-per-customer"
              layout="stacked"
              error={shown.perCustomerLimit}
            >
              <Input
                id="reward-per-customer"
                className="tnum"
                inputMode="numeric"
                autoComplete="off"
                maxLength={5}
                placeholder="No limit"
                value={draft.perCustomerLimit}
                aria-invalid={Boolean(shown.perCustomerLimit) || undefined}
                onChange={(event) => onChange({ perCustomerLimit: event.target.value })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
            <Field label="Starts" htmlFor="reward-starts" layout="stacked">
              <Input
                id="reward-starts"
                type="date"
                className="tnum"
                value={draft.startsAt}
                onChange={(event) => onChange({ startsAt: event.target.value })}
              />
            </Field>
            <Field label="Ends" htmlFor="reward-ends" layout="stacked" error={shown.endsAt}>
              <Input
                id="reward-ends"
                type="date"
                className="tnum"
                value={draft.endsAt}
                aria-invalid={Boolean(shown.endsAt) || undefined}
                onChange={(event) => onChange({ endsAt: event.target.value })}
              />
            </Field>
          </div>

          <Field label="Picture" layout="stacked">
            <div className="flex flex-wrap items-center gap-6">
              <ProductImage
                src={preview ?? draft.imageUrl ?? undefined}
                alt=""
                ratio={[4, 3]}
                finish="edge"
                height={72}
              />
              <input
                ref={fileRef}
                id="reward-image"
                data-testid="reward-image-input"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label="A picture of this reward"
                className="sr-only"
                onChange={(event) =>
                  onChange({ image: event.target.files?.[0] ?? null })
                }
              />
              <Button
                variant="text"
                type="button"
                onClick={() => fileRef.current?.click()}
              >
                {draft.imageUrl || draft.image ? "Change picture" : "Add a picture"}
              </Button>
              <Hint>{draft.image ? draft.image.name : "JPEG, PNG or WebP"}</Hint>
            </div>
          </Field>

          <Field label="Live" layout="stacked">
            <div className="flex items-center gap-4">
              <Switch
                checked={draft.active}
                onCheckedChange={(next: boolean) => onChange({ active: next })}
                aria-label="This reward is live"
              />
              <span className="text-[15px] text-foreground">
                {draft.active ? "In the catalogue" : "Hidden"}
              </span>
            </div>
          </Field>
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          type="button"
          trailingArrow
          loading={saving}
          onClick={() => {
            setShowErrors(true)
            if (Object.keys(errors).length > 0) return
            onSave()
          }}
        >
          Save reward
        </Button>
        <Button variant="text" type="button" onClick={onCancel}>
          Cancel
        </Button>
        {error ? <FieldError>{error}</FieldError> : null}
      </SheetFooter>
    </>
  )
}

export interface RewardsSectionProps {
  rewards: LoyaltyRewardRecord[]
  onSave: (form: RewardForm) => Promise<unknown>
  saving: boolean
  error: string | null
  onDismissError: () => void
}

export function RewardsSection({
  rewards,
  onSave,
  saving,
  error,
  onDismissError,
}: RewardsSectionProps) {
  const [draft, setDraft] = React.useState<RewardForm | null>(null)

  function close() {
    setDraft(null)
    onDismissError()
  }

  return (
    <>
      <ul data-testid="loyalty-rewards">
        {rewards.map((reward) => (
          <li key={reward.id} className="border-b border-hairline-soft first:border-t">
            <button
              type="button"
              onClick={() => setDraft(rewardToForm(reward))}
              className="flex min-h-16 w-full items-center gap-4 py-3 text-left transition-colors duration-150 ease-gg hover:bg-row-hover"
            >
              <ProductImage
                src={reward.imageUrl || undefined}
                alt=""
                ratio={[4, 3]}
                finish="edge"
                height={40}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-foreground">
                  {reward.name}
                </span>
                <span className="block truncate text-[13px] text-muted-foreground-2">
                  {rewardWorth(reward)} · {rewardLimits(reward)}
                </span>
              </span>
              <span className="tnum shrink-0 text-[15px] text-foreground">
                {(reward.cost_points ?? 0).toLocaleString("en-GB")}
              </span>
              <Badge variant="outline">
                {reward.active === false ? "Hidden" : "Live"}
              </Badge>
            </button>
          </li>
        ))}
        {rewards.length === 0 ? (
          <li className="py-3 text-[15px] text-muted-foreground-2">
            No rewards yet. Add one so points are worth something.
          </li>
        ) : null}
      </ul>

      <div className="mt-6">
        <Button
          variant="text"
          type="button"
          onClick={() => setDraft(emptyReward(`new-${Date.now()}`))}
        >
          Add a reward
        </Button>
      </div>

      <Sheet
        open={draft !== null}
        onOpenChange={(open: boolean) => {
          if (!open) close()
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Reward</SheetTitle>
            <SheetDescription>What it costs, what it gives and when it runs.</SheetDescription>
          </SheetHeader>
          {draft ? (
            <RewardFormBody
              draft={draft}
              saving={saving}
              error={error}
              onChange={(patch) =>
                setDraft((current) => (current ? { ...current, ...patch } : current))
              }
              onSave={() => {
                void onSave(draft).then(() => setDraft(null))
              }}
              onCancel={close}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
