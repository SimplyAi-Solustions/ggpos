/**
 * Saved views: a named set of filters for one report, and optionally an
 * email schedule for an admin.
 *
 * `saved_reports.filters` holds the breakdown and the grouping and nothing
 * else. The period is never saved: a scheduled weekly send always covers the
 * week that just ended, so a saved view that carried literal dates would go
 * stale the moment it was written (docs/api-contract.md, "Saved and
 * scheduled reports").
 */
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
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
import { refusalOrFallback } from "@/lib/api/refusal"
import { deleteSavedReport, saveSavedReport } from "@/lib/api/reports"
import { SCHEDULES, scheduleLabel } from "@/features/reports/schedules"
import type {
  ReportGroup,
  ReportKey,
  ReportSchedule,
  SavedReportRecord,
} from "@/lib/api/types"

/** The line of saved views under the title. Each one loads on a tap. */
export function SavedViewsRow({
  views,
  onLoad,
}: {
  views: SavedReportRecord[]
  onLoad: (view: SavedReportRecord) => void
}) {
  if (views.length === 0) return null
  return (
    <div data-testid="saved-views" className="mt-8">
      {/* Named so a saved view does not read as a second subtitle under the
          Anton line, which is what it looked like without it. */}
      <MicroLabel className="mb-3">Saved views</MicroLabel>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        {views.map((view) => (
          <Button key={view.id} variant="text" onClick={() => onLoad(view)}>
            {view.name || "Unnamed view"}
          </Button>
        ))}
      </div>
    </div>
  )
}

export interface SaveViewSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reportKey: ReportKey
  filters: { by?: string; group?: ReportGroup }
  /** Every saved view for this report, so one can be replaced or removed. */
  views: SavedReportRecord[]
  admin: boolean
}

function splitEmails(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SaveViewSheet({
  open,
  onOpenChange,
  reportKey,
  filters,
  views,
  admin,
}: SaveViewSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Save this view</SheetTitle>
          <SheetDescription>
            The breakdown and the grouping are kept. The dates are not: a
            scheduled report always covers the period that has just ended.
          </SheetDescription>
        </SheetHeader>
        {/* A child of SheetContent, which Base UI mounts only while the sheet
            is open, so the fields start empty every time without an effect
            reaching in to clear them. */}
        <SaveViewForm
          reportKey={reportKey}
          filters={filters}
          views={views}
          admin={admin}
          onDone={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

function SaveViewForm({
  reportKey,
  filters,
  views,
  admin,
  onDone,
}: {
  reportKey: ReportKey
  filters: { by?: string; group?: ReportGroup }
  views: SavedReportRecord[]
  admin: boolean
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = React.useState("")
  const [schedule, setSchedule] = React.useState<ReportSchedule>("none")
  const [recipients, setRecipients] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["saved-reports", reportKey] })

  const save = useMutation({
    mutationFn: () =>
      saveSavedReport({
        // A second save under the same name replaces that view rather than
        // leaving two rows nobody can tell apart.
        id: views.find(
          (view) => (view.name ?? "").toLowerCase() === name.trim().toLowerCase()
        )?.id,
        report_key: reportKey,
        name: name.trim(),
        filters,
        schedule: admin ? schedule : "none",
        recipients: admin ? splitEmails(recipients) : [],
      }),
    onSuccess: () => {
      void invalidate()
      onDone()
    },
    onError: (err) =>
      setError(refusalOrFallback(err, "That view did not save. Try again.")),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteSavedReport(id),
    onSuccess: () => void invalidate(),
    onError: (err) =>
      setError(refusalOrFallback(err, "That view did not go. Try again.")),
  })

  function submit() {
    if (!name.trim()) {
      setError("Give the view a name, so it can be found again.")
      return
    }
    const bad = splitEmails(recipients).find((entry) => !EMAIL.test(entry))
    if (admin && schedule !== "none" && bad) {
      setError(`${bad} is not an email address. Separate addresses with a comma.`)
      return
    }
    setError(null)
    save.mutate()
  }

  return (
    <>
      <SheetBody>
        <Field label="Name" htmlFor="view-name" layout="stacked">
          <Input
            id="view-name"
            autoFocus
            maxLength={200}
            placeholder="Sales by game, weekly"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
        </Field>

        {admin ? (
          <>
            <Field label="Email it" htmlFor="view-schedule" layout="stacked" className="mt-8">
              <Select
                value={schedule}
                onValueChange={(next) => setSchedule((next as ReportSchedule) ?? "none")}
              >
                <SelectTrigger id="view-schedule">
                  <SelectValue>
                    {(value: string) => scheduleLabel(value as ReportSchedule)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULES.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {schedule !== "none" ? (
              <Field label="Send to" htmlFor="view-recipients" layout="stacked" className="mt-8">
                <Input
                  id="view-recipients"
                  inputMode="email"
                  placeholder="richard@ggentertainment.co.uk"
                  value={recipients}
                  onChange={(event) => {
                    setRecipients(event.target.value)
                    setError(null)
                  }}
                />
                <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                  Separate addresses with a comma. Left empty, it goes to
                  whoever saved the view.
                </p>
              </Field>
            ) : null}
          </>
        ) : null}

        <FieldError>{error}</FieldError>

        {views.length > 0 ? (
          <div className="mt-10">
            <p className="font-mono text-[11px] leading-[1.4] font-bold tracking-[0.16em] text-foreground uppercase">
              Saved already
            </p>
            <ul className="mt-4">
              {views.map((view) => (
                <li
                  key={view.id}
                  className="flex min-h-12 items-center justify-between gap-4 border-b border-hairline-soft py-2"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate text-[15px] text-foreground">
                      {view.name || "Unnamed view"}
                    </span>
                    <span className="text-[13px] text-muted-foreground-2">
                      {scheduleLabel(view.schedule)}
                    </span>
                  </span>
                  <Button
                    variant="text-destructive"
                    onClick={() => remove.mutate(view.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SheetBody>
      <SheetFooter>
        <Button onClick={submit} loading={save.isPending} trailingArrow>
          Save view
        </Button>
        <Button variant="text" onClick={onDone}>
          Cancel
        </Button>
      </SheetFooter>
    </>
  )
}
