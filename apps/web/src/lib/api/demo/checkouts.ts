/**
 * The demo shop's paired Solo reader, for Settings > Card reader only.
 *
 * The checkouts it used to take went with the old Sell screen: the till
 * takes card payments on the Tide reader by hand (docs/api-contract-epos.md,
 * section 5). This goes with the Card reader section when that is removed.
 * `localStorage` key `gg-demo-reader` still decides how SumUp answers:
 * "off" is a shop that has not set SumUp up, "unpaired" has no reader and
 * "down" is SumUp not answering.
 */
import { ClientResponseError } from "pocketbase"

import { demoSaveSettings, demoSettings } from "@/lib/api/demo/settings"
import type { SumUpReader, SumUpReaderList } from "@/lib/api/types"

const MODE_KEY = "gg-demo-reader"

function mode(): string {
  try {
    return localStorage.getItem(MODE_KEY) ?? ""
  } catch {
    return ""
  }
}

const readers: SumUpReader[] = [
  { id: "reader_demo_1", name: "Counter Solo", status: "paired", model: "Solo" },
]

let sequence = 0

function defaultReaderId(): string {
  return demoSettings().sumup?.default_reader_id ?? ""
}

function setDefaultReader(reader: SumUpReader | null) {
  const current = demoSettings().sumup ?? {}
  demoSaveSettings({
    sumup: {
      ...current,
      default_reader_id: reader?.id ?? "",
      default_reader_name: reader?.name ?? "",
    },
  })
}

export function listReaders(): SumUpReaderList {
  if (mode() === "down") {
    throw new ClientResponseError({
      status: 502,
      response: { code: 502, message: "SumUp did not answer. Try again in a moment.", data: {} },
    })
  }
  if (mode() === "off") return { readers: [], default_reader_id: "", not_configured: true }
  if (mode() === "unpaired") return { readers: [], default_reader_id: "", not_configured: false }
  return {
    readers: readers.map((reader) => ({ ...reader })),
    default_reader_id: defaultReaderId() || readers[0]?.id || "",
    not_configured: false,
  }
}

/** The code on the Solo is eight or nine characters and lasts five minutes. */
export function pairReader(pairingCode: string, name?: string): SumUpReader {
  const code = pairingCode.trim()
  if (code.length < 8 || code.length > 9) {
    throw new Error(
      "That pairing code was not accepted. Read the code off the reader again; it changes each time."
    )
  }
  sequence += 1
  const reader: SumUpReader = {
    id: `reader_demo_${sequence + 1}`,
    name: name?.trim() || `Reader ${sequence + 1}`,
    status: "paired",
    model: "Solo",
  }
  readers.push(reader)
  if (!defaultReaderId()) setDefaultReader(reader)
  return { ...reader }
}

export function removeReader(id: string): void {
  const at = readers.findIndex((reader) => reader.id === id)
  if (at >= 0) readers.splice(at, 1)
  if (defaultReaderId() === id) setDefaultReader(readers[0] ?? null)
}
