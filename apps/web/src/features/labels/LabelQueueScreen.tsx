/**
 * The label queue: what is waiting to print, and one button to send it.
 *
 * Printing is the browser's, with the counter PC's Chrome in kiosk mode and
 * the T003's Windows driver behind it (docs/label-spec.md). Nothing here
 * talks to the printer, so a phone can queue a label the counter then prints.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { displayCode, formatGBP, isValidCode, normaliseCode } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field, FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerCards } from "@/components/ui/sticker"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LABEL_SPECS } from "@/features/labels/layout"
import { refusalOrFallback } from "@/lib/api/refusal"
import { getItem, listLabelJobs, queueLabels } from "@/lib/api"
import type { LabelJobStatus } from "@/lib/api/types"

const FILTERS: { value: LabelJobStatus; label: string }[] = [
  { value: "queued", label: "Queued" },
  { value: "printed", label: "Printed" },
]

function templateName(key: keyof typeof LABEL_SPECS): string {
  const spec = LABEL_SPECS[key]
  return `${spec.widthMm} x ${spec.heightMm} mm`
}

export function LabelQueueScreen() {
  const navigate = useNavigate()
  const [status, setStatus] = React.useState<LabelJobStatus>("queued")
  const [reprint, setReprint] = React.useState("")
  const [reprintError, setReprintError] = React.useState<string | null>(null)

  const { data: jobs = [], refetch } = useQuery({
    queryKey: ["label-jobs-list", status],
    queryFn: () => listLabelJobs(status),
    staleTime: 10_000,
  })

  const queued = jobs.filter((job) => job.status === "queued")

  function printAll() {
    if (queued.length === 0) return
    void navigate({
      to: "/labels/print",
      search: { jobs: queued.map((job) => job.id).join(","), print: 1 },
    })
  }

  /** A code or a comma-separated run of them, queued again and printed. */
  const again = useMutation({
    mutationFn: async (codes: string[]) => {
      const itemIds: string[] = []
      for (const code of codes) {
        const item = await getItem(normaliseCode(code))
        if (!item) throw new Error(`${displayCode(code)} is not a code we hold.`)
        itemIds.push(item.id)
      }
      return queueLabels(itemIds)
    },
    onSuccess: (created) => {
      setReprint("")
      setReprintError(null)
      void refetch()
      void navigate({
        to: "/labels/print",
        search: { jobs: created.map((job) => job.id).join(","), print: 1 },
      })
    },
    onError: (error) =>
      setReprintError(
        refusalOrFallback(error, "Those labels could not be queued. Check the codes.")
      ),
  })

  function submitReprint() {
    const codes = reprint
      .split(/[,\s]+/)
      .map((code) => normaliseCode(code))
      .filter(Boolean)
    if (codes.length === 0) {
      setReprintError("Enter one code, or several separated by commas.")
      return
    }
    const bad = codes.find((code) => !isValidCode(code))
    if (bad) {
      setReprintError(`${bad} is not a GG code. Check the label and type it again.`)
      return
    }
    again.mutate(codes)
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Labels</PageTitle>
      <Lede>What is waiting to print, and anything worth printing again.</Lede>

      <div className="mt-14">
        <ChipGroup
          aria-label="Label jobs"
          value={[status]}
          onValueChange={(next) => {
            const chosen = next[0] as LabelJobStatus | undefined
            if (chosen) setStatus(chosen)
          }}
        >
          {FILTERS.map((filter) => (
            <Chip key={filter.value} value={filter.value}>
              {filter.label}
            </Chip>
          ))}
        </ChipGroup>
      </div>

      <div className="mt-12">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-start gap-6">
            <StickerCards />
            <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
              {status === "queued"
                ? "Nothing is waiting to print. Queue a label from an item page or after adding stock."
                : "No labels have been printed yet."}
            </p>
            <Button variant="text" render={<Link to="/counter/stock" />}>
              Go to stock
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Label</TableHead>
                <TableHead numeric>Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.title || "Untitled item"}</TableCell>
                  <TableCell className="tnum font-mono text-[13px]">
                    {job.code ? displayCode(job.code) : ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground-2">
                    {templateName(job.template)}
                  </TableCell>
                  <TableCell numeric>{formatGBP(job.price)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {queued.length > 0 ? (
        <div className="mt-14">
          <Button onClick={printAll} trailingArrow>
            Print all queued
          </Button>
        </div>
      ) : null}

      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Reprint
        </MicroLabel>
        <Field
          label="Codes"
          htmlFor="label-reprint"
          hint="Commas between"
        >
          <Input
            id="label-reprint"
            value={reprint}
            placeholder="GGS-7F3K2Q, GGS-T4M9PB"
            autoComplete="off"
            aria-invalid={reprintError ? true : undefined}
            onChange={(event) => {
              setReprint(event.target.value)
              setReprintError(null)
            }}
          />
        </Field>
        <FieldError>{reprintError}</FieldError>
        <div className="mt-8">
          <Button variant="text" loading={again.isPending} onClick={submitReprint}>
            Reprint
          </Button>
        </div>
      </div>
    </section>
  )
}
