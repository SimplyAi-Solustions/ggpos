/**
 * The Solo reader's pairing calls, and nothing else.
 *
 * SumUp is gone (docs/api-contract-epos.md, section 5): the till takes card
 * payments on the Tide reader by hand, so every checkout call that used to
 * live here went with the old Sell screen. What is left is only what
 * Settings > Card reader (`features/settings/CardReader.tsx`) still imports;
 * this file goes in the same change that removes that section.
 *
 * Not re-exported from `lib/api/index.ts`.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import * as demo from "@/lib/api/demo/checkouts"
import type { SumUpReader, SumUpReaderList } from "@/lib/api/types"

function toReader(row: Partial<SumUpReader> | undefined): SumUpReader {
  return {
    id: row?.id ?? "",
    name: row?.name ?? "Card reader",
    status: row?.status ?? "unknown",
    model: row?.model ?? "",
  }
}

/** The readers SumUp says are paired. */
export async function listReaders(): Promise<SumUpReaderList> {
  if (isDemo()) return demo.listReaders()
  const result = await pb.send<Partial<SumUpReaderList>>("/api/vault/sumup/readers", {
    method: "GET",
  })
  noteNetworkSuccess()
  return {
    readers: (result.readers ?? []).map(toReader),
    default_reader_id: result.default_reader_id ?? "",
    not_configured: result.not_configured === true,
  }
}

export async function pairReader(pairingCode: string, name?: string): Promise<SumUpReader> {
  if (isDemo()) return demo.pairReader(pairingCode, name)
  const result = await pb.send<{ reader?: Partial<SumUpReader> }>("/api/vault/sumup/readers", {
    method: "POST",
    body: name ? { pairing_code: pairingCode, name } : { pairing_code: pairingCode },
  })
  noteNetworkSuccess()
  return toReader(result.reader)
}

export async function removeReader(id: string): Promise<void> {
  if (isDemo()) {
    demo.removeReader(id)
    return
  }
  await pb.send(`/api/vault/sumup/readers/${id}`, { method: "DELETE" })
  noteNetworkSuccess()
}
