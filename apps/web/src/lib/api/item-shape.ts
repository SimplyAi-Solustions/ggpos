/**
 * Pure helpers that turn an `items` row into the three things every screen
 * needs from it: the frame its picture goes in, the one grey line under its
 * title, and the label it prints on.
 *
 * Shared by the live and the demo implementations so a card looks the same
 * whichever one answered.
 */
import type { PlatformKey } from "@/design/platforms"
import type { ItemKind, ItemRecord, LabelTemplateKey } from "@/lib/api/types"

/**
 * The `ProductImage` frame for a stock row. `items` carries no platform of
 * its own: a card is a card, a graded card is a slab, and everything else
 * falls back to the table's 3:4 default until a retro title names a platform.
 */
export function platformForItem(item: Pick<ItemRecord, "kind">): PlatformKey {
  switch (item.kind) {
    case "single":
      return "tcg_card"
    case "graded":
      return "graded_slab"
    case "sealed":
      return "etb"
    default:
      return "other"
  }
}

/** "SV151 199/165 Holo", or "PAL Boxed" for retro. Never longer than a line. */
export function itemDetailLine(item: ItemRecord): string {
  const parts =
    item.kind === "retro"
      ? [item.region, item.completeness, item.finish]
      : [item.set_code?.toUpperCase(), item.number, item.finish]
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => (part.length <= 4 ? part.toUpperCase() : capitalise(part)))
    .join(" ")
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Which of the four label layouts a thing gets: small accessories take the
 * 25x15 sleeve, boxed retro takes the 50x30, everything else the 40x20 top
 * loader. See docs/label-spec.md.
 */
export function templateForItem(
  kind: ItemKind,
  completeness?: string
): LabelTemplateKey {
  if (kind === "accessory") return "sleeve_25x15"
  if (kind === "retro" && (completeness === "boxed" || completeness === "cib")) {
    return "retro_50x30"
  }
  return "toploader_40x20"
}
