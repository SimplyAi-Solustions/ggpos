/**
 * A new event or tournament: its name, the game and format, the day and
 * times, how many places, the entry fee and the Guild fee, whether My Vault
 * can enter it, whether it repeats every week (a cron makes the next four
 * weeks ahead, section 4), and which tables or rooms it takes up. Publish
 * opens it for entries; a draft waits.
 */
import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { parseDecimalToMinor, shopTimeToUtc, type ResourceKind } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
import { createEvent, type EventInput, type EventView } from "@/lib/api/bookings"
import { listGames } from "@/lib/api"
import { refusalOrFallback } from "@/lib/api/refusal"

interface ResourceChoice {
  id: string
  name: string
  kind: ResourceKind
}

export function NewEventSheet({
  open,
  onOpenChange,
  date,
  resources,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The day it starts on unless changed: the day the screen is on. */
  date: string
  resources: readonly ResourceChoice[]
  onCreated: (event: EventView) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)] sm:max-w-lg" data-testid="new-event-sheet">
        {open ? (
          <EventForm date={date} resources={resources} onCreated={onCreated} onCancel={() => onOpenChange(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SwitchRow({
  label,
  checked,
  onChange,
  on,
  off,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
  on: string
  off: string
}) {
  return (
    <Field layout="stacked" label={label}>
      <div className="flex items-center gap-4">
        <Switch checked={checked} onCheckedChange={(next: boolean) => onChange(next)} aria-label={label} />
        <span className="text-[15px] text-foreground">{checked ? on : off}</span>
      </div>
    </Field>
  )
}

function EventForm({
  date,
  resources,
  onCreated,
  onCancel,
}: {
  date: string
  resources: readonly ResourceChoice[]
  onCreated: (event: EventView) => void
  onCancel: () => void
}) {
  const games = useQuery({ queryKey: ["games"], queryFn: listGames, staleTime: 5 * 60_000 })
  const [name, setName] = React.useState("")
  const [game, setGame] = React.useState("")
  const [format, setFormat] = React.useState("")
  const [day, setDay] = React.useState(date)
  const [starts, setStarts] = React.useState("18:00")
  const [ends, setEnds] = React.useState("21:00")
  const [capacity, setCapacity] = React.useState("16")
  const [fee, setFee] = React.useState("5.00")
  const [memberFee, setMemberFee] = React.useState("")
  const [online, setOnline] = React.useState(true)
  const [weekly, setWeekly] = React.useState(false)
  const [takes, setTakes] = React.useState<string[]>([])
  const [description, setDescription] = React.useState("")
  const [problem, setProblem] = React.useState<{ field: string; message: string } | null>(null)

  const save = useMutation({
    mutationFn: (status: EventInput["status"]) => {
      if (!name.trim()) throw Object.assign(new Error("Give the event a name."), { field: "name" })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error("Pick the day it is on."), { field: "day" })
      const startsAt = shopTimeToUtc(day, starts).toISOString()
      const endsAt = shopTimeToUtc(day, ends).toISOString()
      if (!(Date.parse(endsAt) > Date.parse(startsAt))) {
        throw Object.assign(new Error("The event has to end after it starts."), { field: "ends" })
      }
      const places = capacity.trim() === "" ? 0 : Number(capacity)
      if (!Number.isInteger(places) || places < 0) {
        throw Object.assign(new Error("Places is a whole number. Leave it empty for no limit."), { field: "capacity" })
      }
      const entry = parseDecimalToMinor(fee.trim() || "0")
      if (entry === null || entry < 0) {
        throw Object.assign(new Error("Type the entry fee in pounds, such as 5.00."), { field: "fee" })
      }
      const guild = memberFee.trim() === "" ? null : parseDecimalToMinor(memberFee.trim())
      if (guild !== null && guild < 0) {
        throw Object.assign(new Error("Type the Guild fee in pounds, or leave it empty."), { field: "memberFee" })
      }
      if (memberFee.trim() !== "" && guild === null) {
        throw Object.assign(new Error("Type the Guild fee in pounds, or leave it empty."), { field: "memberFee" })
      }
      return createEvent({
        name,
        game,
        format,
        starts_at: startsAt,
        ends_at: endsAt,
        capacity: places,
        entry_fee: entry,
        member_fee: guild,
        online,
        repeat_weekly: weekly,
        resources: takes,
        description,
        status,
      })
    },
    onMutate: () => setProblem(null),
    onSuccess: onCreated,
    onError: (error) => {
      const field = (error as { field?: string }).field ?? "form"
      setProblem({ field, message: refusalOrFallback(error, "The event was not saved. Try again.") })
    },
  })

  const errorFor = (field: string) => (problem?.field === field ? problem.message : null)
  const places = resources.filter((row) => row.kind === "table" || row.kind === "room")

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-label="New event"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate("published")
      }}
    >
      <SheetHeader>
        <SheetTitle>New event</SheetTitle>
        <SheetDescription>A league night, a tournament or a launch. Times are the shop's.</SheetDescription>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-8">
        <Field layout="stacked" label="Name" htmlFor="event-name" error={errorFor("name")}>
          <Input
            id="event-name"
            autoComplete="off"
            maxLength={120}
            placeholder="Pokémon League"
            value={name}
            onChange={(change) => setName(change.target.value)}
          />
        </Field>
        <Field layout="stacked" label="Game">
          <Select value={game || null} onValueChange={(next: string | null) => setGame(next ?? "")}>
            <SelectTrigger aria-label="Game">
              <SelectValue placeholder="Any or none">
                {(value: string) => games.data?.find((row) => row.id === value)?.name ?? "Any or none"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(games.data ?? []).map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field layout="stacked" label="Format" htmlFor="event-format">
          <Input
            id="event-format"
            autoComplete="off"
            maxLength={120}
            placeholder="Standard, best of three"
            value={format}
            onChange={(change) => setFormat(change.target.value)}
          />
        </Field>
        <Field layout="stacked" label="Day" htmlFor="event-day" error={errorFor("day")}>
          <Input id="event-day" type="date" value={day} onChange={(change) => setDay(change.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-6">
          <Field layout="stacked" label="Starts" htmlFor="event-starts">
            <Input id="event-starts" type="time" step={900} value={starts} onChange={(change) => setStarts(change.target.value)} />
          </Field>
          <Field layout="stacked" label="Ends" htmlFor="event-ends" error={errorFor("ends")}>
            <Input id="event-ends" type="time" step={900} value={ends} onChange={(change) => setEnds(change.target.value)} />
          </Field>
        </div>
        <Field layout="stacked" label="Places" htmlFor="event-capacity" error={errorFor("capacity")}>
          <Input
            id="event-capacity"
            className="tnum"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            trailingHint="Players"
            value={capacity}
            onChange={(change) => setCapacity(change.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-6">
          <Field layout="stacked" label="Entry fee" htmlFor="event-fee" error={errorFor("fee")}>
            <MoneyInput id="event-fee" value={fee} onChange={setFee} invalid={Boolean(errorFor("fee"))} />
          </Field>
          <Field layout="stacked" label="Guild fee" htmlFor="event-member-fee" error={errorFor("memberFee")}>
            <MoneyInput
              id="event-member-fee"
              value={memberFee}
              placeholder="Same"
              onChange={setMemberFee}
              invalid={Boolean(errorFor("memberFee"))}
            />
          </Field>
        </div>
        <SwitchRow label="My Vault" checked={online} onChange={setOnline} on="Customers can enter online" off="Counter only" />
        <SwitchRow label="Every week" checked={weekly} onChange={setWeekly} on="Repeats weekly" off="Just this once" />
        {places.length > 0 ? (
          <Field layout="stacked" label="Takes up">
            <ChipGroup multiple aria-label="Tables and rooms it takes up" value={takes} onValueChange={(next: string[]) => setTakes(next)}>
              {places.map((row) => (
                <Chip key={row.id} value={row.id}>
                  {row.name}
                </Chip>
              ))}
            </ChipGroup>
            <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground-2">
              Nobody can book these while the event is on.
            </p>
          </Field>
        ) : null}
        <Field layout="stacked" label="About it" htmlFor="event-description">
          <Textarea
            id="event-description"
            maxLength={4000}
            placeholder="What to bring, prizes, the rules"
            value={description}
            onChange={(change) => setDescription(change.target.value)}
          />
        </Field>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-4">
        <FieldError>{problem?.field === "form" ? problem.message : null}</FieldError>
        <div className="flex flex-wrap items-center gap-6">
          <Button type="submit" trailingArrow loading={save.isPending && save.variables === "published"}>
            Publish event
          </Button>
          <Button type="button" variant="text" disabled={save.isPending} onClick={() => save.mutate("draft")}>
            Save as a draft
          </Button>
          <Button type="button" variant="text" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetFooter>
    </form>
  )
}
