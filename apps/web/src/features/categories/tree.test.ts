import { describe, expect, it } from "vitest"
import {
  buildCategoryTree,
  flattenCategoryTree,
  type CategoryBranch,
  type CategoryRow,
} from "@gg/shared"

import {
  canTake,
  defaultOpen,
  foldText,
  heightOf,
  lastLevels,
  planDrop,
  planMoveTo,
  planNudge,
  searchBranches,
  shownRows,
  trailOf,
  zoneFor,
} from "@/features/categories/tree"

/**
 *   Trading cards (tcg)
 *     Pokémon (pkm)
 *       Singles (pkm_s)
 *       Graded (pkm_g)
 *       Sealed (pkm_x)
 *         Booster packs (pkm_x_p)
 *     Magic (mtg)
 *       Singles (mtg_s)
 *   Retro (retro), switched off
 *     Sega (sega)
 *   Unsorted (unsorted)
 */
const ROWS: (CategoryRow & { key: string })[] = [
  { id: "tcg", name: "Trading cards", parent: "", sort: 10, active: true, key: "tcg" },
  { id: "pkm", name: "Pokémon", parent: "tcg", sort: 10, active: true, key: "" },
  { id: "pkm_s", name: "Singles", parent: "pkm", sort: 10, active: true, key: "" },
  { id: "pkm_g", name: "Graded", parent: "pkm", sort: 20, active: true, key: "" },
  { id: "pkm_x", name: "Sealed", parent: "pkm", sort: 30, active: true, key: "" },
  { id: "pkm_x_p", name: "Booster packs", parent: "pkm_x", sort: 10, active: true, key: "" },
  { id: "mtg", name: "Magic", parent: "tcg", sort: 20, active: true, key: "" },
  { id: "mtg_s", name: "Singles", parent: "mtg", sort: 10, active: true, key: "" },
  { id: "retro", name: "Retro", parent: "", sort: 20, active: false, key: "" },
  { id: "sega", name: "Sega", parent: "retro", sort: 10, active: true, key: "" },
  { id: "unsorted", name: "Unsorted", parent: "", sort: 30, active: true, key: "unsorted" },
]

function tree(rows = ROWS): CategoryBranch[] {
  return flattenCategoryTree(buildCategoryTree(rows)).map((node) => ({
    id: node.row.id,
    name: node.row.name,
    parent: node.row.parent,
    path: node.path,
    lineage: node.lineage,
    depth: node.depth,
    sort: node.row.sort,
    active: node.row.active,
    visible: node.visible,
    key: node.row.key,
    image_url: "",
    defaults: { kind: "", game: "", platform: "", tax_scheme: "" },
    counts: { children: 0, products: 0, items: 0, items_total: 0 },
  }))
}

/** A chain of `levels` branches, each inside the one before. */
function chain(levels: number): CategoryBranch[] {
  const rows: CategoryRow[] = []
  for (let index = 0; index < levels; index++) {
    rows.push({
      id: `c${index}`,
      name: `Level ${index}`,
      parent: index === 0 ? "" : `c${index - 1}`,
      sort: 10,
      active: true,
    })
  }
  rows.push({ id: "loose", name: "Loose", parent: "", sort: 20, active: true })
  rows.push({ id: "loose_child", name: "Loose child", parent: "loose", sort: 10, active: true })
  return tree(rows.map((row) => ({ ...row, key: "" })))
}

describe("reading the tree", () => {
  it("folds accents and case", () => {
    expect(foldText("  Pokémon ")).toBe("pokemon")
  })

  it("walks a branch's trail from the top", () => {
    expect(trailOf(tree(), "pkm_x_p").map((branch) => branch.name)).toEqual([
      "Trading cards",
      "Pokémon",
      "Sealed",
      "Booster packs",
    ])
  })

  it("keeps the last two levels for a column", () => {
    expect(lastLevels("Trading cards / Pokémon / Singles")).toBe("Pokémon / Singles")
    expect(lastLevels("Unsorted")).toBe("Unsorted")
    expect(lastLevels("")).toBe("")
  })

  it("measures how far a subtree reaches down", () => {
    const branches = tree()
    expect(heightOf(branches, "tcg")).toBe(3)
    expect(heightOf(branches, "pkm_s")).toBe(0)
  })
})

describe("the picker's search", () => {
  it("matches any level and accents do not matter", () => {
    const found = searchBranches(tree(), "pokemon singles").map((match) => match.branch.id)
    expect(found).toEqual(["pkm_s"])
  })

  it("puts a branch whose own name matches before the ones beneath it", () => {
    const found = searchBranches(tree(), "pokemon").map((match) => match.branch.id)
    expect(found[0]).toBe("pkm")
    expect(found).toEqual(["pkm", "pkm_s", "pkm_g", "pkm_x", "pkm_x_p"])
  })

  it("marks the levels the words were found in", () => {
    const [first] = searchBranches(tree(), "magic sing")
    expect(first?.levels).toEqual([
      { name: "Trading cards", match: false },
      { name: "Magic", match: true },
      { name: "Singles", match: true },
    ])
  })

  it("leaves out what the caller does not offer", () => {
    const found = searchBranches(tree(), "sega", { offered: (branch) => branch.visible })
    expect(found).toEqual([])
    expect(searchBranches(tree(), "")).toEqual([])
  })
})

describe("the editor's rows", () => {
  it("opens the top level and nothing else at first", () => {
    const branches = tree()
    const rows = shownRows(branches, defaultOpen(branches)).map((branch) => branch.id)
    expect(rows).toEqual(["tcg", "pkm", "mtg", "retro", "sega", "unsorted"])
  })

  it("shows a branch only when everything above it is open", () => {
    const rows = shownRows(tree(), new Set(["pkm"])).map((branch) => branch.id)
    expect(rows).toEqual(["tcg", "retro", "unsorted"])
  })
})

describe("what a drop means", () => {
  it("reads the edges of a row as beside it and the middle as inside", () => {
    expect(zoneFor(4, 56)).toBe("before")
    expect(zoneFor(28, 56)).toBe("inside")
    expect(zoneFor(50, 56)).toBe("after")
  })

  it("reorders among the same siblings", () => {
    expect(planDrop(tree(), "pkm_x", "pkm_s", "before")).toEqual({
      route: "reorder",
      parent: "pkm",
      order: ["pkm_x", "pkm_s", "pkm_g"],
      sentence: "Put Sealed before Singles.",
    })
    expect(planDrop(tree(), "pkm_s", "pkm_x", "after")).toEqual({
      route: "reorder",
      parent: "pkm",
      order: ["pkm_g", "pkm_x", "pkm_s"],
      sentence: "Put Singles last in Pokémon.",
    })
  })

  it("changes nothing for a drop where the branch already is", () => {
    expect(planDrop(tree(), "pkm_s", "pkm_g", "before")).toBeNull()
    expect(planDrop(tree(), "pkm_s", "pkm_s", "inside")).toBeNull()
    expect(planDrop(tree(), "pkm_x", "pkm", "inside")).toBeNull()
  })

  it("moves under another parent, before a branch or last", () => {
    expect(planDrop(tree(), "mtg_s", "pkm_g", "before")).toEqual({
      route: "move",
      id: "mtg_s",
      parent: "pkm",
      before: "pkm_g",
      sentence: "Move Singles into Pokémon, before Graded.",
    })
    expect(planDrop(tree(), "mtg_s", "pkm_g", "after")).toMatchObject({
      route: "move",
      parent: "pkm",
      before: "pkm_x",
    })
    expect(planDrop(tree(), "unsorted", "pkm_x", "inside")).toEqual({
      route: "move",
      id: "unsorted",
      parent: "pkm_x",
      sentence: "Move Unsorted into Sealed, last.",
    })
    // After the last sibling is last.
    const last = planDrop(tree(), "mtg_s", "pkm_x", "after")
    expect(last).toMatchObject({ route: "move", parent: "pkm" })
    expect(last && "before" in last ? last.before : undefined).toBeUndefined()
  })

  it("never drops a branch into itself or its own subtree", () => {
    const sentence = "A branch cannot go inside itself or one of its own branches."
    expect(planDrop(tree(), "pkm", "pkm_x_p", "inside")).toEqual({ problem: sentence })
    expect(planDrop(tree(), "pkm", "pkm_x_p", "before")).toEqual({ problem: sentence })
    expect(planDrop(tree(), "tcg", "pkm", "inside")).toEqual({ problem: sentence })
  })

  it("keeps the whole subtree within eight levels", () => {
    const branches = chain(8)
    expect(planDrop(branches, "loose", "c6", "inside")).toEqual({
      problem: "Branches go 8 levels deep at most. Put this one higher up.",
    })
    // A leaf can go one level lower than a branch with a child under it.
    expect(planDrop(branches, "loose_child", "c6", "inside")).toMatchObject({ route: "move" })
  })

  it("moves through the picker, last under the chosen parent", () => {
    expect(planMoveTo(tree(), "mtg_s", "")).toEqual({
      route: "move",
      id: "mtg_s",
      parent: "",
      sentence: "Move Singles into the top level, last.",
    })
    expect(planMoveTo(tree(), "pkm_s", "pkm")).toBeNull()
    expect(planMoveTo(tree(), "tcg", "pkm_x")).toEqual({
      problem: "A branch cannot go inside itself or one of its own branches.",
    })
  })

  it("nudges one place up or down, and not past either end", () => {
    expect(planNudge(tree(), "pkm_g", -1)).toMatchObject({
      route: "reorder",
      order: ["pkm_g", "pkm_s", "pkm_x"],
    })
    expect(planNudge(tree(), "pkm_s", -1)).toBeNull()
    expect(planNudge(tree(), "pkm_x", 1)).toBeNull()
  })

  it("offers only visible parents outside the branch's own subtree", () => {
    const branches = tree()
    const offered = branches.filter((branch) => canTake("pkm", branch))
    expect(offered.map((branch) => branch.id)).toEqual(["tcg", "mtg", "mtg_s", "unsorted"])
  })
})
