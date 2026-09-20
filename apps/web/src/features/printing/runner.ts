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
 */
import * as React from "react"

import { labelLayout } from "@/features/labels/layout"
import { tsplBytes } from "@/features/printing/tspl"
import {
  chooseUsbPrinter,
  findUsbPrinter,
  PrinterError,
  sendToPrinter,
  usbPrintingSupported,
  type UsbPrinter,
} from "@/features/printing/usb"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  claimLabelJobs,
  markJobFailed,
  markJobPrinted,
  subscribeLabelJobs,
} from "@/lib/api/label-queue"
import type { LabelTemplateKey } from "@/lib/api/types"

const NAME_KEY = "gg-printer-name"
const AUTO_KEY = "gg-printer-auto"
const ROLL_KEY = "gg-printer-roll"

/** What a counter PC is called in the queue when nobody has named it. */
export const DEFAULT_PRINTER_NAME = "Counter PC"

/** Whatever size is on the printer: "any" claims every label in the queue. */
export type RollChoice = LabelTemplateKey | "any"

/** How many jobs one device takes at a time. A roll change is never far off. */
const CLAIM_LIMIT = 5
const POLL_MS = 5000

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
  const [roll, setRollState] = React.useState<RollChoice>(
    () => read(ROLL_KEY, "any") as RollChoice
  )
  const [busy, setBusy] = React.useState(false)
  const [printed, setPrinted] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  // The screen's own re-read, held in a ref so changing it never restarts
  // the runner mid-label.
  const changed = React.useRef(onChange)
  React.useEffect(() => {
    changed.current = onChange
  }, [onChange])

  /**
   * A printer this browser was already given comes back on its own, with
   * nothing to press, but only where auto-print was left on: opening a
   * device somebody has not asked us to open is not ours to do.
   */
  React.useEffect(() => {
    if (!supported || !auto) return undefined
    let live = true
    void findUsbPrinter().then((found) => {
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

    async function pump() {
      if (!live || running || !printer) return
      running = true
      setBusy(true)
      try {
        const jobs = await claimLabelJobs(
          deviceName,
          CLAIM_LIMIT,
          roll === "any" ? undefined : [roll]
        )
        if (jobs.length > 0) changed.current()
        for (const job of jobs) {
          if (!live) break
          try {
            await sendToPrinter(
              printer,
              tsplBytes(labelLayout(job), { copies: job.copies })
            )
            await markJobPrinted(job.id)
            setPrinted((count) => count + 1)
            setError(null)
          } catch (fault) {
            const message =
              fault instanceof Error
                ? fault.message
                : "The label did not print. Check the printer."
            await markJobFailed(job.id, message).catch(() => undefined)
            setError(message)
            // Nothing to print to: the switch goes off rather than grinding
            // the rest of the queue through a printer that is not there.
            if (
              fault instanceof PrinterError &&
              (fault.fault === "disconnected" || fault.fault === "not_bound")
            ) {
              setPrinter(null)
              setAutoState(false)
              write(AUTO_KEY, "")
            }
            break
          }
        }
        if (jobs.length > 0) changed.current()
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
    const stop = subscribeLabelJobs(() => void pump())
    return () => {
      live = false
      window.clearInterval(timer)
      stop()
    }
  }, [printer, auto, deviceName, roll])

  function connect() {
    setConnecting(true)
    setError(null)
    void chooseUsbPrinter()
      .then((found) => setPrinter(found))
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
      setPrinter(null)
      setAutoState(false)
      write(AUTO_KEY, "")
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
