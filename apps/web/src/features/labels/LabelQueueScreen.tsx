/**
 * The label queue: what is waiting to print, which device is printing it,
 * and anything worth printing again.
 *
 * Two printing paths stand side by side here, on purpose (docs/label-spec.md).
 * Path 1 is the browser's: the Print button opens `/labels/print`, which the
 * counter PC's Chrome prints with no dialog. Path 2 is this screen's own
 * runner: with a printer connected and auto-print on, the counter PC claims
 * jobs and sends TSPL2 straight down the USB cable, so a label queued on a
 * phone in the back room comes out at the till.
 */
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { displayCode, formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Hint, MicroLabel } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
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
import { StickerCards } from "@/components/ui/sticker"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LABEL_SPECS, nextPrintBatch } from "@/features/labels/layout"
import { BulkReprintSheet } from "@/features/labels/BulkReprintSheet"
import { usePrintQueue, type RollChoice } from "@/features/printing/runner"
import { refusalOrFallback } from "@/lib/api/refusal"
import { listLabelJobs } from "@/lib/api"
import { requeueLabelJob } from "@/lib/api/label-queue"
import type { LabelJobDetail, LabelJobStatus, LabelTemplateKey } from "@/lib/api/types"

type QueueView = "waiting" | "printed" | "failed"

const VIEWS: { value: QueueView; label: string; statuses: LabelJobStatus[] }[] = [
  { value: "waiting", label: "Waiting", statuses: ["queued", "printing"] },
  { value: "printed", label: "Printed", statuses: ["printed"] },
  { value: "failed", label: "Failed", statuses: ["failed"] },
]

const ROLLS: { value: RollChoice; label: string }[] = [
  { value: "any", label: "Whatever is queued" },
  ...(Object.keys(LABEL_SPECS) as LabelTemplateKey[]).map((key) => ({
    value: key as RollChoice,
    label: templateName(key),
  })),
]

function templateName(key: LabelTemplateKey): string {
  const spec = LABEL_SPECS[key]
  return `${spec.widthMm} x ${spec.heightMm} mm`
}

function emptyLine(view: QueueView): string {
  if (view === "printed") return "No labels have been printed yet."
  if (view === "failed") return "No labels have failed. Nothing to look at here."
  return "Nothing is waiting to print. Queue a label from an item page, or reprint a run below."
}

/**
 * The one device that has the printer: what it is called in the queue, and
 * which roll is on it, so it only claims labels that size.
 */
function PrinterSheet({
  open,
  onOpenChange,
  deviceName,
  onDeviceName,
  roll,
  onRoll,
  onDisconnect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceName: string
  onDeviceName: (name: string) => void
  roll: RollChoice
  onRoll: (roll: RollChoice) => void
  onDisconnect: () => void
}) {
  const [name, setName] = React.useState(deviceName)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="printer-sheet"
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>This printer</SheetTitle>
          <SheetDescription>
            What the queue calls this device, and what is on the roll.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-col gap-8">
            <Field
              label="Device name"
              htmlFor="printer-name"
              layout="stacked"
              hint="Shown in the queue"
            >
              <Input
                id="printer-name"
                value={name}
                maxLength={60}
                autoComplete="off"
                placeholder="Counter PC"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Roll loaded" htmlFor="printer-roll" layout="stacked">
              <Select
                value={roll}
                onValueChange={(next: string | null) =>
                  onRoll((next ?? "any") as RollChoice)
                }
              >
                <SelectTrigger id="printer-roll">
                  <SelectValue placeholder="Whatever is queued">
                    {(value: string) =>
                      ROLLS.find((row) => row.value === value)?.label ??
                      "Whatever is queued"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ROLLS.map((row) => (
                    <SelectItem key={row.value} value={row.value}>
                      {row.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
                With a size chosen, this printer takes only labels that size and
                leaves the rest for whoever has that roll on.
              </p>
            </Field>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            trailingArrow
            onClick={() => {
              onDeviceName(name)
              onOpenChange(false)
            }}
          >
            Save
          </Button>
          <Button
            variant="text-destructive"
            onClick={() => {
              onDisconnect()
              onOpenChange(false)
            }}
          >
            Forget this printer
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function LabelQueueScreen() {
  const navigate = useNavigate()
  const [view, setView] = React.useState<QueueView>("waiting")
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [printerOpen, setPrinterOpen] = React.useState(false)
  const [requeueError, setRequeueError] = React.useState<string | null>(null)

  const statuses = VIEWS.find((entry) => entry.value === view)?.statuses ?? []
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ["label-jobs-list", view],
    queryFn: () => listLabelJobs(statuses),
    staleTime: 10_000,
  })

  const reread = React.useCallback(() => {
    void refetch()
  }, [refetch])

  const printQueue = usePrintQueue(reread)

  const queued = jobs.filter((job) => job.status === "queued")

  // One print run is one label size, oldest first; the rest wait for the
  // roll to be changed over.
  const batch = nextPrintBatch(queued)

  function printAll() {
    if (batch.jobs.length === 0) return
    void navigate({
      to: "/labels/print",
      search: { jobs: batch.jobs.map((job) => job.id).join(","), print: 1 },
    })
  }

  const again = useMutation({
    mutationFn: (id: string) => requeueLabelJob(id),
    onSuccess: () => {
      setRequeueError(null)
      reread()
    },
    onError: (error) =>
      setRequeueError(
        refusalOrFallback(error, "That label could not be queued again. Try again.")
      ),
  })

  /** The grey line under a job's title: who has it, or why it stopped. */
  function jobNote(job: LabelJobDetail): string {
    if (job.status === "printing") {
      return job.printer ? `Printing on ${job.printer}` : "Printing"
    }
    if (job.error) return job.error
    return ""
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Labels</PageTitle>
      <Lede>What is waiting to print, and anything worth printing again.</Lede>

      {/* ---- This device's printer ---- */}
      <div className="mt-14">
        <MicroLabel tone="ink" className="mb-5">
          Printer
        </MicroLabel>

        {!printQueue.supported ? (
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
            Queued for the counter printer. This device cannot print over USB,
            so anything queued here comes out at the till.
          </p>
        ) : printQueue.printer ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <span
                data-testid="printer-name"
                className="text-[15px] text-foreground"
              >
                {printQueue.printer.name}
              </span>
              <span className="flex items-center gap-4">
                <Switch
                  checked={printQueue.auto}
                  onCheckedChange={printQueue.setAuto}
                  aria-label="Auto-print"
                />
                <span data-testid="auto-print" className="text-[15px] text-foreground">
                  {printQueue.auto ? "Auto-print on" : "Auto-print off"}
                </span>
              </span>
              <Button variant="text" onClick={() => setPrinterOpen(true)}>
                Printer settings
              </Button>
            </div>
            <Hint>
              {printQueue.deviceName}
              {printQueue.roll === "any"
                ? ""
                : ` · ${templateName(printQueue.roll as LabelTemplateKey)}`}
              {printQueue.busy ? " · Printing" : ""}
              {printQueue.printed > 0
                ? ` · ${printQueue.printed} printed here`
                : ""}
            </Hint>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Button
              variant="text"
              data-testid="connect-printer"
              loading={printQueue.connecting}
              onClick={printQueue.connect}
            >
              Connect printer
            </Button>
            <p className="text-[13px] text-muted-foreground-2">
              Chrome asks once and then remembers the T003.
            </p>
          </div>
        )}

        {printQueue.error ? (
          <p
            role="alert"
            data-testid="printer-error"
            className="mt-4 max-w-[56ch] text-[13px] leading-[1.45] text-destructive"
          >
            {printQueue.error}
          </p>
        ) : null}
      </div>

      {/* ---- The queue ---- */}
      <div className="mt-24">
        <ChipGroup
          aria-label="Label jobs"
          value={[view]}
          onValueChange={(next: string[]) => {
            const chosen = next[0] as QueueView | undefined
            if (chosen) setView(chosen)
          }}
        >
          {VIEWS.map((entry) => (
            <Chip key={entry.value} value={entry.value}>
              {entry.label}
            </Chip>
          ))}
        </ChipGroup>

        <div className="mt-12">
          {jobs.length === 0 ? (
            <div className="flex flex-col items-start gap-6">
              <StickerCards />
              <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
                {emptyLine(view)}
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
                  <TableRow key={job.id} data-testid="label-row">
                    <TableCell>
                      <span className="block text-foreground">
                        {job.title || "Untitled item"}
                      </span>
                      {jobNote(job) ? (
                        <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="text-[13px] text-muted-foreground-2">
                            {jobNote(job)}
                          </span>
                          {job.status === "failed" ? (
                            <Button
                              variant="text"
                              loading={again.isPending}
                              onClick={() => again.mutate(job.id)}
                            >
                              Queue again
                            </Button>
                          ) : null}
                        </span>
                      ) : null}
                    </TableCell>
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

        {requeueError ? (
          <p role="alert" className="mt-6 text-[13px] text-destructive">
            {requeueError}
          </p>
        ) : null}

        {batch.jobs.length > 0 ? (
          <div className="mt-14 flex flex-wrap items-center gap-x-8 gap-y-3">
            <Button onClick={printAll} trailingArrow data-testid="print-all">
              {batch.waiting > 0 && batch.template
                ? `Print ${batch.jobs.length} on ${templateName(batch.template)}`
                : "Print all queued"}
            </Button>
            {batch.waiting > 0 ? (
              <p className="text-[13px] text-muted-foreground-2">
                {batch.waiting} more on other label sizes. Change the roll and
                print again.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---- Reprint ---- */}
      <div className="mt-24">
        <MicroLabel tone="ink" className="mb-5">
          Reprint
        </MicroLabel>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Button
            variant="text"
            data-testid="bulk-reprint"
            onClick={() => setBulkOpen(true)}
          >
            Reprint labels
          </Button>
          <p className="max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            A whole buy-in, everything that came in between two dates, or the
            labels you have in your hand.
          </p>
        </div>
      </div>

      <BulkReprintSheet
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onQueued={reread}
      />

      <PrinterSheet
        open={printerOpen}
        onOpenChange={setPrinterOpen}
        deviceName={printQueue.deviceName}
        onDeviceName={printQueue.setDeviceName}
        roll={printQueue.roll}
        onRoll={printQueue.setRoll}
        onDisconnect={printQueue.disconnect}
      />
    </section>
  )
}
