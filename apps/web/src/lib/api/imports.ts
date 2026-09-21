/**
 * The two CSV imports, their bookkeeping row and the Card Uploader review
 * queue.
 *
 * Both routes are multipart with a `file` field and a `type` field that has
 * to match the route, so posting the eBay file to the Card Uploader import is
 * refused rather than read through the wrong mapping
 * (docs/api-contract.md, "Phase 4: exports, imports and SumUp").
 *
 * Linking a reviewed row goes through `POST /api/vault/imports/:id/link`,
 * never through the collection API: that route runs the same three-path
 * matching rule the automatic import runs, so a hand-linked row and an
 * automatically matched one can never disagree about what "already in stock"
 * or "already sold" means, and one transaction owns the whole thing.
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
  LinkReviewResult,
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
}

/**
 * Link one reviewed row to a card.
 *
 * The route owns this entirely: it runs the same three-path rule the
 * automatic import runs (an item already carrying this row's `ebay_sku`,
 * else the oldest in-stock item on that card, else a new one), marks the
 * item listed with the row's own price and SKU, and rewrites the import's
 * own `errors` inside one transaction. The screen sends the row number and
 * the card id and nothing else: a price, a SKU or a title invented here
 * could only disagree with the file the server already read.
 */
export async function linkReviewRow(
  input: LinkReviewInput
): Promise<LinkReviewResult> {
  if (isDemo()) return demo.linkReviewRow(input)
  const result = await pb.send<LinkReviewResult>(
    `/api/vault/imports/${input.importId}/link`,
    { method: "POST", body: { row: input.row, card: input.cardId } }
  )
  noteNetworkSuccess()
  return result
}

/** Take a row off the review queue without linking it to anything. */
export async function skipReviewRow(
  importId: string,
  row: number
): Promise<LinkReviewResult> {
  if (isDemo()) return demo.skipReviewRow(importId, row)
  const result = await pb.send<LinkReviewResult>(
    `/api/vault/imports/${importId}/link`,
    { method: "POST", body: { row, skip: true } }
  )
  noteNetworkSuccess()
  return result
}

/**
 * The rows still waiting for a hand to match them.
 *
 * Only a `needs match` entry. The importer's other review-kind entry is the
 * zero-cost note it leaves when it listed a card nothing was in stock for:
 * that row was matched and written, so it belongs with the rest of what the
 * import did, not in a queue asking somebody to find the card again.
 */
export function reviewRows(record: CsvImportRecord | null): CsvImportError[] {
  return (record?.errors ?? [])
    .filter((entry) => entry.kind === "review" && entry.message === "needs match")
    .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
}

/**
 * Everything else the import has to say: the rows it skipped, the ones
 * already sold, the truncation note, and the zero-cost warning for a card it
 * listed with nothing in stock behind it.
 */
export function problemRows(record: CsvImportRecord | null): CsvImportError[] {
  return (record?.errors ?? []).filter(
    (entry) => !(entry.kind === "review" && entry.message === "needs match")
  )
}

/** True for the importer's own "listed but not in stock" warning. */
export function isZeroCostNote(entry: CsvImportError): boolean {
  return entry.kind === "review" && entry.message !== "needs match"
}
