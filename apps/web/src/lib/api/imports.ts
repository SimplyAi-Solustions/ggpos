/**
 * The two CSV imports, their bookkeeping row and the Card Uploader review
 * queue.
 *
 * Both routes are multipart with a `file` field and a `type` field that has
 * to match the route, so posting the eBay file to the Card Uploader import is
 * refused rather than read through the wrong mapping
 * (docs/api-contract.md, "Phase 4: exports, imports and SumUp").
 *
 * Linking a reviewed row is not a route of its own: the contract has none,
 * so the screen writes the item through the collection API and then takes
 * that row off the import's own `errors` list, which is what makes the queue
 * shrink as it is worked through.
 */
import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import * as demo from "@/lib/api/demo/imports"
import type {
  CardUploaderResult,
  CsvImportError,
  CsvImportRecord,
  EbayOrdersResult,
} from "@/lib/api/types"

/** The routes refuse anything larger, and so does this, before the upload. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

export class ImportFileError extends Error {}

function checkFile(file: File) {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportFileError(
      "That file is over 10 MB. Export a smaller range and import it in parts."
    )
  }
  if (file.size === 0) {
    throw new ImportFileError("That file is empty. Check the export and try again.")
  }
}

async function post<Result>(path: string, type: string, file: File): Promise<Result> {
  checkFile(file)
  const body = new FormData()
  body.append("file", file)
  body.append("type", type)
  const result = await pb.send<Result>(path, { method: "POST", body })
  noteNetworkSuccess()
  return result
}

/** Card Uploader's per-card export. */
export async function importCardUploader(file: File): Promise<CardUploaderResult> {
  if (isDemo()) {
    checkFile(file)
    return demo.importCardUploader(file)
  }
  return post<CardUploaderResult>(
    "/api/vault/imports/card-uploader",
    "card_uploader",
    file
  )
}

/** eBay's orders report. One order becomes one sale, however many lines. */
export async function importEbayOrders(file: File): Promise<EbayOrdersResult> {
  if (isDemo()) {
    checkFile(file)
    return demo.importEbayOrders(file)
  }
  return post<EbayOrdersResult>("/api/vault/imports/ebay-orders", "ebay_orders", file)
}

/** One import as stored, its errors and review rows included. */
export async function getImport(id: string): Promise<CsvImportRecord> {
  if (isDemo()) return demo.getImport(id)
  const row = await pb.send<CsvImportRecord>(`/api/vault/imports/${id}`, {
    method: "GET",
  })
  noteNetworkSuccess()
  return row
}

/** The imports run lately, newest first, so a review can be picked up again. */
export async function listImports(limit = 10): Promise<CsvImportRecord[]> {
  if (isDemo()) return demo.listImports(limit)
  const page = await pb.collection("csv_imports").getList<CsvImportRecord>(1, limit, {
    sort: "-created",
  })
  return page.items
}

export interface LinkReviewInput {
  importId: string
  /** The 1-based line of the file, which is how an error entry names a row. */
  row: number
  /** The card the staff member picked out of the lookup. */
  cardId: string
  /** Card Uploader's own `CS-XXXXXX` custom label, when the row carried one. */
  ebaySku: string
  /** Integer GBP pence. */
  price: number
  title: string
}

/** What is left of an import's errors once a row has been dealt with. */
function without(errors: CsvImportError[], row: number): CsvImportError[] {
  return errors.filter((entry) => !(entry.kind === "review" && entry.row === row))
}

/**
 * Link a reviewed row to a card: the item goes on as listed on eBay with the
 * file's own SKU and price, and the row comes off the review queue.
 *
 * `cost` is deliberately left unset, exactly as the importer leaves it for a
 * listing with nothing already in stock behind it: nobody knows what this
 * card cost the shop, and inventing a figure would put a false margin on it.
 */
export async function linkReviewRow(input: LinkReviewInput): Promise<CsvImportRecord> {
  if (isDemo()) return demo.linkReviewRow(input)

  await pb.collection("items").create({
    kind: "single",
    card: input.cardId,
    title: input.title,
    qty: 1,
    price: input.price,
    status: "listed_ebay",
    ebay_sku: input.ebaySku,
    source: "supplier",
    tax_scheme: "margin",
    acquired_at: new Date().toISOString(),
    created_by: pb.authStore.record?.id,
  })

  const current = await getImport(input.importId)
  return pb.collection("csv_imports").update<CsvImportRecord>(input.importId, {
    errors: without(current.errors ?? [], input.row),
  })
}

/** Take a row off the review queue without linking it to anything. */
export async function skipReviewRow(
  importId: string,
  row: number
): Promise<CsvImportRecord> {
  if (isDemo()) return demo.skipReviewRow(importId, row)
  const current = await getImport(importId)
  return pb.collection("csv_imports").update<CsvImportRecord>(importId, {
    errors: without(current.errors ?? [], row),
  })
}

/** The review rows on an import, in file order. */
export function reviewRows(record: CsvImportRecord | null): CsvImportError[] {
  return (record?.errors ?? [])
    .filter((entry) => entry.kind === "review")
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
}

/** Everything that went wrong, in file order, the truncation note last. */
export function problemRows(record: CsvImportRecord | null): CsvImportError[] {
  return (record?.errors ?? []).filter((entry) => entry.kind !== "review")
}
