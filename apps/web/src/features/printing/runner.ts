/**
 * The print queue runner: the counter PC's Chrome taking labels off the
 * queue and putting them through the T003 over USB.
 *
 * One device does the printing and every other device just queues, which is
 * the whole point of path 2 (docs/label-spec.md): a phone in the back room
 * can queue a label and the counter prints it. The claim route flips a job
 * to `printing` in one transaction, so two counters with a printer each
 * never take the same label twice.
 *
 * Two triggers, on purpose. The realtime subscription is the quick one, and
 * a five-second poll runs underneath it, so a socket that never connects
 * costs a few seconds rather than the label.
 *
 * The run itself is `printRun` below: a plain async function over injected
 * calls, so the rules that matter, that a label which came out is never
 * printed twice and that the rest of a batch is never abandoned, are unit
 * tested without a browser.
 */
import * as React from "react"

import { LABEL_SPECS, labelLayout } from "@/features/labels/layout"
import { LabelTooSmallError, tsplBytes } from "@/features/printing/tspl"
import {
  chooseUsbPrinter,
  findUsbPrinter,
  isRememberedPrinter,
  PrinterError,
  rememberPrinter,
  releasePrinter,
  sendToPrinter,
  usbPrintingSupported,
  type RememberedPrinter,
  type UsbPrinter,
} from "@/features/printing/usb"
import { isNotFound, refusalOrFallback } from "@/lib/api/refusal"
import {
  claimLabelJobs,
  markJobFailed,
  markJobPrinted,
  subscribeLabelJobs,
} from "@/lib/api/label-queue"
import type { LabelJobDetail, LabelTemplateKey } from "@/lib/api/types"

const NAME_KEY = "gg-printer-name"
const AUTO_KEY = "gg-printer-auto"
const ROLL_KEY = "gg-printer-roll"
const DEVICE_KEY = "gg-printer-device"

/** What a counter PC is called in the queue when nobody has named it. */
export const DEFAULT_PRINTER_NAME = "Counter PC"

/**
 * The roll on the printer. There is no "whatever is queued": one printer
 * has one size of stock on it, and printing a 25 x 15 sleeve label onto
 * 40 x 20 gap-sensed stock loses registration for the run after it too.
 */
export type RollChoice = LabelTemplateKey

/** The size the shop buys most of, and what the wizard gives most items. */
export const DEFAULT_ROLL: RollChoice = "toploader_40x20"

/** How many jobs one device takes at a time. A roll change is never far off. */
const CLAIM_LIMIT = 5
const POLL_MS = 5000
/** A burst of realtime events, including this device's own writes, is one pump. */
const EVENT_DEBOUNCE_MS = 250
/** `label_jobs.error` on the server. A longer sentence is refused outright. */
const ERROR_MAX = 300
/** How many times a printed label is reported before it is left for later. */
const MARK_ATTEMPTS = 3

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private browsing: the setting holds for this page load and no longer.
  }
}

function readRemembered(): RememberedPrinter | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<RememberedPrinter>
    if (typeof parsed?.vendorId !== "number") return null
    return {
      vendorId: parsed.vendorId,
      productId: parsed.productId ?? 0,
      serialNumber: parsed.serialNumber ?? "",
      name: parsed.name ?? "Label printer",
    }
  } catch {
    return null
  }
}

function isRoll(value: string): value is RollChoice {
  return value in LABEL_SPECS
}

export function labelTooLong(error: unknown): boolean {
  return error instanceof LabelTooSmallError
}

/** The server caps the reason it keeps, and a refused write loses it entirely. */
export function shortError(message: string): string {
  const trimmed = message.trim()
  if (trimmed.length <= ERROR_MAX) return trimmed
  return `${trimmed.slice(0, ERROR_MAX - 3)}...`
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface PrintRunCalls {
  /** Bytes to the printer. Only a failure here means the label did not print. */
  send: (job: LabelJobDetail) => Promise<void>
  markPrinted: (id: string) => Promise<void>
  markFailed: (id: string, error: string) => Promise<void>
  /** Called with each job that came out, so the screen can count them. */
  onPrinted?: (job: LabelJobDetail) => void
  /** How long to wait between tries at reporting a label that did print. */
  wait?: (ms: number) => Promise<void>
}

export interface PrintRunResult {
  printed: number
  /** Jobs whose label came out and whose report did not get through. */
  unreported: string[]
  /** The sentence for the screen, or null when the run went through. */
  error: string | null
  /** True where the printer itself is the problem, so auto-print stops. */
  printerLost: boolean
}

const PAUSE = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Print a claimed batch, one label at a time.
 *
 * The order matters and is the point of the function: the bytes go out, and
 * only then is the job reported. A report that fails after a label has come
 * out is retried and then left alone, never turned into a failure, because
 * the server would put the job back in the queue and the same label would
 * come out of the printer twice with nobody the wiser.
 *
 * A job that does fail to print stops the run, and the rest of the batch is
 * handed back rather than left reading "printing" on every other screen in
 * the shop until the unstick cron notices.
 */
export async function printRun(
  jobs: LabelJobDetail[],
  calls: PrintRunCalls
): Promise<PrintRunResult> {
  const wait = calls.wait ?? PAUSE
  const result: PrintRunResult = {
    printed: 0,
    unreported: [],
    error: null,
    printerLost: false,
  }

  for (const [index, job] of jobs.entries()) {
    try {
      await calls.send(job)
    } catch (fault) {
      const message =
        fault instanceof Error
          ? fault.message
          : "The label did not print. Check the printer."
      result.error = message
      result.printerLost =
        fault instanceof PrinterError &&
        (fault.fault === "disconnected" ||
          fault.fault === "not_bound" ||
          fault.fault === "busy_elsewhere")
      await calls.markFailed(job.id, shortError(message)).catch(() => undefined)
      // Everything still in hand goes back, so no other screen in the shop
      // is told this device is printing labels it has put down.
      for (const rest of jobs.slice(index + 1)) {
        await calls
          .markFailed(rest.id, "The printer stopped part way through the run")
          .catch(() => undefined)
      }
      return result
    }

    // The label is out of the printer. From here nothing may requeue it.
    let reported = false
    let refusal: unknown = null
    for (let attempt = 1; attempt <= MARK_ATTEMPTS && !reported; attempt += 1) {
      try {
        await calls.markPrinted(job.id)
        reported = true
      } catch (fault) {
        refusal = fault
        // A refusal is the server's answer, not a connection that dropped:
        // trying again would get the same answer.
        if (isRefusal(fault)) break
        if (attempt < MARK_ATTEMPTS) await wait(attempt * 200)
      }
    }

    if (reported) {
      result.printed += 1
      calls.onPrinted?.(job)
      continue
    }

    if (isRefusal(refusal)) {
      // The commonest is a job this device no longer holds, which the
      // server refuses on purpose: that label has come out twice and
      // somebody has to be told.
      result.error = refusalOrFallback(
        refusal,
        "That label came out, but the queue would not take it as printed. Check the label before printing it again."
      )
      result.printed += 1
      calls.onPrinted?.(job)
      continue
    }

    result.unreported.push(job.id)
    result.printed += 1
    calls.onPrinted?.(job)
    result.error =
      "The label printed but the queue was not told. It will be marked printed when the connection comes back."
  }

  return result
}

/** A server that answered, as opposed to a request that reached nobody. */
function isRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const status = (error as { status?: number }).status
  if (typeof status !== "number") return false
  return status >= 400 && status < 500 && !isNotFound(error)
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface PrintQueueRunner {
  /** Chrome on the counter PC has WebUSB; a phone and Safari do not. */
  supported: boolean
  printer: UsbPrinter | null
  connecting: boolean
  connect: () => void
  disconnect: () => void
  auto: boolean
  setAuto: (on: boolean) => void
  /** What this device is called in the queue, so staff can see who has a job. */
  deviceName: string
  setDeviceName: (name: string) => void
  roll: RollChoice
  setRoll: (roll: RollChoice) => void
  /** Printing right now. */
  busy: boolean
  /** How many this device has printed since the screen was opened. */
  printed: number
  error: string | null
  clearError: () => void
}

export function usePrintQueue(onChange: () => void): PrintQueueRunner {
  const supported = usbPrintingSupported()
  const [printer, setPrinter] = React.useState<UsbPrinter | null>(null)
  const [connecting, setConnecting] = React.useState(false)
  const [auto, setAutoState] = React.useState(() => read(AUTO_KEY, "") === "1")
  const [deviceName, setNameState] = React.useState(() =>
    read(NAME_KEY, DEFAULT_PRINTER_NAME)
  )
  const [roll, setRollState] = React.useState<RollChoice>(() => {
    const stored = read(ROLL_KEY, DEFAULT_ROLL)
    return isRoll(stored) ? stored : DEFAULT_ROLL
  })
  const [busy, setBusy] = React.useState(false)
  const [printed, setPrinted] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  // The screen's own re-read, held in a ref so changing it never restarts
  // the runner mid-label.
  const changed = React.useRef(onChange)
  React.useEffect(() => {
    changed.current = onChange
  }, [onChange])

  // Labels that came out and could not be reported. The next pump reports
  // them before it claims anything else.
  const unreported = React.useRef<string[]>([])

  // The open device, for the one cleanup that has to happen whatever else
  // is going on: leaving the screen hands the printer back.
  const held = React.useRef<UsbPrinter | null>(null)
  React.useEffect(() => {
    held.current = printer
  }, [printer])
  React.useEffect(() => {
    return () => {
      const open = held.current
      if (open) void releasePrinter(open)
    }
  }, [])

  /**
   * A printer this browser was already given comes back on its own, with
   * nothing to press, but only the one that was chosen and only where
   * auto-print was left on. Opening a device nobody asked us to open is
   * not ours to do.
   */
  React.useEffect(() => {
    if (!supported || !auto) return undefined
    let live = true
    void findUsbPrinter(readRemembered()).then((found) => {
      if (live && found) setPrinter((current) => current ?? found)
    })
    return () => {
      live = false
    }
  }, [supported, auto])

  React.useEffect(() => {
    if (!printer || !auto) return undefined
    let live = true
    let running = false
    let debounce = 0

    async function settleUnreported() {
      if (unreported.current.length === 0) return
      const waiting = [...unreported.current]
      unreported.current = []
      for (const id of waiting) {
        try {
          await markJobPrinted(id)
        } catch (fault) {
          // A refusal is an answer: the job has moved on and this device
          // has already said what it printed.
          if (!isRefusal(fault)) unreported.current.push(id)
        }
      }
    }

    async function pump() {
      if (!live || running || !printer) return
      running = true
      try {
        await settleUnreported()
        const jobs = await claimLabelJobs(deviceName, CLAIM_LIMIT, [roll])
        if (jobs.length === 0) return
        setBusy(true)
        changed.current()

        const run = await printRun(jobs, {
          send: async (job) => {
            // The app draws from its own table of sizes. Where the server
            // has a template at some other size, the label would come out
            // wrong with nothing to say so, which is worse than stopping.
            const spec = LABEL_SPECS[job.template]
            if (
              spec &&
              job.templateWidthMm &&
              job.templateHeightMm &&
              (job.templateWidthMm !== spec.widthMm ||
                job.templateHeightMm !== spec.heightMm)
            ) {
              throw new Error(
                `The server has this label at ${job.templateWidthMm} x ${job.templateHeightMm} mm and this app at ${spec.widthMm} x ${spec.heightMm} mm. Print it with the Print button until the two agree.`
              )
            }
            // A code too long for its label is the job's fault, not the
            // printer's, so it is reported as a failure of that one label.
            const bytes = tsplBytes(labelLayout(job), { copies: job.copies })
            await sendToPrinter(printer as UsbPrinter, bytes)
          },
          markPrinted: async (id) => {
            await markJobPrinted(id)
          },
          markFailed: async (id, message) => {
            await markJobFailed(id, message)
          },
          onPrinted: () => setPrinted((count) => count + 1),
        })

        unreported.current.push(...run.unreported)
        setError(run.error)
        if (run.printerLost) {
          // Nothing to print to: the switch goes off rather than grinding
          // the rest of the queue through a printer that is not there.
          setPrinter(null)
          setAutoState(false)
          write(AUTO_KEY, "")
        }
        changed.current()
      } catch (fault) {
        setError(
          refusalOrFallback(
            fault,
            "The print queue could not be read. Check the connection and try again."
          )
        )
      } finally {
        running = false
        setBusy(false)
      }
    }

    void pump()
    const timer = window.setInterval(() => void pump(), POLL_MS)
    // The subscription sees this device's own writes too, so a batch would
    // otherwise pump once per label it just printed.
    const stop = subscribeLabelJobs(() => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => void pump(), EVENT_DEBOUNCE_MS)
    })
    return () => {
      live = false
      window.clearInterval(timer)
      window.clearTimeout(debounce)
      stop()
    }
  }, [printer, auto, deviceName, roll])

  function connect() {
    setConnecting(true)
    setError(null)
    void chooseUsbPrinter()
      .then((found) => {
        // Which device was chosen, so tomorrow morning the right one comes
        // back rather than the first that answers.
        write(DEVICE_KEY, JSON.stringify(rememberPrinter(found)))
        setPrinter(found)
      })
      .catch((fault: unknown) => {
        setError(
          fault instanceof Error
            ? fault.message
            : "The printer could not be opened. Try again."
        )
      })
      .finally(() => setConnecting(false))
  }

  return {
    supported,
    printer,
    connecting,
    connect,
    disconnect: () => {
      const open = printer
      setPrinter(null)
      setAutoState(false)
      write(AUTO_KEY, "")
      write(DEVICE_KEY, "")
      // Hand the interface back and drop the browser's own permission, so
      // "Forget this printer" is true and another tab can have it.
      if (open) void releasePrinter(open, { forget: true })
    },
    auto,
    setAuto: (on: boolean) => {
      setAutoState(on)
      write(AUTO_KEY, on ? "1" : "")
      if (on) setError(null)
    },
    deviceName,
    setDeviceName: (name: string) => {
      const trimmed = name.trim().slice(0, 60) || DEFAULT_PRINTER_NAME
      setNameState(trimmed)
      write(NAME_KEY, trimmed)
    },
    roll,
    setRoll: (next: RollChoice) => {
      setRollState(next)
      write(ROLL_KEY, next)
    },
    busy,
    printed,
    error,
    clearError: () => setError(null),
  }
}

/** Re-exported so the queue screen can list the rolls without a second table. */
export { isRememberedPrinter }
