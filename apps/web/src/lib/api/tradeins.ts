/**
 * Trade-ins: the draft, its lines, the pricing inputs, completion, the ID
 * check, the receipt and the admin ID-photo view.
 *
 * Drafts and lines go through the collection API; completion, the ID check
 * and the receipt are the custom routes in `docs/api-contract.md`, because
 * each of them has to be transactional, gated or audited.
 */
import { ClientResponseError } from "pocketbase"
import { DEFAULT_OFFER_SETTINGS, type OfferSettings, type PricingRule } from "@gg/shared/pricing"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { isNotFound } from "@/lib/api/refusal"
import { findDemoCustomer } from "@/lib/api/demo/customers"
import {
  DEMO_OFFER_LIMITS,
  DEMO_OFFER_SETTINGS,
  DEMO_PRICING_RULES,
  demoCompleteTradeIn,
  demoCreateDraft,
  demoGetLines,
  demoGetTradeIn,
  demoListTradeIns,
  demoReceipt,
  demoSaveLines,
  demoSubmitIdCheck,
  demoTradeInsFor,
} from "@/lib/api/demo/tradeins"
import type {
  CompleteTradeInPayload,
  CompleteTradeInResult,
  CustomerRecord,
  IdCheckResult,
  OfferLimits,
  ReceiptEmailResult,
  ReceiptPayload,
  StaffRecord,
  TradeInLineInput,
  TradeInLineRecord,
  TradeInRecord,
  TradeInSummary,
  TradeInStatus,
} from "@/lib/api/types"

function escapeFilter(value: string): string {
  return value.replace(/["\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Pricing inputs
// ---------------------------------------------------------------------------

interface PricingRuleRecord {
  id: string
  game?: string
  kind?: string
  condition?: string
  finish?: string
  rarity?: string
  band_min?: number
  band_max?: number
  cash_pct?: number
  credit_pct?: number
  rounding?: number
  priority?: number
  active?: boolean
}

function toRule(record: PricingRuleRecord): PricingRule {
  const step = record.rounding ?? 25
  return {
    id: record.id,
    game: record.game || null,
    kind: record.kind || null,
    condition: record.condition || null,
    finish: record.finish || null,
    rarity: record.rarity || null,
    bandMin: record.band_min ?? 0,
    bandMax: record.band_max ?? null,
    cashPct: record.cash_pct ?? 0,
    creditPct: record.credit_pct ?? 0,
    rounding: step === 50 || step === 100 ? step : 25,
    priority: record.priority ?? 0,
    active: record.active !== false,
  }
}

/**
 * The live offer bands.
 *
 * `pricing_rules` is admin-only in the migrations, so an ordinary staff token
 * is refused. Rather than quietly applying percentages nobody configured,
 * this returns an empty list, `computeOffer` returns nothing to offer, and
 * the Items step says the figure has to be entered by hand.
 */
export async function getPricingRules(): Promise<PricingRule[]> {
  if (isDemo()) return DEMO_PRICING_RULES

  try {
    const rows = await pb.collection("pricing_rules").getFullList<PricingRuleRecord>({
      filter: "active = true",
      sort: "-priority",
    })
    return rows.map(toRule)
  } catch (error) {
    if (
      error instanceof ClientResponseError &&
      (error.status === 403 || error.status === 404)
    ) {
      return []
    }
    throw error
  }
}

interface SettingsRecord {
  id: string
  cash_cap?: number
  offer?: Partial<OfferSettings>
}

/**
 * `settings.offer` plus the cash cap, with the shared defaults filling in
 * anything the shop has not set (or that this token may not read: `settings`
 * is admin-only too).
 */
export async function getOfferSettings(): Promise<OfferSettings & OfferLimits> {
  if (isDemo()) return { ...DEMO_OFFER_SETTINGS, ...DEMO_OFFER_LIMITS }

  const fallback = { ...DEFAULT_OFFER_SETTINGS, cashCap: 800_000 }
  try {
    const row = await pb
      .collection("settings")
      .getFirstListItem<SettingsRecord>("id != ''")
    const offer = row.offer ?? {}
    return {
      bulkThreshold: offer.bulkThreshold ?? fallback.bulkThreshold,
      bulkCash: offer.bulkCash ?? fallback.bulkCash,
      bulkCredit: offer.bulkCredit ?? fallback.bulkCredit,
      minimumOffer: offer.minimumOffer ?? fallback.minimumOffer,
      cashCap: row.cash_cap ?? fallback.cashCap,
    }
  } catch (error) {
    if (
      error instanceof ClientResponseError &&
      (error.status === 403 || error.status === 404)
    ) {
      return fallback
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Drafts and lines
// ---------------------------------------------------------------------------

/**
 * A draft carries no number: `trade_ins.number` is optional behind a partial
 * unique index, and `GG-BI-000123` is drawn from `counters.trade_in` inside
 * the completion transaction, so an abandoned draft never burns one.
 */
export async function createDraftTradeIn(customerId: string): Promise<TradeInRecord> {
  if (isDemo()) return demoCreateDraft(customerId)

  return pb.collection("trade_ins").create<TradeInRecord>({
    customer: customerId,
    channel: "counter",
    status: "draft",
    total_market: 0,
    total_offer: 0,
    payout_cash: 0,
    payout_credit: 0,
  })
}

export async function getTradeIn(id: string): Promise<TradeInRecord | null> {
  if (isDemo()) return demoGetTradeIn(id)
  try {
    return await pb.collection("trade_ins").getOne<TradeInRecord>(id)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

export async function getTradeInLines(id: string): Promise<TradeInLineRecord[]> {
  if (isDemo()) return demoGetLines(id)
  return pb.collection("trade_in_lines").getFullList<TradeInLineRecord>({
    filter: `trade_in = "${escapeFilter(id)}"`,
    sort: "created",
  })
}

function toLineBody(tradeInId: string, line: TradeInLineInput) {
  return {
    trade_in: tradeInId,
    kind: line.kind,
    game: line.gameId || undefined,
    card: line.cardId || undefined,
    free_text_title: line.title || undefined,
    finish: line.finish || undefined,
    condition: line.condition || undefined,
    completeness: line.completeness || undefined,
    qty: line.qty,
    market_price: line.marketPrice,
    market_currency: "GBP" as const,
    market_source: line.marketSource || undefined,
    offer_pct: line.offerPct,
    offer_price: line.offerPrice,
    accepted: line.accepted,
  }
}

/**
 * Write the wizard's lines over the draft's: new lines are created, known
 * ones updated, and anything the wizard no longer holds is removed. One
 * batch, so a half-written offer is not possible; a server with the batch
 * API switched off falls back to a request per line.
 */
export async function saveTradeInLines(
  tradeInId: string,
  lines: TradeInLineInput[]
): Promise<TradeInLineRecord[]> {
  if (isDemo()) return demoSaveLines(tradeInId, lines)

  const existing = await pb
    .collection("trade_in_lines")
    .getFullList<{ id: string }>({
      filter: `trade_in = "${escapeFilter(tradeInId)}"`,
      fields: "id",
    })
  const keep = new Set(lines.map((line) => line.id).filter(Boolean) as string[])
  const remove = existing.filter((row) => !keep.has(row.id))

  const totals = lines.reduce(
    (sum, line) => ({
      market: sum.market + line.marketPrice * line.qty,
      offer: sum.offer + (line.accepted ? line.offerPrice * line.qty : 0),
    }),
    { market: 0, offer: 0 }
  )

  async function oneAtATime() {
    for (const row of remove) {
      await pb.collection("trade_in_lines").delete(row.id)
    }
    for (const line of lines) {
      const body = toLineBody(tradeInId, line)
      if (line.id) await pb.collection("trade_in_lines").update(line.id, body)
      else await pb.collection("trade_in_lines").create(body)
    }
    await pb.collection("trade_ins").update(tradeInId, {
      total_market: totals.market,
      total_offer: totals.offer,
    })
  }

  try {
    const batch = pb.createBatch()
    for (const row of remove) batch.collection("trade_in_lines").delete(row.id)
    for (const line of lines) {
      const body = toLineBody(tradeInId, line)
      if (line.id) batch.collection("trade_in_lines").update(line.id, body)
      else batch.collection("trade_in_lines").create(body)
    }
    batch.collection("trade_ins").update(tradeInId, {
      total_market: totals.market,
      total_offer: totals.offer,
    })
    await batch.send()
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 400) {
      await oneAtATime()
    } else {
      throw error
    }
  }

  return getTradeInLines(tradeInId)
}

// ---------------------------------------------------------------------------
// The custom routes
// ---------------------------------------------------------------------------

export async function completeTradeIn(
  id: string,
  payload: CompleteTradeInPayload
): Promise<CompleteTradeInResult> {
  if (isDemo()) return demoCompleteTradeIn(id, payload)
  return pb.send<CompleteTradeInResult>(`/api/vault/trade-ins/${id}/complete`, {
    method: "POST",
    body: payload,
  })
}

export async function submitIdCheck(
  customerId: string,
  form: FormData
): Promise<IdCheckResult> {
  if (isDemo()) return demoSubmitIdCheck(customerId, form)
  return pb.send<IdCheckResult>(`/api/vault/customers/${customerId}/id-check`, {
    method: "POST",
    body: form,
  })
}

export async function getReceipt(tradeInId: string): Promise<ReceiptPayload> {
  if (isDemo()) return demoReceipt(tradeInId)
  return pb.send<ReceiptPayload>(`/api/vault/trade-ins/${tradeInId}/receipt`, {
    method: "GET",
  })
}

export async function emailReceipt(
  tradeInId: string
): Promise<ReceiptEmailResult> {
  if (isDemo()) return { sent: true }
  return pb.send<ReceiptEmailResult>(
    `/api/vault/trade-ins/${tradeInId}/receipt/email`,
    { method: "POST" }
  )
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

type ExpandedTradeIn = TradeInRecord & {
  expand?: { customer?: CustomerRecord; staff?: StaffRecord }
}

function toSummary(record: ExpandedTradeIn): TradeInSummary {
  return {
    id: record.id,
    number: record.number,
    status: (record.status ?? "draft") as TradeInStatus,
    customerId: record.customer,
    customerName: record.expand?.customer?.name ?? record.seller_name ?? "",
    customerCode: record.expand?.customer?.code ?? "",
    payoutType: record.payout_type ?? null,
    totalMarket: record.total_market ?? 0,
    totalOffer: record.total_offer ?? 0,
    payoutCash: record.payout_cash ?? 0,
    payoutCredit: record.payout_credit ?? 0,
    staffName: record.expand?.staff?.name ?? "",
    at: record.completed_at || record.created || "",
  }
}

export async function listTradeIns(): Promise<TradeInSummary[]> {
  if (isDemo()) return demoListTradeIns()
  const page = await pb.collection("trade_ins").getList<ExpandedTradeIn>(1, 50, {
    sort: "-created",
    expand: "customer,staff",
  })
  return page.items.map(toSummary)
}

export async function getCustomerTradeIns(
  customerId: string
): Promise<TradeInSummary[]> {
  if (isDemo()) return demoTradeInsFor(customerId)
  const page = await pb.collection("trade_ins").getList<ExpandedTradeIn>(1, 50, {
    filter: `customer = "${escapeFilter(customerId)}"`,
    sort: "-created",
    expand: "customer,staff",
  })
  return page.items.map(toSummary)
}

// ---------------------------------------------------------------------------
// The ID photo (admin, step-up)
// ---------------------------------------------------------------------------

/** Confirms the signed-in staff member's password for the next ten minutes. */
export async function stepUp(password: string): Promise<string> {
  if (isDemo()) return "demo-step-up"
  const result = await pb.send<{ token: string; expires_at: string }>(
    "/api/vault/step-up",
    { method: "POST", body: { password } }
  )
  return result.token
}

/**
 * The decrypted ID photo as an object URL, for an admin who has just
 * confirmed their password. The caller revokes the URL when the sheet closes.
 *
 * `id_documents` has every collection rule set to null, so the app cannot
 * look a customer's document up: the id comes from the ID check made in this
 * session. Opening an older customer's photo needs a route that names their
 * latest document, which Phase 2's contract does not yet have; the profile
 * says so rather than showing a button that cannot work.
 */
export async function fetchIdPhoto(
  idDocumentId: string,
  stepUpToken: string
): Promise<string> {
  if (isDemo()) return demoIdPhoto()

  const response = await fetch(pb.buildURL(`/api/vault/id-photo/${idDocumentId}`), {
    headers: {
      Authorization: pb.authStore.token,
      "X-Step-Up": stepUpToken,
    },
  })
  if (!response.ok) {
    throw new ClientResponseError({
      status: response.status,
      response: await response.json().catch(() => ({})),
    })
  }
  return URL.createObjectURL(await response.blob())
}

/** A drawn stand-in, so demo mode never ships a photograph of anybody. */
function demoIdPhoto(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
<rect width="640" height="400" fill="#fbfbfa"/>
<rect x="24" y="24" width="592" height="352" fill="none" stroke="#0b0b0b" stroke-opacity="0.24"/>
<text x="56" y="120" font-family="monospace" font-size="20" letter-spacing="4" fill="#3d3d3a">ID PHOTO</text>
<text x="56" y="168" font-family="sans-serif" font-size="22" fill="#0b0b0b">Demo mode holds no photograph.</text>
<text x="56" y="204" font-family="sans-serif" font-size="18" fill="#73736d">A real photo is decrypted for this view only.</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** The most recent ID document for a customer, when the server exposes one. */
export async function latestIdDocument(customerId: string): Promise<string | null> {
  if (isDemo()) return findDemoCustomer(customerId)?.private.id_status === "verified"
    ? "iddoc_demo"
    : null
  try {
    const row = await pb
      .collection("id_documents")
      .getFirstListItem<{ id: string }>(
        `customer = "${escapeFilter(customerId)}"`,
        { sort: "-taken_at" }
      )
    return row.id
  } catch {
    // Every rule on `id_documents` is null (superuser only), so this is the
    // expected answer until a route for it exists.
    return null
  }
}
