/**
 * The roll and the darkness for price labels, remembered by this browser:
 * the D110 belongs to the Mac it is paired with, not to the shop, so these
 * are the machine's choices rather than a setting on the server.
 */
import { DEFAULT_PRICE_LABEL_SIZE, priceLabelSize, type PriceLabelSizeKey } from "./layout"
import type { Darkness } from "./niimbot"

const SIZE_KEY = "gg-price-label-size"
const DARKNESS_KEY = "gg-price-label-darkness"

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A private window keeps the choice for this page only.
  }
}

export function isDarkness(value: string | null | undefined): value is Darkness {
  return value === "light" || value === "normal" || value === "dark"
}

export function savedLabelSize(): PriceLabelSizeKey {
  return priceLabelSize(read(SIZE_KEY) ?? DEFAULT_PRICE_LABEL_SIZE).key
}

export function saveLabelSize(key: PriceLabelSizeKey) {
  write(SIZE_KEY, key)
}

export function savedDarkness(): Darkness {
  const saved = read(DARKNESS_KEY)
  return isDarkness(saved) ? saved : "normal"
}

export function saveDarkness(darkness: Darkness) {
  write(DARKNESS_KEY, darkness)
}
