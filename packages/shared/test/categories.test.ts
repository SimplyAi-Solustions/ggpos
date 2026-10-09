import { describe, expect, it } from "vitest"

import {
  MAX_CATEGORY_DEPTH,
  STARTER_TREE,
  UNSORTED_KEY,
  buildCategoryTree,
  fileItem,
  flattenCategoryTree,
  isWithin,
  lineageOf,
  moveProblem,
  pathOf,
  starterBranches,
  subtreeHeight,
  type CategoryRow,
} from "../src/categories"

describe("the starter tree", () => {
  const all = starterBranches()

  it("gives every branch a key no other branch has", () => {
    const keys = all.map((entry) => entry.branch.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("keys every branch under its parent's key", () => {
    for (const { branch, parent } of all) {
      if (parent) expect(branch.key.startsWith(`${parent}.`)).toBe(true)
    }
  })

  it("gives no two siblings the same name", () => {
    const seen = new Set<string>()
    for (const { branch, parent } of all) {
      const id = `${parent}::${branch.name.toLowerCase()}`
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })

  it("stays inside the depth limit", () => {
    expect(Math.max(...all.map((entry) => entry.depth))).toBeLessThan(MAX_CATEGORY_DEPTH)
  })

  it("puts the brand before the type, as the shop asked", () => {
    const names = new Map(all.map((entry) => [entry.branch.key, entry.branch.name]))
    expect(names.get("tcg.pokemon.singles")).toBe("Singles")
    expect(names.get("tcg.pokemon.sealed.etbs")).toBe("ETBs and collections")
    expect(names.get("retro.sega.megadrive.games")).toBe("Games")
    expect(names.get("retro.sega.dreamcast.accessories")).toBe("Accessories")
    expect(names.get("retro.sega.gamegear")).toBe("Game Gear")
  })

  it("ends with Unsorted at the top level", () => {
    expect(STARTER_TREE[STARTER_TREE.length - 1]?.key).toBe(UNSORTED_KEY)
  })

  it("only defaults to kinds an item can have", () => {
    for (const { branch } of all) {
      const kind = branch.defaults?.kind
      if (kind) expect(["single", "graded", "retro", "sealed", "accessory", "other"]).toContain(kind)
    }
  })
})

describe("fileItem", () => {
  const keys = new Set(starterBranches().map((entry) => entry.branch.key))

  it("files cards by game and kind", () => {
    expect(fileItem({ kind: "single", game: "pokemon" })).toBe("tcg.pokemon.singles")
    expect(fileItem({ kind: "graded", game: "mtg" })).toBe("tcg.mtg.graded")
    expect(fileItem({ kind: "accessory", game: "lorcana" })).toBe("tcg.lorcana.accessories")
  })

  it("files sealed product by its shape when it has one", () => {
    expect(fileItem({ kind: "sealed", game: "pokemon", platform: "etb" })).toBe("tcg.pokemon.sealed.etbs")
    expect(fileItem({ kind: "sealed", game: "onepiece", platform: "booster_box" })).toBe("tcg.onepiece.sealed.boxes")
    expect(fileItem({ kind: "sealed", game: "yugioh" })).toBe("tcg.yugioh.sealed")
  })

  it("files a boxed retro game under its console", () => {
    expect(fileItem({ kind: "retro", game: "retro", platform: "megadrive_box" })).toBe("retro.sega.megadrive.games")
    expect(fileItem({ kind: "retro", game: "retro", platform: "gameboy_cart" })).toBe("retro.nintendo.gameboy.games")
  })

  it("leaves what the facts cannot settle in Unsorted", () => {
    // A PS2 case frames Xbox games too, and a console could be anyone's.
    expect(fileItem({ kind: "retro", game: "retro", platform: "ps2_case" })).toBe(UNSORTED_KEY)
    expect(fileItem({ kind: "retro", game: "retro", platform: "console" })).toBe(UNSORTED_KEY)
    expect(fileItem({ kind: "retro", game: "retro" })).toBe(UNSORTED_KEY)
    expect(fileItem({ kind: "other", game: "pokemon" })).toBe(UNSORTED_KEY)
    expect(fileItem({ kind: "single" })).toBe(UNSORTED_KEY)
  })

  it("files a non-card accessory under Accessories", () => {
    expect(fileItem({ kind: "accessory", game: "retro" })).toBe("accessories")
  })

  it("only ever answers a key the starter tree has", () => {
    const kinds = ["single", "graded", "retro", "sealed", "accessory", "other"]
    const games = ["pokemon", "mtg", "yugioh", "onepiece", "lorcana", "retro", ""]
    const platforms = ["", "etb", "booster_box", "booster_pack", "megadrive_box", "snes_pal_box", "n64_box",
      "gamecube_case", "switch_case", "gameboy_cart", "gameboy_box", "ps1_case", "ps2_case", "console", "other"]
    for (const kind of kinds) {
      for (const game of games) {
        for (const platform of platforms) {
          expect(keys.has(fileItem({ kind, game, platform }))).toBe(true)
        }
      }
    }
  })
})

describe("the derived fields", () => {
  it("builds the lineage and the path from the parent's", () => {
    expect(lineageOf("", "a")).toBe("|a|")
    expect(lineageOf("|a|", "b")).toBe("|a|b|")
    expect(pathOf("", "Retro")).toBe("Retro")
    expect(pathOf("Retro / Sega", "Mega Drive")).toBe("Retro / Sega / Mega Drive")
  })

  it("matches a whole subtree by lineage, and only whole ids", () => {
    expect(isWithin("|a|b|c|", "b")).toBe(true)
    expect(isWithin("|a|b|c|", "c")).toBe(true)
    expect(isWithin("|a|bb|", "b")).toBe(false)
    expect(isWithin("|a|", "")).toBe(false)
  })

  it("refuses a move into the branch's own subtree, or past the depth limit", () => {
    expect(moveProblem("b", { lineage: "|a|b|c|", depth: 2 }, 0)).toBe(
      "A branch cannot go inside itself or one of its own branches."
    )
    expect(moveProblem("b", { lineage: "|a|b|", depth: 1 }, 0)).not.toBeNull()
    expect(moveProblem("x", { lineage: "|a|", depth: 0 }, 2)).toBeNull()
    expect(moveProblem("x", { lineage: "|p|", depth: MAX_CATEGORY_DEPTH - 2 }, 0)).toBeNull()
    expect(moveProblem("x", { lineage: "|p|", depth: MAX_CATEGORY_DEPTH - 2 }, 1)).toMatch(/levels deep at most/)
    expect(moveProblem("x", null, MAX_CATEGORY_DEPTH - 1)).toBeNull()
    expect(moveProblem("x", null, MAX_CATEGORY_DEPTH)).not.toBeNull()
  })
})

describe("buildCategoryTree", () => {
  const rows: CategoryRow[] = [
    { id: "r", name: "Retro", parent: "", sort: 20, active: true },
    { id: "t", name: "Trading cards", parent: "", sort: 10, active: true },
    { id: "s", name: "Sega", parent: "r", sort: 10, active: false },
    { id: "m", name: "Mega Drive", parent: "s", sort: 10, active: true },
    { id: "n", name: "Nintendo", parent: "r", sort: 10, active: true },
    { id: "o", name: "Orphan", parent: "gone", sort: 5, active: true },
  ]
  const tree = buildCategoryTree(rows)
  const flat = flattenCategoryTree(tree)

  it("orders siblings by sort, then by name", () => {
    expect(tree.map((node) => node.row.id)).toEqual(["o", "t", "r"])
    expect(tree[2]?.children.map((node) => node.row.name)).toEqual(["Nintendo", "Sega"])
  })

  it("works out each node's depth, path and lineage", () => {
    const megaDrive = flat.find((node) => node.row.id === "m")
    expect(megaDrive).toMatchObject({ depth: 2, path: "Retro / Sega / Mega Drive", lineage: "|r|s|m|" })
  })

  it("hides everything under a switched-off branch", () => {
    expect(flat.find((node) => node.row.id === "s")?.visible).toBe(false)
    expect(flat.find((node) => node.row.id === "m")?.visible).toBe(false)
    expect(flat.find((node) => node.row.id === "n")?.visible).toBe(true)
  })

  it("lists depth first, and puts a row whose parent is missing at the top", () => {
    expect(flat.map((node) => node.row.id)).toEqual(["o", "t", "r", "n", "s", "m"])
  })

  it("measures how deep a subtree goes", () => {
    expect(subtreeHeight(tree[2]!)).toBe(2)
    expect(subtreeHeight(tree[1]!)).toBe(0)
  })

  it("survives a cycle in bad data without looping", () => {
    const loop = buildCategoryTree([
      { id: "a", name: "A", parent: "b", sort: 0, active: true },
      { id: "b", name: "B", parent: "a", sort: 0, active: true },
    ])
    expect(flattenCategoryTree(loop)).toHaveLength(0)
  })
})
