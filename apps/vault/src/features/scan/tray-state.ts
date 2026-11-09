import * as React from "react"

import { pb } from "@/lib/pb"

import { readTray, writeTray, type TrayLine } from "./tray"

/** The batch tray, read from sessionStorage once and written back on every change. */
export function useTray() {
  const [lines, setLinesState] = React.useState<TrayLine[]>(() => readTray())
  const setLines = React.useCallback((next: TrayLine[] | ((prev: TrayLine[]) => TrayLine[])) => {
    setLinesState((prev) => {
      const value = typeof next === "function" ? next(prev) : next
      writeTray(value)
      return value
    })
  }, [])
  return { lines, setLines }
}

/** One stock item per unit in the tray, through the items collection (items.pb.js assigns the SKU and title). */
export async function createStockFromTray(lines: readonly TrayLine[]): Promise<number> {
  let made = 0
  for (const line of lines) {
    for (let i = 0; i < line.qty; i++) {
      await pb.collection("items").create({
        kind: "single",
        game: line.card.game_id,
        card: line.card.id,
        condition: line.condition,
        finish: line.card.finishes[0] ?? "",
        qty: 1,
        status: "in_stock",
        market_at_intake: line.pence ?? 0,
      })
      made += 1
    }
  }
  return made
}
