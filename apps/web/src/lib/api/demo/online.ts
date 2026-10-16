/**
 * Stock on the website and item photos in demo mode: the same calls as
 * `lib/api/online.ts`, answered from the demo stock and this module's own
 * memory for the tab, so the Website switch, the bulk action, Settings,
 * Website and the photo flow all work with no server.
 *
 * The feed is built with the same shared rule and shapes the server uses
 * (`@gg/shared` online.ts), so what Settings previews here is what the
 * website would be sent.
 */
import {
  conditionLabel,
  isOnline,
  PUBLIC_STOCK_PER_PAGE,
  ratioOf,
  readOnlineSettings,
  type OnlineSettings,
  type PublicStockItem,
  type PublicStockPage,
} from "@gg/shared"

import { DEMO_GAMES } from "@/lib/api/fixtures"
import { platformForItem } from "@/lib/api/item-shape"
import { platformSpec } from "@/design/platforms"
import { demoCategoryPaths } from "@/lib/api/demo/categories"
import { demoCardImage, ensureSeeded, itemStore } from "@/lib/api/demo/store"
import type { ItemPhoto, OnlineBranch, OnlineSettingsRow } from "@/lib/api/online"
import type { StockItemRecord } from "@/lib/api/types"

const SETTINGS_ID = "settings_demo"

let settings: OnlineSettings = readOnlineSettings({ enabled: true, min_price: 0, hide_qty: false })
const branches = new Set<string>()
const photos = new Map<string, ItemPhoto[]>()
let sequence = 0

function itemById(id: string): StockItemRecord {
  ensureSeeded()
  const item = itemStore().find((row) => row.id === id)
  if (!item) throw new Error("That item is no longer in stock.")
  return item
}

function touch(item: StockItemRecord) {
  item.updated = new Date().toISOString()
}

export function demoOnlineSettings(): OnlineSettingsRow {
  return { id: SETTINGS_ID, ...settings }
}

export function demoSaveOnlineSettings(value: OnlineSettings): OnlineSettingsRow {
  settings = readOnlineSettings(value)
  return demoOnlineSettings()
}

export function demoOnlineBranches(): OnlineBranch[] {
  const paths = demoCategoryPaths()
  return [...branches]
    .filter((id) => paths.has(id))
    .map((id) => ({ id, path: paths.get(id) ?? "" }))
    .sort((a, b) => a.path.localeCompare(b.path, "en-GB"))
}

export function demoSetBranchOnline(id: string, on: boolean): void {
  if (on) branches.add(id)
  else branches.delete(id)
}

export function demoSetItemsOnline(ids: string[], on: boolean): number {
  for (const id of ids) {
    const item = itemById(id)
    item.show_online = on
    touch(item)
  }
  return ids.length
}

export function demoItemPhotos(itemId: string): ItemPhoto[] {
  return photos.get(itemId) ?? []
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("That photo could not be read. Take it again."))
    reader.readAsDataURL(blob)
  })
}

function keep(item: StockItemRecord, list: ItemPhoto[]): string[] {
  photos.set(item.id, list)
  item.photos = list.map((photo) => photo.name)
  touch(item)
  return item.photos
}

export async function demoAddItemPhoto(itemId: string, photo: Blob): Promise<string[]> {
  const item = itemById(itemId)
  const url = await readAsDataUrl(photo)
  sequence += 1
  const name = `demo_photo_${sequence}.jpg`
  return keep(item, [...demoItemPhotos(itemId), { name, url, thumb: url }])
}

export function demoRemoveItemPhoto(itemId: string, name: string): string[] {
  const item = itemById(itemId)
  return keep(item, demoItemPhotos(itemId).filter((photo) => photo.name !== name))
}

export function demoMakePhotoFirst(itemId: string, name: string): string[] {
  const item = itemById(itemId)
  const list = demoItemPhotos(itemId)
  const first = list.find((photo) => photo.name === name)
  return keep(item, first ? [first, ...list.filter((photo) => photo.name !== name)] : list)
}

/** The demo's own convention: a row with no quantity is one on the shelf. */
function asOnline(item: StockItemRecord) {
  return { show_online: item.show_online, status: item.status, qty: item.qty ?? 1, price: item.price }
}

/** One demo item in the feed's own shape. */
function shape(item: StockItemRecord, paths: Map<string, string>): PublicStockItem {
  const [width, height] = platformSpec(platformForItem(item)).ratio
  const photo = demoItemPhotos(item.id)[0]
  const art = demoCardImage(item.card) ?? ""
  const out: PublicStockItem = {
    sku: item.sku,
    title: item.title || item.sku,
    price: item.price ?? 0,
    condition: conditionLabel(item),
    finish: item.finish ?? "",
    game: DEMO_GAMES.find((game) => game.id === item.game)?.name ?? "",
    category: item.category ? { id: item.category, path: paths.get(item.category) ?? "" } : null,
    image: {
      small: photo ? photo.thumb : art,
      large: photo ? photo.url : art,
      ratio: ratioOf(width, height),
    },
    updated: item.updated ?? item.created ?? new Date().toISOString(),
  }
  if (!settings.hide_qty) out.qty = item.qty ?? 1
  return out
}

export function demoFeed(): PublicStockPage {
  ensureSeeded()
  const paths = demoCategoryPaths()
  const shown = settings.enabled ? itemStore().filter((item) => isOnline(asOnline(item), settings)) : []
  const newest = [...shown].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""))
  return {
    items: newest.slice(0, PUBLIC_STOCK_PER_PAGE).map((item) => shape(item, paths)),
    page: 1,
    per_page: PUBLIC_STOCK_PER_PAGE,
    total: shown.length,
  }
}

export function demoIsOnWebsite(sku: string): boolean {
  ensureSeeded()
  const item = itemStore().find((row) => row.sku === sku)
  return Boolean(item && settings.enabled && isOnline(asOnline(item), settings))
}
