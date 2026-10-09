/**
 * Settings, Printers: the counter's receipt printers
 * (docs/api-contract-epos.md, section 6).
 *
 * A Star TSP143IV or mC-Print3 on the shop's network collects its own jobs
 * from this server, so the Mac and the tablet print to the same machine and
 * open the same drawer. Nothing here talks to a printer: it adds one (and
 * shows the URL to type into it, once), rotates that URL, sends a test print
 * through the same queue a receipt uses, and removes it.
 *
 * The settings screen puts the heading above this, as it does for the card
 * reader, so this renders the body only. Admin only: the server refuses
 * everyone else, and the page says so rather than showing buttons that fail.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Printer } from "@gg/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { dotsFor } from "@/features/printing/receipt/draw"
import {
  EMPTY_PRINTER_FORM,
  lastSeenText,
  normaliseMac,
  printerMeta,
  validatePrinterForm,
  type PrinterForm,
} from "@/features/printing/printers"
import { useStaff } from "@/lib/auth"
import {
  createPrinter,
  listPrinters,
  listRegisters,
  PRINTERS_KEY,
  printingMessage,
  removePrinter,
  rotatePrinter,
  sendPrintJob,
} from "@/lib/api/printing"

/** Where the URL goes on the printer. */
const WHERE_IT_GOES = "Printer web settings, CloudPRNT, Server URL. Polling time 2 seconds."

/** A URL shown once, after adding a printer or rotating its URL. */
interface Reveal {
  printer: Printer
  url: string
  rotated: boolean
}

type Confirm = { id: string; action: "rotate" | "remove" }

const NOTE = "text-[13px] leading-[1.45] text-muted-foreground-2"

export function PrintersSection() {
  const staff = useStaff()
  const queryClient = useQueryClient()

  const [adding, setAdding] = React.useState(false)
  const [reveal, setReveal] = React.useState<Reveal | null>(null)
  const [confirm, setConfirm] = React.useState<Confirm | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const printers = useQuery({
    queryKey: PRINTERS_KEY,
    queryFn: listPrinters,
    staleTime: 5_000,
    // "Online" is a thirty second window; keep the page honest about it.
    refetchInterval: 15_000,
    retry: false,
  })
  const registers = useQuery({
    queryKey: ["registers"],
    queryFn: listRegisters,
    staleTime: 60_000,
    retry: false,
  })

  const refresh = () => void queryClient.invalidateQueries({ queryKey: PRINTERS_KEY })

  const rotate = useMutation({
    mutationFn: (printer: Printer) => rotatePrinter(printer.id),
    onSuccess: (result) => {
      setConfirm(null)
      setError(null)
      setNote(null)
      setReveal({ printer: result.printer, url: result.url, rotated: true })
      refresh()
    },
    onError: (fault) => {
      setNote(null)
      setError(printingMessage(fault, "The URL could not be changed. Try again."))
    },
  })

  const remove = useMutation({
    mutationFn: (printer: Printer) => removePrinter(printer.id),
    onSuccess: (_result, printer) => {
      setConfirm(null)
      setError(null)
      setNote(`${printer.name} has been removed.`)
      refresh()
    },
    onError: (fault) => {
      setNote(null)
      setError(printingMessage(fault, "The printer could not be removed. Try again."))
    },
  })

  const test = useMutation({
    mutationFn: async (printer: Printer) => {
      // The painter carries bwip-js, so it loads when somebody asks for a print.
      const { renderTestImage } = await import("@/features/printing/receipt/render")
      const image = await renderTestImage({
        width: dotsFor(printer.paper_width),
        printerName: printer.name,
      })
      return sendPrintJob({ printer: printer.id, kind: "test", image })
    },
    onSuccess: (_job, printer) => {
      setError(null)
      setNote(`Test print sent to ${printer.name}. It prints within a few seconds.`)
    },
    onError: (fault) => {
      setNote(null)
      setError(
        printingMessage(
          fault,
          "The test print did not reach the printer. Check the URL on the printer, then try again."
        )
      )
    },
  })

  if (staff?.role !== "admin") {
    return (
      <p data-testid="printers-section" className={`max-w-[56ch] ${NOTE}`}>
        Only an admin can set up the receipt printers. Ask an admin to add one.
      </p>
    )
  }

  const list = printers.data ?? []

  return (
    <div data-testid="printers-section">
      <p className={`mb-8 max-w-[56ch] ${NOTE}`}>
        A receipt printer on the shop&apos;s network collects its own jobs from GG Vault, so the Mac and
        the tablet both print to it and both open its drawer.
      </p>

      {printers.isError ? (
        <p
          role="alert"
          data-testid="printers-error"
          className="max-w-[56ch] text-[15px] leading-[1.5] text-destructive"
        >
          {printingMessage(
            printers.error,
            "The printers could not be read. Check the connection and try again."
          )}
        </p>
      ) : printers.isPending ? (
        <p className="text-[15px] text-muted-foreground-2">Reading the printers.</p>
      ) : list.length === 0 ? (
        <p
          data-testid="printers-empty"
          className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground"
        >
          No printer is set up yet. Until one is, receipts print in the browser and the drawer opens
          with its key.
        </p>
      ) : (
        <ul data-testid="printer-list">
          {list.map((printer) => (
            <PrinterRow
              key={printer.id}
              printer={printer}
              confirm={confirm?.id === printer.id ? confirm.action : null}
              busy={{
                test: test.isPending && test.variables?.id === printer.id,
                rotate: rotate.isPending && rotate.variables?.id === printer.id,
                remove: remove.isPending && remove.variables?.id === printer.id,
              }}
              onTest={() => test.mutate(printer)}
              onAsk={(action) => {
                setConfirm({ id: printer.id, action })
                setNote(null)
                setError(null)
              }}
              onCancel={() => setConfirm(null)}
              onRotate={() => rotate.mutate(printer)}
              onRemove={() => remove.mutate(printer)}
            />
          ))}
        </ul>
      )}

      <FieldError>{error}</FieldError>
      {note && !error ? (
        <p
          data-testid="printers-note"
          aria-live="polite"
          className="mt-6 text-[13px] text-muted-foreground"
        >
          {note}
        </p>
      ) : null}

      <div className="mt-8">
        <Button
          variant="text"
          type="button"
          data-testid="add-printer"
          onClick={() => {
            setReveal(null)
            setAdding(true)
          }}
        >
          Add printer
        </Button>
      </div>

      <PrinterSheet
        open={adding || reveal !== null}
        reveal={reveal}
        registers={registers.data ?? []}
        onClose={() => {
          setAdding(false)
          setReveal(null)
        }}
        onAdded={(result) => {
          setAdding(false)
          setReveal({ printer: result.printer, url: result.url, rotated: false })
          setNote(null)
          setError(null)
          refresh()
        }}
      />
    </div>
  )
}

interface RowProps {
  printer: Printer
  confirm: "rotate" | "remove" | null
  busy: { test: boolean; rotate: boolean; remove: boolean }
  onTest: () => void
  onAsk: (action: "rotate" | "remove") => void
  onCancel: () => void
  onRotate: () => void
  onRemove: () => void
}

function PrinterRow({
  printer,
  confirm,
  busy,
  onTest,
  onAsk,
  onCancel,
  onRotate,
  onRemove,
}: RowProps) {
  const status = lastSeenText(printer)
  return (
    <li
      data-testid="printer-row"
      className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-hairline-soft py-4 first:border-t"
    >
      <span className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
        <span className="truncate text-[15px] text-foreground">{printer.name}</span>
        <span className={NOTE}>{printerMeta(printer)}</span>
        <span className="font-mono text-[13px] tnum text-muted-foreground-2">{printer.mac}</span>
      </span>

      <span data-testid="printer-status" className="flex items-center text-[15px]">
        {printer.online ? (
          <Badge variant="outline">{status}</Badge>
        ) : (
          <span className="text-muted-foreground">{status}</span>
        )}
      </span>

      {confirm ? (
        <span className="flex w-full flex-col gap-3" data-testid="printer-confirm">
          <span className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
            {confirm === "rotate"
              ? `Change the URL for ${printer.name}? It prints nothing until the new URL is typed into it.`
              : `Remove ${printer.name}? Its queue goes with it.`}
          </span>
          <span className="flex flex-wrap items-center gap-x-8 gap-y-2">
            {confirm === "rotate" ? (
              <Button variant="text" loading={busy.rotate} onClick={onRotate}>
                Change URL
              </Button>
            ) : (
              <Button variant="text-destructive" loading={busy.remove} onClick={onRemove}>
                Remove printer
              </Button>
            )}
            <Button variant="text" onClick={onCancel}>
              Keep it
            </Button>
          </span>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <Button variant="text" loading={busy.test} onClick={onTest}>
            <span className="sr-only">Test print on {printer.name}</span>
            <span aria-hidden="true">Test print</span>
          </Button>
          <Button variant="text" onClick={() => onAsk("rotate")}>
            <span className="sr-only">Rotate the URL for {printer.name}</span>
            <span aria-hidden="true">Rotate URL</span>
          </Button>
          <Button variant="text-destructive" onClick={() => onAsk("remove")}>
            <span className="sr-only">Remove {printer.name}</span>
            <span aria-hidden="true">Remove</span>
          </Button>
        </span>
      )}
    </li>
  )
}

interface SheetProps {
  open: boolean
  reveal: Reveal | null
  registers: { id: string; name: string }[]
  onClose: () => void
  onAdded: (result: { printer: Printer; url: string }) => void
}

/** The form that adds a printer, then, in the same sheet, the URL to type into it. */
function PrinterSheet({ open, reveal, registers, onClose, onAdded }: SheetProps) {
  const [form, setForm] = React.useState<PrinterForm>(EMPTY_PRINTER_FORM)
  const [showErrors, setShowErrors] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<"yes" | "failed" | null>(null)

  const registerId = form.register || registers[0]?.id || ""
  const effective: PrinterForm = { ...form, register: registerId }
  const errors = showErrors ? validatePrinterForm(effective) : {}

  const add = useMutation({
    mutationFn: () =>
      createPrinter({
        name: effective.name.trim(),
        mac: normaliseMac(effective.mac),
        register: registerId,
        paper_width: effective.paper === "58" ? 58 : 80,
        model: effective.model.trim() || undefined,
      }),
    onSuccess: (result) => {
      setForm(EMPTY_PRINTER_FORM)
      setShowErrors(false)
      setError(null)
      onAdded(result)
    },
    onError: (fault) => {
      setError(
        printingMessage(
          fault,
          "The printer could not be added. Check the details and try again."
        )
      )
    },
  })

  function close() {
    setShowErrors(false)
    setError(null)
    setCopied(null)
    onClose()
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied("yes")
    } catch {
      // A browser that refuses the clipboard: the URL is selectable on the page.
      setCopied("failed")
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) close()
      }}
    >
      <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
        {reveal ? (
          <>
            <SheetHeader>
              <SheetTitle>{reveal.rotated ? "New printer URL" : "Printer URL"}</SheetTitle>
              <SheetDescription>
                {reveal.rotated
                  ? `The old URL for ${reveal.printer.name} has stopped working. Type this one into the printer. It is shown once.`
                  : `${reveal.printer.name} is added. Type this URL into the printer. It is shown once, so copy it now.`}
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="flex flex-col gap-6">
                <p
                  data-testid="printer-url"
                  className="border-b border-hairline pb-3 font-mono text-[13px] leading-[1.6] break-all text-foreground select-all"
                >
                  {reveal.url}
                </p>
                <div className="flex items-center gap-6">
                  <Button
                    variant="text"
                    type="button"
                    data-testid="copy-printer-url"
                    onClick={() => void copy(reveal.url)}
                  >
                    {copied === "yes" ? "Copied" : "Copy URL"}
                  </Button>
                  {copied === "yes" ? (
                    <span aria-live="polite" className={NOTE}>
                      On the clipboard.
                    </span>
                  ) : null}
                  {copied === "failed" ? (
                    <span role="alert" className="text-[13px] text-destructive">
                      Your browser would not copy it. Select the URL and copy it by hand.
                    </span>
                  ) : null}
                </div>
                <p data-testid="printer-url-where" className="max-w-[44ch] text-[15px] leading-[1.5] text-muted-foreground">
                  {WHERE_IT_GOES}
                </p>
              </div>
            </SheetBody>
            <SheetFooter>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </SheetFooter>
          </>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>Add printer</SheetTitle>
              <SheetDescription>
                A Star TSP143IV or mC-Print3 on the shop&apos;s network. You get a URL to type into it
                next.
              </SheetDescription>
            </SheetHeader>
            <SheetBody>
              <div className="flex flex-col gap-8">
                <Field label="Name" htmlFor="printer-name" layout="stacked" error={errors.name}>
                  <Input
                    id="printer-name"
                    value={form.name}
                    maxLength={60}
                    autoComplete="off"
                    placeholder="Counter printer"
                    aria-invalid={Boolean(errors.name) || undefined}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </Field>

                <Field
                  label="MAC address"
                  hint="On the printer's label"
                  htmlFor="printer-mac"
                  layout="stacked"
                  error={errors.mac}
                >
                  <Input
                    id="printer-mac"
                    value={form.mac}
                    maxLength={17}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="00:11:e5:06:04:ff"
                    className="font-mono tnum"
                    aria-invalid={Boolean(errors.mac) || undefined}
                    onChange={(event) => setForm({ ...form, mac: event.target.value })}
                  />
                </Field>

                <Field
                  label="Register"
                  htmlFor="printer-register"
                  layout="stacked"
                  error={errors.register}
                >
                  <Select
                    value={registerId || null}
                    onValueChange={(next: string | null) => setForm({ ...form, register: next ?? "" })}
                  >
                    <SelectTrigger id="printer-register" aria-invalid={Boolean(errors.register) || undefined}>
                      <SelectValue placeholder="Choose a register">
                        {(value: string) =>
                          registers.find((row) => row.id === value)?.name ?? "Choose a register"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {registers.map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Paper width" htmlFor="printer-paper" layout="stacked">
                  <Select
                    value={form.paper}
                    onValueChange={(next: string | null) =>
                      setForm({ ...form, paper: next === "58" ? "58" : "80" })
                    }
                  >
                    <SelectTrigger id="printer-paper">
                      <SelectValue>
                        {(value: string) => (value === "58" ? "58 mm" : "80 mm")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="80">80 mm</SelectItem>
                      <SelectItem value="58">58 mm</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Model" hint="Optional" htmlFor="printer-model" layout="stacked">
                  <Input
                    id="printer-model"
                    value={form.model}
                    maxLength={60}
                    autoComplete="off"
                    placeholder="Star TSP143IV"
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                  />
                </Field>
              </div>
            </SheetBody>
            <SheetFooter>
              <Button
                type="button"
                trailingArrow
                loading={add.isPending}
                data-testid="save-printer"
                onClick={() => {
                  setShowErrors(true)
                  if (Object.keys(validatePrinterForm(effective)).length > 0) return
                  setError(null)
                  add.mutate()
                }}
              >
                Add printer
              </Button>
              <Button variant="text" type="button" onClick={close}>
                Cancel
              </Button>
              {error ? <FieldError>{error}</FieldError> : null}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
