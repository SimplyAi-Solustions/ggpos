/**
 * The Niimbot D110 price label printer, reached from the page over Web
 * Bluetooth through niimbluelib (the library behind niim.blue).
 *
 * There is no driver and no helper program: Chrome or Edge on the Mac mini
 * talks to the printer itself. The first print in a browser session asks the
 * staff member to pick the printer from Chrome's list (Web Bluetooth only
 * shows that list from a click); after that the connection stays open while
 * the tab does, and every page that prints shares it. Only one thing can be
 * connected to the printer at a time, so the NIIMBOT app, or anything else
 * holding it, has to let go first.
 *
 * The library is about 120 KB and only the counter Mac needs it, so it loads
 * when a price label sheet opens rather than with the app. The print run
 * itself is `printOnClient` below, over a structural client, so the order of
 * things that matters (heartbeat off, every page waited for, the print ended
 * and the heartbeat back on whatever happens) is unit tested without a
 * printer.
 */
import * as React from "react"
import type {
  ImageSource,
  PrintDirection,
  PrintOptions,
  PrintTaskName,
} from "@mmote/niimbluelib"

type Library = typeof import("@mmote/niimbluelib")

let library: Promise<Library> | null = null

/** The library, fetched once. Called when a sheet opens so a click never waits for it. */
export function loadPrinterLibrary(): Promise<Library> {
  library ??= import("@mmote/niimbluelib")
  return library
}

// ---------------------------------------------------------------------------
// What can go wrong, in words
// ---------------------------------------------------------------------------

export type LabelPrinterFault =
  | "unsupported"
  | "cancelled"
  | "bluetooth_off"
  | "not_allowed"
  | "no_answer"
  | "not_connected"
  | "disconnected"
  | "no_labels"
  | "wrong_labels"
  | "cover_open"
  | "battery"
  | "busy"
  | "timeout"
  | "failed"

/** Every sentence the counter can show about the label printer, in one place. */
export const LABEL_PRINTER_MESSAGES: Record<LabelPrinterFault, string> = {
  unsupported:
    "This browser cannot reach a Bluetooth printer. Open GG Vault in Chrome or Edge on the Mac mini. In Brave, switch on Web Bluetooth API at brave://flags, then relaunch it.",
  cancelled: "No printer was chosen. Press Connect printer and pick the D110 from the list.",
  bluetooth_off: "Bluetooth is off on this computer. Turn it on, then press Connect printer again.",
  not_allowed:
    "The browser is not allowed to use Bluetooth. On the Mac, open System Settings, Privacy and Security, Bluetooth, and switch the browser on. Then press Connect printer again.",
  no_answer:
    "The printer did not answer. Check it is on and nearby, and that the NIIMBOT app is not connected to it, then press Connect printer again.",
  not_connected: "The printer is not connected. Press Connect printer first.",
  disconnected:
    "The printer stopped answering part way through. Check it is on and nearby, connect it again, then print what is left.",
  no_labels: "The printer has run out of labels. Load a roll, then print again.",
  wrong_labels: "The printer does not recognise the roll. Load a NIIMBOT D110 roll, then print again.",
  cover_open: "The printer's lid is open. Close it, then print again.",
  battery: "The printer's battery is too low to print. Charge it, then print again.",
  busy: "The printer is busy with another print. Wait for it to finish, then print again.",
  timeout:
    "The printer took too long to finish. Check the roll is seated and the lid is shut, then print again.",
  failed: "The printer would not take the labels. Check it is on and has labels in it, then print again.",
}

export class LabelPrinterError extends Error {
  readonly fault: LabelPrinterFault
  /** Labels that came out before it stopped. */
  readonly printed: number

  constructor(fault: LabelPrinterFault, printed = 0) {
    super(LABEL_PRINTER_MESSAGES[fault])
    this.name = "LabelPrinterError"
    this.fault = fault
    this.printed = printed
  }
}

/** The printer's own reasons (niimbluelib's `PrinterErrorCode`), by number. */
const PRINTER_REASONS: Record<number, LabelPrinterFault> = {
  1: "cover_open",
  2: "no_labels",
  3: "battery",
  4: "battery",
  8: "no_labels",
  9: "busy",
  16: "wrong_labels",
  22: "disconnected",
  23: "disconnected",
  28: "no_labels",
  32: "wrong_labels",
}

/**
 * What went wrong, in words a staff member can act on. Chrome names its
 * Bluetooth failures by DOMException name; the printer's own refusals arrive
 * as a `PrintError` carrying a reason number.
 */
export function describeLabelPrinterError(
  error: unknown,
  stage: "connect" | "print",
  printed = 0
): LabelPrinterError {
  if (error instanceof LabelPrinterError) return error
  const fail = (fault: LabelPrinterFault) => new LabelPrinterError(fault, printed)
  const name = error instanceof Error ? error.name : ""
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  const reason = (error as { reasonId?: unknown } | null)?.reasonId

  if (typeof reason === "number") return fail(PRINTER_REASONS[reason] ?? "failed")
  if (name === "NotFoundError") return fail(text.includes("adapter") ? "bluetooth_off" : "cancelled")
  if (name === "NotAllowedError" || name === "SecurityError") {
    // A picker asked for outside a click is the code's mistake, not a setting.
    return fail(text.includes("gesture") ? "cancelled" : "not_allowed")
  }
  if (text.includes("timeout")) return fail(stage === "connect" ? "no_answer" : "timeout")
  if (name === "NetworkError" || text.includes("gatt") || text.includes("closed") || text.includes("disconnect")) {
    return fail(stage === "connect" ? "no_answer" : "disconnected")
  }
  return fail(stage === "connect" ? "no_answer" : "failed")
}

// ---------------------------------------------------------------------------
// The print run
// ---------------------------------------------------------------------------

/** One label and how many of it. */
export interface LabelPage {
  source: ImageSource
  copies: number
}

export type Darkness = "light" | "normal" | "dark"

/** The part of a niimbluelib print task the run uses. */
export interface PrintTaskLike {
  printInit(): Promise<void>
  printPage(image: ReturnType<Library["ImageEncoder"]["encode"]>, quantity?: number): Promise<void>
  waitForPageFinished(): Promise<void>
  waitForFinished(): Promise<void>
  printEnd(): Promise<boolean>
}

/** The part of a niimbluelib client the run uses. */
export interface PrinterClientLike {
  protocol: { newPrintTask(name: PrintTaskName, options?: Partial<PrintOptions>): PrintTaskLike }
  getModelMetadata():
    | { printDirection: PrintDirection; densityMin: number; densityMax: number; densityDefault: number }
    | undefined
  getPrintTaskType(): PrintTaskName | undefined
  isConnected(): boolean
  stopHeartbeat(): void
  startHeartbeat(): void
}

/** The darkness asked for, as the printer model's own density figure. */
export function densityFor(
  darkness: Darkness,
  meta: { densityMin: number; densityMax: number; densityDefault: number } | undefined
): number {
  const min = meta?.densityMin ?? 1
  const max = meta?.densityMax ?? 3
  if (darkness === "light") return min
  if (darkness === "dark") return max
  return Math.min(max, Math.max(min, meta?.densityDefault ?? 2))
}

/**
 * Print `pages` on a connected client, each `copies` times, in order, as
 * niim.blue does: the heartbeat stops while the printer is busy, every page
 * is waited for before the next is sent, and the print is ended and the
 * heartbeat started again whatever happens, so a lid opened half way leaves
 * the printer ready for the next try. `onProgress` hears the running count.
 * A failure says how many labels came out before it.
 */
export async function printOnClient(
  lib: Pick<Library, "ImageEncoder" | "LabelType" | "PageColorType">,
  client: PrinterClientLike,
  pages: readonly LabelPage[],
  darkness: Darkness,
  onProgress?: (printed: number, total: number) => void
): Promise<number> {
  const wanted = pages.filter((page) => page.copies > 0)
  const total = wanted.reduce((sum, page) => sum + page.copies, 0)
  if (total === 0) return 0
  if (!client.isConnected()) throw new LabelPrinterError("not_connected")

  const meta = client.getModelMetadata()
  const direction: PrintDirection = meta?.printDirection ?? "left"
  const pageColor = lib.PageColorType.SingleColor
  let printed = 0

  client.stopHeartbeat()
  const task = client.protocol.newPrintTask(client.getPrintTaskType() ?? "D110", {
    totalPages: total,
    density: densityFor(darkness, meta),
    labelType: lib.LabelType.WithGaps,
    pageColor,
    statusPollIntervalMs: 100,
    statusTimeoutMs: 8_000,
  })
  try {
    await task.printInit()
    for (const page of wanted) {
      const image = lib.ImageEncoder.encode(page.source, pageColor, direction)
      await task.printPage(image, page.copies)
      await task.waitForPageFinished()
      printed += page.copies
      onProgress?.(printed, total)
    }
    await task.waitForFinished()
    return printed
  } catch (error) {
    throw describeLabelPrinterError(error, "print", printed)
  } finally {
    try {
      await task.printEnd()
    } catch {
      // The printer may be the thing that went away; nothing more to end.
    }
    if (client.isConnected()) client.startHeartbeat()
  }
}

// ---------------------------------------------------------------------------
// The session: one printer per tab, shared by every page that prints
// ---------------------------------------------------------------------------

export type LabelPrinterStatus = "unsupported" | "idle" | "connecting" | "connected" | "printing"

export interface LabelPrinterState {
  status: LabelPrinterStatus
  /** The printer's own Bluetooth name, "D110-G417090412", once connected. */
  name: string
}

/** Whether the browser has Web Bluetooth at all (not in Safari, Firefox, or Brave by default). */
export function bluetoothSupported(): boolean {
  if (typeof navigator === "undefined") return false
  return Boolean((navigator as Navigator & { bluetooth?: unknown }).bluetooth)
}

type Client = InstanceType<Library["NiimbotBluetoothClient"]>

let client: Client | null = null
let state: LabelPrinterState = { status: "idle", name: "" }
const listeners = new Set<() => void>()

function setState(next: LabelPrinterState) {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): LabelPrinterState {
  return bluetoothSupported() ? state : UNSUPPORTED
}

const UNSUPPORTED: LabelPrinterState = { status: "unsupported", name: "" }

/** Where the label printer has got to, for a component. */
export function useLabelPrinter(): LabelPrinterState {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot)
}

function adopt(next: Client, deviceName: string | undefined) {
  next.on("disconnect", () => {
    if (client !== next) return
    client = null
    setState({ status: "idle", name: "" })
  })
  client = next
  setState({ status: "connected", name: deviceName || "Niimbot printer" })
}

/**
 * Show Chrome's printer list and connect to the one picked. Call it straight
 * from a click: Web Bluetooth refuses the list otherwise.
 */
export async function connectLabelPrinter(): Promise<void> {
  if (!bluetoothSupported()) throw new LabelPrinterError("unsupported")
  const lib = await loadPrinterLibrary()
  const previous = client
  const next = new lib.NiimbotBluetoothClient()
  setState({ status: "connecting", name: state.name })
  try {
    if (previous) {
      client = null
      await previous.disconnect()
    }
    const info = await next.connect()
    adopt(next, info.deviceName)
  } catch (error) {
    await next.disconnect().catch(() => undefined)
    setState({ status: "idle", name: "" })
    throw describeLabelPrinterError(error, "connect")
  }
}

/** Print the drawn labels on the connected printer. Answers how many came out. */
export async function printLabels(
  pages: readonly { canvas: HTMLCanvasElement; copies: number }[],
  darkness: Darkness,
  onProgress?: (printed: number, total: number) => void
): Promise<number> {
  const current = client
  if (!current?.isConnected()) throw new LabelPrinterError("not_connected")
  const lib = await loadPrinterLibrary()
  setState({ status: "printing", name: state.name })
  try {
    return await printOnClient(
      lib,
      current,
      pages.map((page) => ({ source: lib.CanvasImageSource.fromCanvas(page.canvas), copies: page.copies })),
      darkness,
      onProgress
    )
  } finally {
    if (client === current) {
      setState(current.isConnected() ? { status: "connected", name: state.name } : { status: "idle", name: "" })
    }
  }
}
