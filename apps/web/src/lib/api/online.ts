/**
 * Stock on the website and item photos (docs/api-contract-launch.md,
 * section 6): the reads and writes behind the item page's Website switch
 * and photos, the Stock list's bulk action, Add stock's photo step and
 * Settings, Website.
 *
 * - `items.show_online` and `items.photos` are written through the
 *   collection API, like the item page's price.
 * - `settings.online` is the admin's, through the settings collection, as
 *   the rest of Settings is; the save is audited by audit.pb.js.
 * - A branch's `show_online` (new stock filed there starts shown) is a
 *   plain write on `categories`, which managers and admins may make.
 * - What the website shows is read from the public feed itself, so the
 *   counter sees exactly what a visitor sees.
 *
 * Demo mode answers every call from `demo/online.ts`.
 */
import { useQuery } from "@tanstack/react-query"
import {
  readOnlineSettings,
  type OnlineSettings,
  type PublicStockPage,
} from "@gg/shared"

import { pb } from "@/lib/pb"
import { isDemo } from "@/lib/api/mode"
import { noteNetworkSuccess } from "@/lib/offline/net"
import { platformForItem } from "@/lib/api/item-shape"
import { PLATFORMS, platformSpec, type PlatformKey } from "@/design/platforms"
import * as demo from "@/lib/api/demo/online"
import type { StockItemRecord } from "@/lib/api/types"

export const ONLINE_SETTINGS_KEY = ["online-settings"] as const
export const ONLINE_BRANCHES_KEY = ["online-branches"] as const
export const ONLINE_FEED_KEY = ["online-feed"] as const

export interface OnlineSettingsRow extends OnlineSettings {
  /** The settings record's id, to write back to. */
  id: string
}

/** A branch whose new stock starts shown online. */
export interface OnlineBranch {
  id: string
  path: string
}

/** One of an item's photos, first first. */
export interface ItemPhoto {
  name: string
  url: string
  thumb: string
}

/** The frame a photo is cropped to: the item's platform. */
export interface PhotoFrame {
  platform: PlatformKey
  ratio: readonly [number, number]
  label: string
}

// ---------------------------------------------------------------------------
// settings.online (admin)
// ---------------------------------------------------------------------------

export async function getOnlineSettings(): Promise<OnlineSettingsRow> {
  if (isDemo()) return demo.demoOnlineSettings()
  const row = await pb
    .collection("settings")
    .getFirstListItem<{ id: string; online?: unknown }>("", { fields: "id,online" })
  noteNetworkSuccess()
  return { id: row.id, ...readOnlineSettings(row.online) }
}

export async function saveOnlineSettings(id: string, value: OnlineSettings): Promise<OnlineSettingsRow> {
  if (isDemo()) return demo.demoSaveOnlineSettings(value)
  const online = readOnlineSettings(value)
  const row = await pb
    .collection("settings")
    .update<{ id: string; online?: unknown }>(id, { online }, { fields: "id,online" })
  return { id: row.id, ...readOnlineSettings(row.online) }
}

/** The settings for the admin who can read them; null for everybody else. */
export function useOnlineSettings(enabled: boolean) {
  return useQuery({
    queryKey: ONLINE_SETTINGS_KEY,
    queryFn: getOnlineSettings,
    enabled,
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// Branches that start new stock online
// ---------------------------------------------------------------------------

export async function listOnlineBranches(): Promise<OnlineBranch[]> {
  if (isDemo()) return demo.demoOnlineBranches()
  const rows = await pb.collection("categories").getFullList<{ id: string; path?: string; name?: string }>({
    filter: "show_online = true",
    fields: "id,path,name",
    sort: "path",
  })
  return rows.map((row) => ({ id: row.id, path: row.path || row.name || "" }))
}

export async function setBranchOnline(id: string, on: boolean): Promise<void> {
  if (isDemo()) return demo.demoSetBranchOnline(id, on)
  await pb.collection("categories").update(id, { show_online: on }, { fields: "id" })
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Show or hide stock rows on the website; answers how many changed. */
export async function setItemsOnline(ids: string[], on: boolean): Promise<number> {
  if (isDemo()) return demo.demoSetItemsOnline(ids, on)
  // A handful at a time: a page of the stock list is 25 rows.
  let done = 0
  for (let at = 0; at < ids.length; at += 5) {
    const batch = ids.slice(at, at + 5)
    await Promise.all(
      batch.map((id) => pb.collection("items").update(id, { show_online: on }, { fields: "id" }))
    )
    done += batch.length
  }
  return done
}

type PhotoRecord = Pick<StockItemRecord, "id" | "photos"> & {
  collectionId?: string
  collectionName?: string
}

/** The item's photos, first first, with a 320px thumb for the strip. */
export function itemPhotos(item: PhotoRecord): ItemPhoto[] {
  if (isDemo()) return demo.demoItemPhotos(item.id)
  const record = { id: item.id, collectionId: item.collectionId ?? "", collectionName: item.collectionName ?? "items" }
  return (item.photos ?? []).map((name) => ({
    name,
    url: pb.files.getURL(record, name),
    thumb: pb.files.getURL(record, name, { thumb: "320x0" }),
  }))
}

/** Adds a photo after the others; answers the item's photo names in order. */
export async function addItemPhoto(itemId: string, photo: Blob, name: string): Promise<string[]> {
  if (isDemo()) return demo.demoAddItemPhoto(itemId, photo)
  const form = new FormData()
  form.append("photos+", new File([photo], name, { type: "image/jpeg" }))
  const row = await pb.collection("items").update<{ photos?: string[] }>(itemId, form, { fields: "id,photos" })
  return row.photos ?? []
}

export async function removeItemPhoto(itemId: string, name: string): Promise<string[]> {
  if (isDemo()) return demo.demoRemoveItemPhoto(itemId, name)
  const row = await pb
    .collection("items")
    .update<{ photos?: string[] }>(itemId, { "photos-": [name] }, { fields: "id,photos" })
  return row.photos ?? []
}

/** Puts one photo first, the one the website shows. */
export async function makePhotoFirst(itemId: string, name: string, names: string[]): Promise<string[]> {
  if (isDemo()) return demo.demoMakePhotoFirst(itemId, name)
  const order = [name, ...names.filter((other) => other !== name)]
  const row = await pb.collection("items").update<{ photos?: string[] }>(itemId, { photos: order }, { fields: "id,photos" })
  return row.photos ?? []
}

/**
 * The frame an item's photo is cropped to: a retro game's own platform when
 * its title names one, otherwise the kind's (a card, a slab, a box), the
 * same rule the feed's `ratio` uses (lib/publicstock.js).
 */
export async function photoFrame(item: Pick<StockItemRecord, "kind" | "retro_title">): Promise<PhotoFrame> {
  let platform: PlatformKey = platformForItem(item)
  if (!isDemo() && item.kind === "retro" && item.retro_title) {
    try {
      const title = await pb.collection("retro_titles").getOne<{ expand?: { platform?: { key?: string } } }>(
        item.retro_title,
        { expand: "platform", fields: "id,expand.platform.key" }
      )
      const key = title.expand?.platform?.key
      if (key && key in PLATFORMS) platform = key as PlatformKey
    } catch {
      // The kind's frame will do.
    }
  }
  const spec = platformSpec(platform)
  return { platform, ratio: spec.ratio, label: spec.label }
}

// ---------------------------------------------------------------------------
// What the website shows
// ---------------------------------------------------------------------------

/** The feed's first page, as a visitor to the website reads it. */
export async function previewFeed(): Promise<PublicStockPage> {
  if (isDemo()) return demo.demoFeed()
  const response = await fetch(pb.buildURL("/api/public/stock"), { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error("The website feed did not answer. Check the connection and try again.")
  return (await response.json()) as PublicStockPage
}

/** Whether one item is in the feed right now. */
export async function isOnWebsite(sku: string): Promise<boolean> {
  if (isDemo()) return demo.demoIsOnWebsite(sku)
  const response = await fetch(pb.buildURL(`/api/public/stock/${encodeURIComponent(sku)}`), {
    headers: { accept: "application/json" },
  })
  return response.ok
}
