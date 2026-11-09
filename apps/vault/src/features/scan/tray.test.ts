import { describe, expect, it } from "vitest"

import { addManyToDealHref } from "./addToDeal"
import { addLine, readTray, removeLine, trayCount, trayTotal, trayUnits, writeTray, type TrayLine } from "./tray"

const card = (id: string): TrayLine["card"] => ({ id, name: id, set_name: "Set", number: "1", set_total: null, image_small: "", game_id: "g", finishes: [] })

describe("scan tray", () => {
  it("adds a line per card and condition, stacking repeats", () => {
    let lines = addLine([], card("a"), "NM", 1000)
    lines = addLine(lines, card("a"), "NM", 1100)
    lines = addLine(lines, card("a"), "LP", 800)
    lines = addLine(lines, card("b"), "NM", null)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ condition: "NM", qty: 2, pence: 1100 })
    expect(trayCount(lines)).toBe(4)
    expect(trayTotal(lines)).toBe(2200 + 800)
  })

  it("removes one unit at a time and drops the line at zero", () => {
    let lines = addLine(addLine([], card("a"), "NM", 100), card("a"), "NM", 100)
    lines = removeLine(lines, "a", "NM")
    expect(lines[0]!.qty).toBe(1)
    lines = removeLine(lines, "a", "NM")
    expect(lines).toEqual([])
  })

  it("flattens to one unit per card for the hand-offs", () => {
    const lines = addLine(addLine(addLine([], card("a"), "NM", 1), card("a"), "NM", 1), card("b"), "LP", 2)
    expect(trayUnits(lines)).toEqual([
      { cardId: "a", condition: "NM" },
      { cardId: "a", condition: "NM" },
      { cardId: "b", condition: "LP" },
    ])
    expect(addManyToDealHref(null, trayUnits(lines))).toBe("/deals?add=a%2Ca%2Cb&condition=NM%2CNM%2CLP")
    expect(addManyToDealHref("d1", trayUnits(lines).slice(0, 1))).toBe("/deals/d1?add=a&condition=NM")
  })

  it("survives a reload through sessionStorage", () => {
    writeTray(addLine([], card("a"), "HP", 50))
    expect(readTray()).toHaveLength(1)
    sessionStorage.setItem("gg-vault-scan-tray", "nope")
    expect(readTray()).toEqual([])
    sessionStorage.clear()
  })
})
