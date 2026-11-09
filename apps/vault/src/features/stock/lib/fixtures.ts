import type { InventoryItem } from "../types"

let next = 0

/** A held item for tests and demos, with every field filled. */
export function makeItem(over: Partial<InventoryItem> = {}): InventoryItem {
  next += 1
  return {
    id: `item${next}`,
    sku: `GGS${String(next).padStart(6, "0")}`,
    kind: "single",
    title: `Item ${next}`,
    card: "",
    game: "pokemon",
    game_name: "Pokemon",
    set_code: "",
    number: "",
    finish: "",
    condition: "NM",
    grade_company: "",
    grade: "",
    qty: 1,
    price: 1000,
    cost: 500,
    market: 1000,
    market_source: "cardmarket",
    location: "",
    location_name: "",
    category: "",
    category_path: "",
    status: "in_stock",
    image: "",
    notes: "",
    label_printed_at: "",
    hand_priced: false,
    acquired_at: "",
    created: `2026-11-0${(next % 9) + 1} 10:00:00.000Z`,
    updated: "",
    ...over,
  }
}
