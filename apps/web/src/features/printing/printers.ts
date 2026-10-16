/**
 * The small pure rules behind Settings, Printers: the MAC address the form
 * accepts, what a row says about a printer, and when it was last heard.
 *
 * The same sentences the server uses (`pb_hooks/printing.pb.js`), so a
 * mistake is caught on the form with the words the server would have used.
 */
import type { Printer } from "@gg/shared"

/**
 * A MAC address in the one stored form, aa:bb:cc:dd:ee:ff, or "" when the
 * input is not one. Colons, hyphens or nothing between the pairs.
 */
export function normaliseMac(raw: string): string {
  const text = raw.trim().toLowerCase()
  if (!/^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/.test(text)) return ""
  return (text.replace(/[:-]/g, "").match(/.{2}/g) ?? []).join(":")
}

export interface PrinterForm {
  name: string
  mac: string
  register: string
  /** "80" or "58", the paper in millimetres. */
  paper: "80" | "58"
  model: string
}

export const EMPTY_PRINTER_FORM: PrinterForm = {
  name: "",
  mac: "",
  register: "",
  paper: "80",
  model: "",
}

export type PrinterErrors = Partial<Record<"name" | "mac" | "register", string>>

export function validatePrinterForm(form: PrinterForm): PrinterErrors {
  const errors: PrinterErrors = {}
  const name = form.name.trim()
  if (!name) errors.name = "Give the printer a name, for example Counter printer."
  else if (name.length > 60) errors.name = "Keep the printer name to 60 characters or fewer."
  if (!normaliseMac(form.mac)) {
    errors.mac = "Type the printer's MAC address, for example 00:11:e5:06:04:ff."
  }
  if (!form.register) errors.register = "Choose the register this printer serves."
  return errors
}

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
})
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })

/**
 * Whether the printer is answering, in words: "Online", "Last seen 10:42",
 * "Last seen 7 Oct, 10:42" or "Not seen yet". Never a colour alone.
 */
export function lastSeenText(
  printer: Pick<Printer, "online" | "last_poll_at">,
  now: Date = new Date()
): string {
  if (printer.online) return "Online"
  const at = new Date(printer.last_poll_at)
  if (!printer.last_poll_at || Number.isNaN(at.getTime())) return "Not seen yet"
  const time = CLOCK.format(at)
  return DAY_KEY.format(at) === DAY_KEY.format(now)
    ? `Last seen ${time}`
    : `Last seen ${DAY.format(at)}, ${time}`
}

/** The grey line under a printer's name: model, register and paper. */
export function printerMeta(printer: Pick<Printer, "model" | "register_name" | "paper_width">): string {
  return [printer.model, printer.register_name, `${printer.paper_width} mm paper`]
    .filter(Boolean)
    .join(", ")
}
