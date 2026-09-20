/**
 * The WebUSB half of printing path 2 (docs/label-spec.md).
 *
 * The T003 does not publish its USB vendor and product ids, and the shop has
 * one printer, so there is no filter to offer: the staff member picks it out
 * of Chrome's list once, the browser remembers the permission, and
 * `getDevices()` finds it again every morning after that.
 *
 * WebUSB is not in TypeScript's DOM library, so the little of it this file
 * touches is declared here structurally. That is also what lets the tests
 * hand it a fake printer that records the bytes it was sent.
 */

/** The USB class number for a printer. The T003 answers to it. */
const PRINTER_CLASS = 7

export interface UsbEndpointLike {
  endpointNumber: number
  direction: "in" | "out"
  type: string
}

export interface UsbAlternateLike {
  alternateSetting: number
  interfaceClass: number
  endpoints: UsbEndpointLike[]
}

export interface UsbInterfaceLike {
  interfaceNumber: number
  alternate: UsbAlternateLike
  claimed?: boolean
}

export interface UsbConfigurationLike {
  configurationValue: number
  interfaces: UsbInterfaceLike[]
}

export interface UsbDeviceLike {
  productName?: string
  manufacturerName?: string
  serialNumber?: string
  opened?: boolean
  configuration?: UsbConfigurationLike | null
  configurations?: UsbConfigurationLike[]
  open(): Promise<void>
  close?(): Promise<void>
  selectConfiguration(value: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface?(interfaceNumber: number): Promise<void>
  transferOut(
    endpointNumber: number,
    data: BufferSource
  ): Promise<{ status?: string; bytesWritten?: number }>
}

export interface UsbLike {
  requestDevice(options: { filters: unknown[] }): Promise<UsbDeviceLike>
  getDevices(): Promise<UsbDeviceLike[]>
}

/** A device that has been opened, configured and claimed, ready for bytes. */
export interface UsbPrinter {
  device: UsbDeviceLike
  /** What the shop sees: the printer's own product name. */
  name: string
  interfaceNumber: number
  endpointNumber: number
}

export type PrinterFault =
  | "unsupported"
  | "cancelled"
  | "not_bound"
  | "no_endpoint"
  | "disconnected"
  | "failed"

/** Every sentence the counter can show about the printer, in one place. */
export const PRINTER_MESSAGES: Record<PrinterFault, string> = {
  unsupported:
    "This browser cannot print over USB. Use Chrome on the counter PC, or print from the queue's Print button.",
  cancelled:
    "No printer was chosen. Press Connect printer again and pick the T003 from the list.",
  not_bound:
    "Chrome could not open the printer. On Windows the WinUSB driver has to be bound to it first; docs/label-spec.md says how.",
  no_endpoint:
    "That device is not a label printer. Press Connect printer again and pick the T003.",
  disconnected:
    "The printer stopped answering part way through the label. Check the cable, then connect it again and print the job again.",
  failed:
    "The printer would not take the label. Check it is on, has paper in it and is connected, then try again.",
}

export class PrinterError extends Error {
  readonly fault: PrinterFault

  constructor(fault: PrinterFault, message = PRINTER_MESSAGES[fault]) {
    super(message)
    this.name = "PrinterError"
    this.fault = fault
  }
}

type Stage = "connect" | "open" | "send"

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name
  return ""
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "")
}

/**
 * What went wrong, in words a staff member can act on.
 *
 * Chrome reports both "the driver is not bound" and "another program holds
 * the printer" as a security or network error on open, and both have the
 * same answer on the counter PC, so they share the Zadig sentence. A failure
 * once bytes are moving is the cable or the power, so it says so instead.
 */
export function describePrinterError(error: unknown, stage: Stage): PrinterError {
  if (error instanceof PrinterError) return error
  const name = errorName(error)
  const text = errorText(error).toLowerCase()

  if (stage === "connect") {
    // The picker closed with nothing chosen, which is a person changing
    // their mind rather than a fault.
    if (name === "NotFoundError") return new PrinterError("cancelled")
    if (name === "SecurityError" || name === "NotAllowedError") {
      return new PrinterError(
        "unsupported",
        "The browser blocked the printer picker. Press Connect printer again, and allow the device when Chrome asks."
      )
    }
  }

  if (stage === "open") {
    if (
      name === "SecurityError" ||
      name === "NetworkError" ||
      name === "InvalidStateError" ||
      text.includes("access denied") ||
      text.includes("claim")
    ) {
      return new PrinterError("not_bound")
    }
  }

  if (stage === "send") {
    if (
      name === "NetworkError" ||
      name === "NotFoundError" ||
      text.includes("disconnect")
    ) {
      return new PrinterError("disconnected")
    }
  }

  return new PrinterError("failed")
}

/** Chrome on the counter PC has this; Safari and Firefox do not. */
export function usbPrintingSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator
}

function usb(): UsbLike {
  const api = (navigator as Navigator & { usb?: UsbLike }).usb
  if (!api) throw new PrinterError("unsupported")
  return api
}

/** The bulk OUT endpoint on the printer interface, or on the first that has one. */
function findEndpoint(device: UsbDeviceLike): {
  interfaceNumber: number
  endpointNumber: number
} {
  const interfaces = device.configuration?.interfaces ?? []
  const bulkOut = (entry: UsbInterfaceLike) =>
    entry.alternate?.endpoints?.find(
      (endpoint) => endpoint.direction === "out" && endpoint.type === "bulk"
    )

  const printer = interfaces.find(
    (entry) => entry.alternate?.interfaceClass === PRINTER_CLASS && bulkOut(entry)
  )
  const chosen = printer ?? interfaces.find((entry) => bulkOut(entry))
  const endpoint = chosen ? bulkOut(chosen) : undefined
  if (!chosen || !endpoint) throw new PrinterError("no_endpoint")
  return { interfaceNumber: chosen.interfaceNumber, endpointNumber: endpoint.endpointNumber }
}

/**
 * Open a device, put it on its first configuration and claim the interface
 * the label bytes go to.
 */
export async function openPrinter(device: UsbDeviceLike): Promise<UsbPrinter> {
  try {
    if (!device.opened) await device.open()
    if (!device.configuration) {
      const first = device.configurations?.[0]
      await device.selectConfiguration(first?.configurationValue ?? 1)
    }
    const { interfaceNumber, endpointNumber } = findEndpoint(device)
    await device.claimInterface(interfaceNumber)
    return {
      device,
      name: device.productName?.trim() || "Label printer",
      interfaceNumber,
      endpointNumber,
    }
  } catch (error) {
    throw describePrinterError(error, "open")
  }
}

/** The picker. One press, once per printer, per browser profile. */
export async function chooseUsbPrinter(): Promise<UsbPrinter> {
  let device: UsbDeviceLike
  try {
    // No filter: the T003's ids are not published, so the list is everything
    // and the staff member picks the printer out of it.
    device = await usb().requestDevice({ filters: [] })
  } catch (error) {
    throw describePrinterError(error, "connect")
  }
  return openPrinter(device)
}

/**
 * The printer this browser was already given. Nothing is asked of the staff
 * member: a device Chrome remembers comes back on its own after a reload.
 */
export async function findUsbPrinter(): Promise<UsbPrinter | null> {
  if (!usbPrintingSupported()) return null
  let devices: UsbDeviceLike[]
  try {
    devices = await usb().getDevices()
  } catch {
    return null
  }
  for (const device of devices) {
    try {
      return await openPrinter(device)
    } catch {
      // Not this one: a keyboard or a scanner the browser also remembers.
    }
  }
  return null
}

/** 4 KB at a time: more than any one label, and inside every bulk buffer. */
const CHUNK = 4096

/** Sends the bytes and refuses quietly to report a label the printer stalled on. */
export async function sendToPrinter(
  printer: UsbPrinter,
  bytes: Uint8Array
): Promise<void> {
  try {
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const slice = bytes.slice(at, at + CHUNK)
      const result = await printer.device.transferOut(printer.endpointNumber, slice)
      if (result?.status && result.status !== "ok") {
        throw new PrinterError("failed")
      }
    }
  } catch (error) {
    throw describePrinterError(error, "send")
  }
}

/** Hands the interface back, for a staff member switching printers. */
export async function releasePrinter(printer: UsbPrinter): Promise<void> {
  try {
    await printer.device.releaseInterface?.(printer.interfaceNumber)
    await printer.device.close?.()
  } catch {
    // The printer is already gone, which is the state we were after.
  }
}
