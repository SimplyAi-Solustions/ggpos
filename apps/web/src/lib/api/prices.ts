/**
 * Market value at the counter: the price routes, the FX rate behind every
 * converted figure, and the TanStack queries the screens share.
 *
 * docs/api-contract.md, "Phase 3: lookup, prices and FX". The two GET routes
 * never call an adapter, so a price check costs the server one read of
 * `price_snapshots`; only `refresh-prices` and `uk-comp` write anything, and
 * both hand back the same `{ chosen, sources, condition_adjusted }` body so
 * the source view can show straight away what the shop now thinks the card is
 * worth.
 *
 * Every figure that reaches a screen from here is integer GBP pence. The
 * native EUR and USD amounts travel beside their conversion on the same row
 * and are never shown without it (CLAUDE.md, "Pricing").
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query"
import {
  DEFAULT_CONDITION_MULTIPLIERS,
  DEFAULT_MARKUP_BANDS,
  DEFAULT_RETRO_PRIORITY,
  DEFAULT_TCG_PRIORITY,
  roundToRetailEnding,
  type CardCondition,
  type ConditionMultipliers,
  type MarkupBand,
  type PriceSource,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { useVaultConfig } from "@/lib/api/config"
import * as demo from "@/lib/api/demo/catalogue"
import { demoSettings as demoSettingsRecord } from "@/lib/api/demo/settings"
import type { FxRatesView, PriceView, UkCompInput, VaultSettingsRow } from "@/lib/api/types"

/** A price is worth re-reading after a minute at a busy counter. */
export const PRICES_STALE_MS = 60_000
/** A catalogue row changes far less often than a price does. */
export const LOOKUP_STALE_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// The shop's own pricing settings
// ---------------------------------------------------------------------------

export interface PricingSettings {
  /** The order the sources are tried in, from settings. */
  sourcePriority: PriceSource[]
  retroSourcePriority: PriceSource[]
  conditionMultipliers: ConditionMultipliers
  markupBands: MarkupBand[]
  /** `roundToRetailEnding` unless the shop has turned the endings off. */
  sellEnding: (pence: number) => number
  /** The asking-to-sold haircut already applied to an eBay figure, percent. */
  ebayHaircutPct: number
}

export const DEFAULT_HAIRCUT_PCT = 15

const SOURCES = new Set<string>([
  "uk_sold_manual",
  "ebay_uk_asking",
  "cardmarket",
  "tcgplayer",
  "pricecharting_pal",
  "pricecharting_ntsc",
])

function priorityFrom(
  value: string[] | undefined,
  fallback: PriceSource[]
): PriceSource[] {
  const clean = (value ?? []).filter((entry): entry is PriceSource => SOURCES.has(entry))
  return clean.length > 0 ? clean : fallback
}

/**
 * What the counter needs out of `settings` to price something. Every field
 * falls back to the shared default, which is the same figure the seed writes,
 * so a shop that has never opened Settings prices exactly like one that has.
 */
export function pricingSettingsFrom(settings: VaultSettingsRow | undefined): PricingSettings {
  const offer = (settings?.offer ?? {}) as Record<string, number | undefined>
  const multipliers = settings?.condition_multipliers
  const bands = settings?.markup_bands
  return {
    sourcePriority: priorityFrom(settings?.source_priority, DEFAULT_TCG_PRIORITY),
    retroSourcePriority: priorityFrom(
      settings?.retro_source_priority,
      DEFAULT_RETRO_PRIORITY
    ),
    conditionMultipliers: {
      ...DEFAULT_CONDITION_MULTIPLIERS,
      ...(multipliers as Partial<ConditionMultipliers> | undefined),
    },
    markupBands: Array.isArray(bands) && bands.length > 0 ? bands : DEFAULT_MARKUP_BANDS,
    // "49_99" is the seeded default and the only ending the shop has; any
    // other value means the admin has turned retail endings off.
    sellEnding:
      (settings?.sell_rounding ?? "49_99") === "49_99"
        ? roundToRetailEnding
        : (pence: number) => pence,
    ebayHaircutPct: offer.ebayHaircutPct ?? DEFAULT_HAIRCUT_PCT,
  }
}

/**
 * Demo mode's config stub carries only what the buy-in wizard needs, so the
 * pricing half comes from the same in-memory settings record the Settings
 * screen writes to. One source of truth either way: the source view and the
 * demo price routes below both read this.
 */
function activeSettings(row: VaultSettingsRow | undefined): VaultSettingsRow | undefined {
  if (!isDemo()) return row
  return { ...demoSettingsRecord(), ...(row ?? {}) }
}

/** The pricing half of `GET /api/vault/config`, already mapped. */
export function usePricingSettings(): PricingSettings {
  const { data } = useVaultConfig()
  return pricingSettingsFrom(activeSettings(data?.settings))
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/** What the demo price routes below read, exactly as the screens do. */
function demoPricing(): PricingSettings {
  return pricingSettingsFrom(activeSettings(undefined))
}

/** The card's valuation, read from `price_snapshots` and nothing else. */
export async function getPrices(
  cardId: string,
  finish = "",
  condition: CardCondition | string = "NM"
): Promise<PriceView> {
  if (isDemo()) {
    const settings = demoPricing()
    const multiplier =
      settings.conditionMultipliers[condition as CardCondition] ?? 1
    return demo.getPrices(cardId, finish, settings.sourcePriority, multiplier)
  }
  return pb.send<PriceView>(`/api/vault/cards/${encodeURIComponent(cardId)}/prices`, {
    method: "GET",
    query: { finish, condition },
  })
}

/**
 * Asks every adapter again, writes what they answer, and hands back the lot.
 * The condition travels with it: the eBay adapter searches for the condition
 * words, so refreshing an LP card on "NM" would price the wrong thing.
 */
export async function refreshPrices(
  cardId: string,
  finish = "",
  condition: CardCondition | string = "NM"
): Promise<PriceView> {
  if (isDemo()) {
    demo.refreshPrices(cardId, finish)
    return getPrices(cardId, finish, condition)
  }
  return pb.send<PriceView>(
    `/api/vault/cards/${encodeURIComponent(cardId)}/refresh-prices`,
    { method: "POST", body: { finish, condition: condition || "NM" } }
  )
}

/**
 * A UK sold comp a staff member found on ebay.co.uk. It becomes the top
 * source for 30 days, so the response says whether it was actually chosen.
 */
export async function addUkComp(cardId: string, body: UkCompInput): Promise<PriceView> {
  if (isDemo()) {
    demo.addUkComp(cardId, body)
    return getPrices(cardId, body.finish ?? "", body.condition ?? "NM")
  }
  return pb.send<PriceView>(`/api/vault/cards/${encodeURIComponent(cardId)}/uk-comp`, {
    method: "POST",
    body: {
      finish: body.finish ?? "",
      condition: body.condition ?? "NM",
      price: body.price,
      url: body.url,
      sold_at: body.sold_at,
    },
  })
}

/** The retro title's valuation. Condition multipliers are a card idea only. */
export async function getRetroPrices(id: string, completeness = ""): Promise<PriceView> {
  if (isDemo()) {
    return demo.getRetroPrices(id, completeness, demoPricing().retroSourcePriority)
  }
  return pb.send<PriceView>(`/api/vault/retro/${encodeURIComponent(id)}/prices`, {
    method: "GET",
    query: { completeness },
  })
}

/**
 * The retro pair of the two card writes. Both routes are being added to
 * `pb_hooks/prices.pb.js` with the card versions' shapes; until they land a
 * refusal comes back with the server's own words, which the source view puts
 * under the action rather than swallowing.
 */
export async function refreshRetroPrices(
  id: string,
  completeness = ""
): Promise<PriceView> {
  if (isDemo()) {
    demo.refreshPrices(id, completeness)
    return getRetroPrices(id, completeness)
  }
  return pb.send<PriceView>(
    `/api/vault/retro/${encodeURIComponent(id)}/refresh-prices`,
    { method: "POST", body: { completeness } }
  )
}

/**
 * A retro comp files under `completeness`, which is the only shape that
 * route reads: `finish` and `condition` are a card's idea, and a comp sent
 * with them lands against no completeness at all.
 */
export async function addRetroUkComp(
  id: string,
  body: UkCompInput
): Promise<PriceView> {
  const completeness = body.completeness ?? ""
  if (isDemo()) {
    demo.addUkComp(id, { ...body, completeness })
    return getRetroPrices(id, completeness)
  }
  return pb.send<PriceView>(`/api/vault/retro/${encodeURIComponent(id)}/uk-comp`, {
    method: "POST",
    body: {
      completeness,
      price: body.price,
      url: body.url,
      sold_at: body.sold_at,
    },
  })
}

/** The day's ECB rates, GBP per one unit of each foreign currency. */
export async function getFx(): Promise<FxRatesView> {
  if (isDemo()) return demo.getFx()
  return pb.send<FxRatesView>("/api/vault/fx", { method: "GET" })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Keys are shaped so one card's prices invalidate together after a write. */
export const priceKeys = {
  /**
   * The condition is deliberately not part of the key. It changes nothing
   * the screens read (`condition_adjusted` is worked out on the client with
   * the shared helper, so it follows a source picked by hand too), and
   * keying on it made every condition tap empty the cache and flash "No
   * price yet" over a figure that had not moved.
   */
  card: (cardId: string, finish: string) => ["prices", "card", cardId, finish] as const,
  cardAll: (cardId: string) => ["prices", "card", cardId] as const,
  retro: (id: string, completeness: string) =>
    ["prices", "retro", id, completeness] as const,
  retroAll: (id: string) => ["prices", "retro", id] as const,
  fx: () => ["fx"] as const,
}

type PricesQuery = UseQueryOptions<PriceView, Error, PriceView, readonly unknown[]>

export function cardPricesQuery(
  cardId: string | undefined,
  finish = "",
  condition: CardCondition | string = "NM"
): PricesQuery {
  return {
    queryKey: priceKeys.card(cardId ?? "", finish),
    queryFn: () => getPrices(cardId as string, finish, condition),
    enabled: Boolean(cardId),
    staleTime: PRICES_STALE_MS,
    // A card that is not in the catalogue, or a route that refused, has
    // said so: retrying three times only delays the sentence.
    retry: false,
  }
}

export function retroPricesQuery(
  id: string | undefined,
  completeness = ""
): PricesQuery {
  return {
    queryKey: priceKeys.retro(id ?? "", completeness),
    queryFn: () => getRetroPrices(id as string, completeness),
    enabled: Boolean(id),
    staleTime: PRICES_STALE_MS,
    retry: false,
  }
}

export function useCardPrices(
  cardId: string | undefined,
  finish = "",
  condition: CardCondition | string = "NM"
) {
  return useQuery(cardPricesQuery(cardId, finish, condition))
}

export function useRetroPrices(id: string | undefined, completeness = "") {
  return useQuery(retroPricesQuery(id, completeness))
}

export const fxQuery = {
  queryKey: priceKeys.fx(),
  queryFn: getFx,
  staleTime: LOOKUP_STALE_MS,
  retry: false,
}

export function useFx() {
  return useQuery(fxQuery)
}
