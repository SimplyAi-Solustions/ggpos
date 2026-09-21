/**
 * Aspect ratios and default finishes for every kind of thing GG sells.
 *
 * The values mirror the `platforms` seed table in PocketBase, which Richard can
 * edit; keep the two in step. `ProductImage` reads this table so a row of cards,
 * a row of boxes and a row of carts all line up without cropping anything.
 */

export type ProductFinish = "shadow" | "edge"

export type PlatformKey =
  | "tcg_card"
  | "graded_slab"
  | "gameboy_cart"
  | "snes_pal_box"
  | "n64_box"
  | "megadrive_box"
  | "ps1_case"
  | "ps2_case"
  | "gamecube_case"
  | "switch_case"
  | "gameboy_box"
  | "etb"
  | "booster_box"
  | "booster_pack"
  | "console"
  | "other"

export type PlatformSpec = {
  /** Width and height in the ratio's own units, not pixels. */
  ratio: readonly [number, number]
  /** Cut-out art with transparent corners gets `shadow`; printed boxes get `edge`. */
  finish: ProductFinish
  /** Shown in settings and on the kit page. */
  label: string
}

export const PLATFORMS: Record<PlatformKey, PlatformSpec> = {
  tcg_card: { ratio: [63, 88], finish: "shadow", label: "TCG card" },
  graded_slab: { ratio: [82, 135], finish: "shadow", label: "Graded slab" },
  gameboy_cart: { ratio: [57, 65], finish: "edge", label: "Game Boy cartridge" },
  snes_pal_box: { ratio: [190, 135], finish: "edge", label: "SNES PAL box" },
  n64_box: { ratio: [195, 135], finish: "edge", label: "N64 box" },
  megadrive_box: { ratio: [130, 180], finish: "edge", label: "Mega Drive box" },
  ps1_case: { ratio: [142, 125], finish: "edge", label: "PlayStation jewel case" },
  ps2_case: { ratio: [135, 190], finish: "edge", label: "PS2 / Xbox DVD case" },
  gamecube_case: { ratio: [135, 190], finish: "edge", label: "GameCube case" },
  switch_case: { ratio: [105, 170], finish: "edge", label: "Switch case" },
  gameboy_box: { ratio: [90, 130], finish: "edge", label: "Game Boy box" },
  etb: { ratio: [100, 115], finish: "edge", label: "Elite trainer box" },
  booster_box: { ratio: [4, 3], finish: "edge", label: "Booster box" },
  booster_pack: { ratio: [63, 105], finish: "shadow", label: "Booster pack" },
  console: { ratio: [4, 3], finish: "edge", label: "Console" },
  other: { ratio: [3, 4], finish: "edge", label: "Other" },
}

export const PLATFORM_KEYS = Object.keys(PLATFORMS) as PlatformKey[]

/** Unknown platforms fall back to 3:4 rather than guessing. */
export const FALLBACK_PLATFORM: PlatformKey = "other"

export function platformSpec(platform?: PlatformKey | string): PlatformSpec {
  if (platform && platform in PLATFORMS) {
    return PLATFORMS[platform as PlatformKey]
  }
  return PLATFORMS[FALLBACK_PLATFORM]
}

/**
 * Frame size in CSS pixels from a ratio plus one fixed dimension, so every
 * `<img>` can carry real `width` and `height` attributes and nothing shifts.
 */
export function frameSize(
  ratio: readonly [number, number],
  bounds: { width?: number; height?: number }
): { width: number; height: number } {
  const [rw, rh] = ratio
  if (typeof bounds.height === "number") {
    return { width: Math.round((bounds.height * rw) / rh), height: Math.round(bounds.height) }
  }
  const width = typeof bounds.width === "number" ? bounds.width : 160
  return { width: Math.round(width), height: Math.round((width * rh) / rw) }
}
