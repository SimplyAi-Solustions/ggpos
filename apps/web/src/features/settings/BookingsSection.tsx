/**
 * Settings, Bookings (docs/api-contract-launch.md, section 4, "Web (BW)"):
 * the tables, stations and rooms the counter and My Vault book, and the
 * shop's opening hours. Both act the moment they are saved, like Tills,
 * rather than waiting for the page's Save: a resource is its own record,
 * written straight to `resources` (a manager or an admin may), and the
 * hours are `settings.opening_hours`, which only an admin writes.
 *
 * A resource is never deleted, because bookings point at it: switching it
 * off takes it off the day view and My Vault.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  formatGBP,
  hoursProblem,
  parseDecimalToMinor,
  type OpeningHours,
  type ResourceKind,
  type WeekdayKey,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { MoneyInput } from "@/features/sell/money-input"
import { penceToField } from "@/features/sell/money"
import { DAY_NAMES, WEEK, kindLabel, lengthWords } from "@/features/bookings/model"
import {
  getShopHours,
  listResources,
  saveResource,
  saveShopHours,
  type Resource,
  type ResourceInput,
} from "@/lib/api/bookings"
import { refusalOrFallback } from "@/lib/api/refusal"

const RESOURCES_KEY = ["booking-resources"] as const
const HOURS_KEY = ["shop-hours"] as const

const KINDS: ResourceKind[] = ["table", "pc", "console", "room"]

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">{children}</p>
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

/**
 * One row a day: open or closed, and from when to when. A day with more
 * than one window keeps the others as they are; this edits the first.
 */
function HoursEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: OpeningHours
  onChange: (next: OpeningHours) => void
  idPrefix: string
}) {
  const setDay = (day: WeekdayKey, windows: [string, string][] | undefined) => {
    const next: OpeningHours = { ...value }
    if (windows && windows.length > 0) next[day] = windows
    else delete next[day]
    onChange(next)
  }
  return (
    <div className="flex flex-col" data-testid={`${idPrefix}-hours`}>
      {WEEK.map((day) => {
        const windows = value[day] ?? []
        const first = windows[0]
        const open = Boolean(first)
        return (
          <div
            key={day}
            className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-2 border-b border-hairline-soft py-3 min-[640px]:grid-cols-[8rem_7rem_1fr]"
          >
            <span className="text-[15px] text-foreground">{DAY_NAMES[day]}</span>
            <span className="flex items-center gap-3">
              <Switch
                checked={open}
                aria-label={`${DAY_NAMES[day]} open`}
                onCheckedChange={(next: boolean) =>
                  setDay(day, next ? [["10:00", "18:00"], ...windows.slice(1)] : undefined)
                }
              />
              <span className="text-[13px] text-muted-foreground">{open ? "Open" : "Closed"}</span>
            </span>
            {first ? (
              <span className="col-span-2 flex items-center gap-3 min-[640px]:col-span-1">
                <Input
                  type="time"
                  step={900}
                  aria-label={`${DAY_NAMES[day]} opens`}
                  containerClassName="w-32"
                  value={first[0]}
                  onChange={(change) => setDay(day, [[change.target.value, first[1]], ...windows.slice(1)])}
                />
                <span className="text-[13px] text-muted-foreground">to</span>
                <Input
                  type="time"
                  step={900}
                  aria-label={`${DAY_NAMES[day]} closes`}
                  containerClassName="w-32"
                  value={first[1]}
                  onChange={(change) => setDay(day, [[first[0], change.target.value], ...windows.slice(1)])}
                />
              </span>
            ) : (
              <span className="hidden min-[640px]:block" />
            )}
          </div>
        )
      })}
    </div>
  )
}

function ShopHours() {
  const queryClient = useQueryClient()
  const hours = useQuery({ queryKey: HOURS_KEY, queryFn: getShopHours, staleTime: 60_000 })
  const [draft, setDraft] = React.useState<OpeningHours | null>(null)
  const [message, setMessage] = React.useState<{ text: string; problem: boolean } | null>(null)
  const value = draft ?? hours.data?.hours ?? {}

  const save = useMutation({
    mutationFn: () => {
      const problem = hoursProblem(value)
      if (problem) throw new Error(problem)
      if (!hours.data) throw new Error("The hours have not loaded yet. Try again in a moment.")
      return saveShopHours(hours.data.id, value)
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(HOURS_KEY, { id: hours.data?.id ?? "", hours: saved })
      setDraft(null)
      setMessage({ text: "Opening hours saved. The day view and My Vault use them now.", problem: false })
      void queryClient.invalidateQueries({ queryKey: ["bookings-availability"] })
    },
    onError: (error) =>
      setMessage({ text: refusalOrFallback(error, "The hours were not saved. Try again."), problem: true }),
  })

  if (hours.isError) {
    return (
      <p className="text-[15px] text-destructive">
        {refusalOrFallback(hours.error, "The opening hours would not load. Check the connection and try again.")}
      </p>
    )
  }
  if (!hours.data) return <p className="text-[15px] text-muted-foreground-2">Loading the hours.</p>

  return (
    <div>
      <HoursEditor
        idPrefix="shop"
        value={value}
        onChange={(next) => {
          setMessage(null)
          setDraft(next)
        }}
      />
      <div className="mt-6 flex flex-wrap items-center gap-8">
        <Button variant="text" loading={save.isPending} disabled={draft === null} onClick={() => save.mutate()}>
          Save opening hours
        </Button>
        {draft !== null ? (
          <Button
            variant="text"
            onClick={() => {
              setDraft(null)
              setMessage(null)
            }}
          >
            Discard
          </Button>
        ) : null}
      </div>
      {message ? (
        <p
          aria-live="polite"
          data-testid="shop-hours-message"
          className={
            message.problem
              ? "mt-3 text-[13px] leading-[1.45] text-destructive"
              : "mt-3 text-[13px] leading-[1.45] text-muted-foreground"
          }
        >
          {message.text}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

interface ResourceForm {
  name: string
  kind: ResourceKind
  capacity: string
  slot: string
  price: string
  memberPrice: string
  deposit: string
  online: boolean
  ownHours: boolean
  hours: OpeningHours
  active: boolean
  sort: string
  note: string
  image: File | null | undefined
  imageUrl: string
}

function formFor(resource: Resource | null, shopHours: OpeningHours, nextSort: number): ResourceForm {
  return {
    name: resource?.name ?? "",
    kind: resource?.kind ?? "table",
    capacity: String(resource?.capacity ?? 4),
    slot: String(resource?.slot_minutes ?? 60),
    price: penceToField(resource?.price ?? 0),
    memberPrice: resource?.member_price !== null && resource?.member_price !== undefined ? penceToField(resource.member_price) : "",
    deposit: resource?.deposit ? penceToField(resource.deposit) : "",
    online: resource?.online ?? true,
    ownHours: Boolean(resource?.hours),
    hours: resource?.hours ?? shopHours,
    active: resource?.active ?? true,
    sort: String(resource?.sort ?? nextSort),
    note: resource?.note ?? "",
    image: undefined,
    imageUrl: resource?.image ?? "",
  }
}

type FormErrors = Partial<Record<"name" | "capacity" | "slot" | "price" | "memberPrice" | "deposit" | "hours", string>>

function toInput(form: ResourceForm): { input: ResourceInput | null; errors: FormErrors } {
  const errors: FormErrors = {}
  if (!form.name.trim()) errors.name = "Give it a name, such as Table 5."
  const capacity = Number(form.capacity)
  // 0 is no limit, as BK reads it.
  if (form.capacity.trim() === "" || !Number.isInteger(capacity) || capacity < 0) {
    errors.capacity = "How many it takes, or 0 for no limit."
  }
  const slot = Number(form.slot)
  if (!Number.isInteger(slot) || slot < 5) errors.slot = "A slot is a whole number of minutes, five or more."
  const price = parseDecimalToMinor(form.price.trim() || "0")
  if (price === null || price < 0) errors.price = "Type the price in pounds, such as 5.00."
  const member = form.memberPrice.trim() === "" ? null : parseDecimalToMinor(form.memberPrice.trim())
  if (form.memberPrice.trim() !== "" && (member === null || member < 0)) {
    errors.memberPrice = "Type the Guild price in pounds, or leave it empty."
  }
  const deposit = form.deposit.trim() === "" ? null : parseDecimalToMinor(form.deposit.trim())
  if (form.deposit.trim() !== "" && (deposit === null || deposit < 0)) {
    errors.deposit = "Type the deposit in pounds, or leave it empty."
  }
  const hoursIssue = form.ownHours ? hoursProblem(form.hours) : null
  if (hoursIssue) errors.hours = hoursIssue
  if (Object.keys(errors).length > 0) return { input: null, errors }
  return {
    errors,
    input: {
      name: form.name.trim(),
      kind: form.kind,
      capacity,
      slot_minutes: slot,
      price: price ?? 0,
      // 0 is none for a Guild price, as BK reads it: the same price for everybody.
      member_price: member && member > 0 ? member : null,
      deposit: deposit && deposit > 0 ? deposit : null,
      online: form.online,
      hours: form.ownHours ? form.hours : null,
      active: form.active,
      sort: Number.isFinite(Number(form.sort)) ? Math.round(Number(form.sort)) : 0,
      note: form.note,
      ...(form.image !== undefined ? { image: form.image } : {}),
    },
  }
}

function ResourceSheet({
  open,
  resource,
  shopHours,
  nextSort,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  resource: Resource | null
  shopHours: OpeningHours
  nextSort: number
  onOpenChange: (open: boolean) => void
  onSaved: (resource: Resource) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)] sm:max-w-lg" data-testid="resource-sheet">
        {open ? (
          <ResourceEditor
            key={resource?.id ?? "new"}
            resource={resource}
            shopHours={shopHours}
            nextSort={nextSort}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ResourceEditor({
  resource,
  shopHours,
  nextSort,
  onSaved,
  onCancel,
}: {
  resource: Resource | null
  shopHours: OpeningHours
  nextSort: number
  onSaved: (resource: Resource) => void
  onCancel: () => void
}) {
  const [form, setForm] = React.useState<ResourceForm>(() => formFor(resource, shopHours, nextSort))
  const [errors, setErrors] = React.useState<FormErrors>({})
  const [problem, setProblem] = React.useState<string | null>(null)
  const set = (patch: Partial<ResourceForm>) => setForm((current) => ({ ...current, ...patch }))
  const preview = React.useMemo(() => (form.image ? URL.createObjectURL(form.image) : null), [form.image])
  React.useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  const save = useMutation({
    mutationFn: (input: ResourceInput) => saveResource(resource?.id ?? null, input),
    onMutate: () => setProblem(null),
    onSuccess: onSaved,
    onError: (error) => setProblem(refusalOrFallback(error, "That did not save. Try again.")),
  })

  const shownImage = form.image === null ? "" : (preview ?? form.imageUrl)

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-label={resource ? `Edit ${resource.name}` : "New resource"}
      onSubmit={(event) => {
        event.preventDefault()
        const { input, errors: found } = toInput(form)
        setErrors(found)
        if (input) save.mutate(input)
        else setProblem("Some fields need fixing. Each one says what under it.")
      }}
    >
      <SheetHeader>
        <SheetTitle>{resource ? resource.name : "New resource"}</SheetTitle>
        <SheetDescription>A table, a station or a room the counter and My Vault can book.</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-8">
        <Field layout="stacked" label="Name" htmlFor="resource-name" error={errors.name}>
          <Input
            id="resource-name"
            autoComplete="off"
            maxLength={60}
            placeholder="Table 5"
            aria-invalid={Boolean(errors.name) || undefined}
            value={form.name}
            onChange={(change) => set({ name: change.target.value })}
          />
        </Field>
        <Field layout="stacked" label="Kind">
          <ChipGroup
            aria-label="Kind"
            value={[form.kind]}
            onValueChange={(next: string[]) => {
              if (next[0]) set({ kind: next[0] as ResourceKind })
            }}
          >
            {KINDS.map((kind) => (
              <Chip key={kind} value={kind}>
                {kindLabel(kind).replace(/s$/, "")}
              </Chip>
            ))}
          </ChipGroup>
        </Field>
        <div className="grid grid-cols-2 gap-6">
          <Field layout="stacked" label="Takes" htmlFor="resource-capacity" error={errors.capacity}>
            <Input
              id="resource-capacity"
              className="tnum"
              inputMode="numeric"
              maxLength={3}
              trailingHint="Players"
              value={form.capacity}
              onChange={(change) => set({ capacity: change.target.value })}
            />
          </Field>
          <Field layout="stacked" label="Slot" htmlFor="resource-slot" error={errors.slot}>
            <Input
              id="resource-slot"
              className="tnum"
              inputMode="numeric"
              maxLength={4}
              trailingHint="Minutes"
              value={form.slot}
              onChange={(change) => set({ slot: change.target.value })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <Field layout="stacked" label="Price a slot" htmlFor="resource-price" error={errors.price}>
            <MoneyInput id="resource-price" value={form.price} onChange={(next) => set({ price: next })} invalid={Boolean(errors.price)} />
          </Field>
          <Field layout="stacked" label="Guild price" htmlFor="resource-member" error={errors.memberPrice}>
            <MoneyInput
              id="resource-member"
              value={form.memberPrice}
              placeholder="Same"
              onChange={(next) => set({ memberPrice: next })}
              invalid={Boolean(errors.memberPrice)}
            />
          </Field>
        </div>
        <Field layout="stacked" label="Deposit" htmlFor="resource-deposit" error={errors.deposit}>
          <MoneyInput
            id="resource-deposit"
            value={form.deposit}
            placeholder="None"
            onChange={(next) => set({ deposit: next })}
            invalid={Boolean(errors.deposit)}
          />
          <Note>Taken at the till to hold a booking. Leave it empty for none.</Note>
        </Field>
        <Field layout="stacked" label="My Vault">
          <div className="flex items-center gap-4">
            <Switch checked={form.online} onCheckedChange={(next: boolean) => set({ online: next })} aria-label="Bookable in My Vault" />
            <span className="text-[15px] text-foreground">{form.online ? "Customers can book it online" : "Counter and phone only"}</span>
          </div>
        </Field>
        <Field layout="stacked" label="Switched on">
          <div className="flex items-center gap-4">
            <Switch checked={form.active} onCheckedChange={(next: boolean) => set({ active: next })} aria-label="Switched on" />
            <span className="text-[15px] text-foreground">{form.active ? "On the day view" : "Off, nobody can book it"}</span>
          </div>
        </Field>
        <Field layout="stacked" label="Hours" error={errors.hours}>
          <div className="flex items-center gap-4">
            <Switch checked={form.ownHours} onCheckedChange={(next: boolean) => set({ ownHours: next })} aria-label="Its own hours" />
            <span className="text-[15px] text-foreground">{form.ownHours ? "Its own hours" : "The shop's hours"}</span>
          </div>
          {form.ownHours ? (
            <div className="mt-4">
              <HoursEditor idPrefix="resource" value={form.hours} onChange={(next) => set({ hours: next })} />
            </div>
          ) : null}
        </Field>
        <Field layout="stacked" label="Picture" htmlFor="resource-image">
          {shownImage ? (
            <img src={shownImage} alt="" width={160} height={120} className="mb-3 h-[120px] w-[160px] object-contain" />
          ) : null}
          <div className="flex flex-wrap items-center gap-6">
            <input
              id="resource-image"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="max-w-full text-[13px] text-muted-foreground file:mr-4 file:h-10 file:rounded-[var(--radius)] file:border file:border-hairline file:bg-transparent file:px-4 file:font-mono file:text-[11px] file:font-bold file:tracking-[0.16em] file:text-foreground file:uppercase"
              onChange={(change) => set({ image: change.target.files?.[0] ?? undefined })}
            />
            {shownImage ? (
              <Button type="button" variant="text" onClick={() => set({ image: null })}>
                Take it off
              </Button>
            ) : null}
          </div>
        </Field>
        <Field layout="stacked" label="Order" htmlFor="resource-sort">
          <Input
            id="resource-sort"
            className="tnum"
            inputMode="numeric"
            maxLength={4}
            value={form.sort}
            onChange={(change) => set({ sort: change.target.value })}
          />
          <Note>Lower comes first on the day view.</Note>
        </Field>
        <Field layout="stacked" label="Note" htmlFor="resource-note">
          <Textarea
            id="resource-note"
            maxLength={500}
            placeholder="What staff should know about it"
            value={form.note}
            onChange={(change) => set({ note: change.target.value })}
          />
        </Field>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError>{problem}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button type="submit" trailingArrow loading={save.isPending}>
            {resource ? "Save changes" : "Add it"}
          </Button>
          <Button type="button" variant="text" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}

function Resources({ shopHours }: { shopHours: OpeningHours }) {
  const queryClient = useQueryClient()
  const resources = useQuery({ queryKey: RESOURCES_KEY, queryFn: listResources, staleTime: 60_000 })
  const [editing, setEditing] = React.useState<{ resource: Resource | null } | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const rows = resources.data ?? []
  const nextSort = rows.reduce((most, row) => Math.max(most, row.sort), 0) + 1

  return (
    <div>
      {resources.isError ? (
        <p className="text-[15px] text-destructive">
          {refusalOrFallback(resources.error, "The resources would not load. Check the connection and try again.")}
        </p>
      ) : resources.isPending ? (
        <p className="text-[15px] text-muted-foreground-2">Loading the resources.</p>
      ) : rows.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">Nothing to book yet. Add the tables and stations first.</p>
      ) : (
        <Table data-testid="resources-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="max-sm:hidden">Kind</TableHead>
              <TableHead className="max-sm:hidden" numeric>
                Takes
              </TableHead>
              <TableHead className="max-sm:hidden">Slot</TableHead>
              <TableHead numeric>Price</TableHead>
              <TableHead className="max-sm:hidden" numeric>
                Guild
              </TableHead>
              <TableHead className="max-sm:hidden">Online</TableHead>
              <TableHead>On</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="h-14 cursor-pointer" onClick={() => setEditing({ resource: row })}>
                <TableCell>
                  <button
                    type="button"
                    className="text-left text-[15px] text-foreground outline-none focus-visible:underline"
                    onClick={(click) => {
                      click.stopPropagation()
                      setEditing({ resource: row })
                    }}
                  >
                    {row.name}
                  </button>
                </TableCell>
                <TableCell className="max-sm:hidden">{kindLabel(row.kind).replace(/s$/, "")}</TableCell>
                <TableCell className="max-sm:hidden" numeric>
                  {row.capacity > 0 ? row.capacity : "No limit"}
                </TableCell>
                <TableCell className="max-sm:hidden">{lengthWords(row.slot_minutes)}</TableCell>
                <TableCell numeric>{formatGBP(row.price)}</TableCell>
                <TableCell className="max-sm:hidden" numeric>
                  {row.member_price !== null ? formatGBP(row.member_price) : "Same"}
                </TableCell>
                <TableCell className="max-sm:hidden">{row.online ? "Yes" : "No"}</TableCell>
                <TableCell>{row.active ? "On" : "Off"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-8">
        <Button variant="text" onClick={() => setEditing({ resource: null })}>
          Add a resource
        </Button>
        {message ? (
          <span aria-live="polite" className="text-[13px] text-muted-foreground">
            {message}
          </span>
        ) : null}
      </div>
      <ResourceSheet
        open={editing !== null}
        resource={editing?.resource ?? null}
        shopHours={shopHours}
        nextSort={nextSort}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        onSaved={(saved) => {
          setEditing(null)
          setMessage(`${saved.name} saved.`)
          void queryClient.invalidateQueries({ queryKey: RESOURCES_KEY })
          void queryClient.invalidateQueries({ queryKey: ["bookings-availability"] })
        }}
      />
    </div>
  )
}

/**
 * The section. `admin` adds the shop's hours, which live on the settings
 * record only an admin writes; a manager edits the resources alone.
 */
export function BookingsSection({ admin }: { admin: boolean }) {
  const hours = useQuery({ queryKey: HOURS_KEY, queryFn: getShopHours, enabled: admin, staleTime: 60_000 })
  return (
    <section className="mt-24" aria-labelledby="bookings-heading" data-testid="settings-bookings">
      <SectionHeading id="bookings-heading">Bookings</SectionHeading>
      <Note>
        The tables, stations and rooms the counter and My Vault book, and when the shop is open. Each change
        acts as soon as it is saved.
      </Note>
      <MicroLabel tone="ink" className="mt-10 mb-4">
        Resources
      </MicroLabel>
      <Resources shopHours={hours.data?.hours ?? {}} />
      {admin ? (
        <>
          <MicroLabel tone="ink" className="mt-14 mb-4">
            Opening hours
          </MicroLabel>
          <ShopHours />
          <Note>A resource with its own hours keeps them; everything else books inside these.</Note>
        </>
      ) : (
        <Note>The shop's opening hours are an admin's to change.</Note>
      )}
    </section>
  )
}
