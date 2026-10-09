/**
 * Settings, Website (docs/api-contract-launch.md, section 6): what the
 * shop's website shows from stock.
 *
 * - **The feed**: on or off, the minimum price, and whether quantities
 *   show (`settings.online`). Saved by its own button, straight away, like
 *   the other sections after the page's Save; the write is audited.
 * - **Branches that start new stock online**: a branch's `show_online`.
 *   Stock filed in one of them, or beneath it, is shown the moment it is
 *   added; anything else is switched on from its page or from Stock.
 * - **On the website now**: the feed's first page, read from the feed
 *   itself, so this is what a visitor sees.
 *
 * Admin only, as the rest of the page is.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP, parseDecimalToMinor, type OnlineSettings } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Switch } from "@/components/ui/switch"
import { ProductImage } from "@/components/product-image"
import { CategoryPicker } from "@/features/categories/CategoryPicker"
import { PoundsField } from "@/features/settings/fields"
import { penceToField } from "@/features/sell/money"
import {
  getOnlineSettings,
  listOnlineBranches,
  ONLINE_BRANCHES_KEY,
  ONLINE_FEED_KEY,
  ONLINE_SETTINGS_KEY,
  previewFeed,
  saveOnlineSettings,
  setBranchOnline,
  type OnlineSettingsRow,
} from "@/lib/api/online"
import { refusalOrFallback } from "@/lib/api/refusal"

/** How many of the feed's items the preview lists. */
const PREVIEW = 6

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
}

function Toggle({
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
  onChange: (next: boolean) => void
  on: string
  off: string
  note: React.ReactNode
  testId: string
}) {
  return (
    <Field label={label} layout="auto">
      <div className="flex items-center gap-4" data-testid={testId}>
        <Switch checked={checked} onCheckedChange={(next: boolean) => onChange(next)} aria-label={label} />
        <span className="text-[15px] text-foreground">{checked ? on : off}</span>
      </div>
      <Note>{note}</Note>
    </Field>
  )
}

interface Form {
  enabled: boolean
  minPrice: string
  hideQty: boolean
}

function toForm(row: OnlineSettings): Form {
  return { enabled: row.enabled, minPrice: penceToField(row.min_price), hideQty: row.hide_qty }
}

function FeedForm({ row }: { row: OnlineSettingsRow }) {
  const queryClient = useQueryClient()
  const [form, setForm] = React.useState<Form>(() => toForm(row))
  const [baseline, setBaseline] = React.useState<Form>(() => toForm(row))
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)

  const save = useMutation({
    mutationFn: (value: OnlineSettings) => saveOnlineSettings(row.id, value),
    onSuccess: (next) => {
      const fresh = toForm(next)
      setForm(fresh)
      setBaseline(fresh)
      setSaved(true)
      queryClient.setQueryData(ONLINE_SETTINGS_KEY, next)
      void queryClient.invalidateQueries({ queryKey: ONLINE_FEED_KEY })
    },
    onError: (err) => setError(refusalOrFallback(err, "The website settings did not save. Try again.")),
  })

  function set(patch: Partial<Form>) {
    setSaved(false)
    setError(null)
    setForm((current) => ({ ...current, ...patch }))
  }

  function submit() {
    const pence = form.minPrice.trim() === "" ? 0 : parseDecimalToMinor(form.minPrice)
    if (pence === null || pence < 0) {
      setError("Enter the minimum price in pounds and pence, for example 5.00.")
      return
    }
    save.mutate({ enabled: form.enabled, min_price: pence, hide_qty: form.hideQty })
  }

  return (
    <div className="flex flex-col gap-10">
      <Toggle
        label="Show stock"
        testId="website-enabled"
        checked={form.enabled}
        onChange={(next) => set({ enabled: next })}
        on="Stock shows on the website"
        off="Nothing shows on the website"
        note="Only items marked to show online, on the shelf and at or over the minimum price."
      />
      <PoundsField
        id="website-min-price"
        label="Minimum price"
        value={form.minPrice}
        onChange={(next) => set({ minPrice: next })}
        error={error ?? undefined}
        note="Nothing priced under this shows. 0.00 shows everything marked."
      />
      <Toggle
        label="Quantities"
        testId="website-qty"
        checked={!form.hideQty}
        onChange={(next) => set({ hideQty: !next })}
        on="Shown"
        off="Hidden"
        note="Hidden, the website says in stock without saying how many."
      />
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="text" loading={save.isPending} disabled={!dirty || save.isPending} onClick={submit}>
          Save website settings
        </Button>
        {saved ? (
          <span aria-live="polite" data-testid="website-saved" className="text-[13px] text-muted-foreground">
            Saved.
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Branches() {
  const queryClient = useQueryClient()
  const [picking, setPicking] = React.useState(false)
  const branches = useQuery({ queryKey: ONLINE_BRANCHES_KEY, queryFn: listOnlineBranches, staleTime: 30_000 })

  const change = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => setBranchOnline(id, on),
    onSuccess: () => {
      setPicking(false)
      void queryClient.invalidateQueries({ queryKey: ONLINE_BRANCHES_KEY })
    },
  })
  const error = change.error ? refusalOrFallback(change.error, "That branch did not change. Try again.") : null
  const rows = branches.data ?? []

  return (
    <div className="mt-14">
      <MicroLabel className="mb-3 block">Starts online</MicroLabel>
      {rows.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2" data-testid="website-branches-empty">
          {branches.isPending ? "Reading the branches." : "No branch yet. New stock starts off the website."}
        </p>
      ) : (
        <ul data-testid="website-branches">
          {rows.map((branch) => (
            <li
              key={branch.id}
              className="flex min-h-12 items-center justify-between gap-6 border-b border-hairline-soft py-3 first:border-t"
            >
              <span className="min-w-0 text-[15px] text-foreground">{branch.path}</span>
              <Button
                variant="text"
                loading={change.isPending && change.variables?.id === branch.id}
                onClick={() => change.mutate({ id: branch.id, on: false })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Note>Stock filed in these branches, or beneath them, shows on the website the moment it is added.</Note>
      <div className="mt-5">
        <Button variant="text" onClick={() => setPicking(true)}>
          Add a branch
        </Button>
      </div>
      <CategoryPicker
        open={picking}
        onOpenChange={(open) => {
          if (!open) change.reset()
          setPicking(open)
        }}
        title="Start new stock online in"
        description="New stock filed here, or beneath it, starts shown on the website."
        pending={change.isPending}
        error={error}
        onChoose={(branch) => {
          if (branch) change.mutate({ id: branch.id, on: true })
        }}
      />
    </div>
  )
}

function Preview() {
  const feed = useQuery({ queryKey: [...ONLINE_FEED_KEY, "preview"], queryFn: previewFeed, staleTime: 10_000 })
  const items = feed.data?.items.slice(0, PREVIEW) ?? []
  const total = feed.data?.total ?? 0

  return (
    <div className="mt-14" data-testid="website-preview">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <MicroLabel>On the website now</MicroLabel>
        {feed.data ? (
          <Hint className="tnum" data-testid="website-total">
            {total} {total === 1 ? "item" : "items"}
          </Hint>
        ) : null}
      </div>
      {feed.error ? (
        <p className="text-[13px] text-destructive">
          {refusalOrFallback(feed.error, "The website feed did not answer. Check the connection and try again.")}
        </p>
      ) : items.length === 0 ? (
        <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
          {feed.isPending
            ? "Reading the feed."
            : "Nothing is on the website yet. Switch an item on from its page, or tick rows in Stock."}
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li
              key={item.sku}
              data-testid="website-preview-item"
              className="flex min-h-14 items-center gap-4 border-b border-hairline-soft py-2 first:border-t"
            >
              <span className="flex w-10 shrink-0 justify-center">
                <ProductImage src={item.image.small || undefined} alt="" ratio={[item.image.ratio, 1]} height={40} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-foreground">{item.title}</span>
                {item.condition ? <span className="block truncate text-[13px] text-muted-foreground">{item.condition}</span> : null}
              </span>
              <span className="tnum shrink-0 text-[15px] text-foreground">{formatGBP(item.price)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function WebsiteSection() {
  const settings = useQuery({ queryKey: ONLINE_SETTINGS_KEY, queryFn: getOnlineSettings, staleTime: 60_000 })

  return (
    <section className="mt-24" aria-labelledby="website-heading" data-testid="website-section">
      <SectionHeading id="website-heading">Website</SectionHeading>
      <p className="mb-10 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        What ggentertainment.co.uk shows from stock. Sold and reserved items come off it at once.
      </p>
      {settings.data ? (
        <FeedForm key={settings.data.id} row={settings.data} />
      ) : settings.error ? (
        <p className="text-[13px] text-destructive">
          {refusalOrFallback(settings.error, "The website settings would not load. Try again.")}
        </p>
      ) : (
        <Hint>Reading settings</Hint>
      )}
      <Branches />
      <Preview />
    </section>
  )
}
