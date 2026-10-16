import { ClientResponseError } from "pocketbase"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { starterBranches } from "@gg/shared"

import {
  DEMO_STARTER_SIZE,
  demoAssignCategory,
  demoCategoryId,
  demoCategoryTree,
  demoCreateCategory,
  demoDeleteCategory,
  demoMoveCategory,
  demoReorderCategories,
  demoTopBranches,
  demoUpdateCategory,
  resetDemoCategories,
} from "@/lib/api/demo/categories"
import { demoCatalogue, demoTillBranch } from "@/lib/api/demo/till"
import { listItems } from "@/lib/api/demo/items"
import { itemStore } from "@/lib/api/demo/store"

/**
 * The demo tree stands in for the server's routes
 * (docs/api-contract-inventory.md, sections 1.2 and 1.3), so it has to
 * answer the same shapes and refuse in the same words.
 */

const POKEMON = demoCategoryId("tcg.pokemon")
const SINGLES = demoCategoryId("tcg.pokemon.singles")
const GRADED = demoCategoryId("tcg.pokemon.graded")
const SEALED = demoCategoryId("tcg.pokemon.sealed")
const ACCESSORIES = demoCategoryId("tcg.pokemon.accessories")
const MTG = demoCategoryId("tcg.mtg")
const UNSORTED = demoCategoryId("unsorted")

function role(name: string) {
  localStorage.setItem("gg-demo-staff", JSON.stringify({ id: `staff_${name}`, role: name }))
}

function refusal(run: () => unknown): { status: number; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ClientResponseError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error("Expected a refusal.")
}

function branch(id: string) {
  return demoCategoryTree().branches.find((entry) => entry.id === id)
}

beforeEach(() => {
  role("admin")
  resetDemoCategories()
})

afterEach(() => localStorage.clear())

describe("the tree route", () => {
  it("answers the starter tree, depth first, with stable ids and derived fields", () => {
    const { branches } = demoCategoryTree()
    expect(branches).toHaveLength(DEMO_STARTER_SIZE)
    expect(DEMO_STARTER_SIZE).toBe(starterBranches().length)
    expect(branches[0]?.name).toBe("Trading cards")
    expect(branch(SINGLES)).toMatchObject({
      path: "Trading cards / Pokémon / Singles",
      depth: 2,
      parent: POKEMON,
      key: "tcg.pokemon.singles",
      visible: true,
      defaults: { kind: "single", game: "game_pokemon", tax_scheme: "margin" },
    })
    expect(branch(SINGLES)?.lineage).toBe(`|${demoCategoryId("tcg")}|${POKEMON}|${SINGLES}|`)
  })

  it("files the demo stock by fileItem and counts the shelf at every level", () => {
    const charizard = itemStore().find((item) => item.title === "Charizard ex")
    expect(charizard?.category).toBeUndefined()
    demoCategoryTree()
    expect(charizard?.category).toBe(SINGLES)
    // Charizard and the held Pidgeot are singles; only Charizard is on the shelf.
    expect(branch(SINGLES)?.counts.items).toBe(1)
    expect(branch(POKEMON)?.counts.items_total).toBeGreaterThanOrEqual(1)
    // The two rows the rule cannot place wait in Unsorted.
    expect(branch(UNSORTED)?.counts.items).toBe(2)
    // The membership lives in Services > Memberships.
    expect(branch(demoCategoryId("services.memberships"))?.counts.products).toBe(1)
  })

  it("lists the visible top-level branches for the till's rail", () => {
    const names = demoTopBranches().map((chip) => chip.name)
    expect(names[0]).toBe("Trading cards")
    expect(names).toContain("Unsorted")
    demoUpdateCategory(demoCategoryId("food"), { active: false })
    expect(demoTopBranches().map((chip) => chip.name)).not.toContain("Drinks and snacks")
    expect(demoCatalogue().branches?.map((chip) => chip.name)).not.toContain("Drinks and snacks")
  })
})

describe("moving and reordering", () => {
  it("moves a branch under another parent, before a sibling, and rewrites its subtree", () => {
    const retro = demoCategoryId("retro")
    const tree = demoMoveCategory(SEALED, { parent: "", before: retro })
    const top = tree.branches.filter((entry) => entry.depth === 0).map((entry) => entry.id)
    expect(top.slice(0, 3)).toEqual([demoCategoryId("tcg"), SEALED, retro])
    const packs = tree.branches.find((entry) => entry.id === demoCategoryId("tcg.pokemon.sealed.packs"))
    expect(packs?.path).toBe("Sealed / Booster packs")
    expect(packs?.depth).toBe(1)
    expect(packs?.lineage).toBe(`|${SEALED}|${packs?.id}|`)
  })

  it("refuses a move into its own subtree, too deep, or before a stranger", () => {
    expect(refusal(() => demoMoveCategory(POKEMON, { parent: SINGLES }))).toEqual({
      status: 400,
      message: "A branch cannot go inside itself or one of its own branches.",
    })
    expect(refusal(() => demoMoveCategory(SINGLES, { parent: MTG, before: GRADED }))).toEqual({
      status: 400,
      message: "That branch is not under the new parent.",
    })
    // Singles under Magic, which already has Singles.
    expect(refusal(() => demoMoveCategory(SINGLES, { parent: MTG }))).toEqual({
      status: 400,
      message: "There is already a branch called Singles here.",
    })
  })

  it("reorders every child once, and refuses an order that does not match", () => {
    const tree = demoReorderCategories({ parent: POKEMON, order: [ACCESSORIES, SINGLES, GRADED, SEALED] })
    const children = tree.branches.filter((entry) => entry.parent === POKEMON).map((entry) => entry.id)
    expect(children).toEqual([ACCESSORIES, SINGLES, GRADED, SEALED])
    expect(refusal(() => demoReorderCategories({ parent: POKEMON, order: [SINGLES, GRADED] }))).toEqual({
      status: 400,
      message: "That order does not match the branches here. Reload and try again.",
    })
  })

  it("asks a manager when the role cannot manage stock", () => {
    role("staff")
    const error = refusal(() => demoReorderCategories({ parent: POKEMON, order: [] }))
    expect(error).toEqual({ status: 403, message: "A manager needs to approve this." })
  })
})

describe("filing", () => {
  it("files Unsorted rows into a branch and says how many", () => {
    demoCategoryTree()
    const unsorted = itemStore().filter((item) => item.category === UNSORTED)
    const result = demoAssignCategory({ category: ACCESSORIES, items: unsorted.map((item) => item.id) })
    expect(result).toEqual({ items: 2, products: 0 })
    expect(branch(UNSORTED)?.counts.items).toBe(0)
    expect(listItems({ category: POKEMON }, 1).items.map((row) => row.title)).toContain(
      "Pikachu plush, 20 cm"
    )
  })

  it("refuses a missing row, a missing branch and more than 500", () => {
    expect(refusal(() => demoAssignCategory({ category: SINGLES, items: ["nope"] }))).toEqual({
      status: 404,
      message: "One of those was not found. Reload and try again.",
    })
    expect(refusal(() => demoAssignCategory({ category: "nope", items: [] }))).toEqual({
      status: 400,
      message: "That branch was not found.",
    })
    const many = Array.from({ length: 501 }, (_, index) => `item_${index}`)
    expect(refusal(() => demoAssignCategory({ category: SINGLES, items: many }))).toEqual({
      status: 400,
      message: "File up to 500 at a time.",
    })
  })

  it("filters stock by a branch and everything beneath it", () => {
    const titles = listItems({ category: POKEMON }, 1).items.map((row) => row.title)
    expect(titles).toContain("Charizard ex")
    expect(titles).not.toContain("Mabel, Heir to Cragflame")
    const row = listItems({ category: SINGLES, search: "charizard" }, 1).items[0]
    expect(row?.categoryPath).toBe("Trading cards / Pokémon / Singles")
  })
})

describe("adding, renaming, switching off and deleting", () => {
  it("adds a branch last among its siblings and refuses a clash or no name", () => {
    const added = demoCreateCategory({ name: " Promos ", parent: POKEMON })
    expect(added).toMatchObject({ name: "Promos", path: "Trading cards / Pokémon / Promos" })
    const last = demoCategoryTree().branches.filter((entry) => entry.parent === POKEMON).at(-1)
    expect(last?.id).toBe(added.id)
    expect(refusal(() => demoCreateCategory({ name: "promos", parent: POKEMON }))).toEqual({
      status: 400,
      message: "There is already a branch called promos here.",
    })
    expect(refusal(() => demoCreateCategory({ name: "  ", parent: POKEMON }))).toEqual({
      status: 400,
      message: "Give the branch a name.",
    })
  })

  it("hides a switched-off branch and everything beneath it", () => {
    demoUpdateCategory(POKEMON, { active: false })
    expect(branch(POKEMON)?.visible).toBe(false)
    expect(branch(SINGLES)?.visible).toBe(false)
    expect(branch(SINGLES)?.active).toBe(true)
    expect(refusal(() => demoTillBranch(SINGLES))).toEqual({
      status: 404,
      message: "That branch was not found.",
    })
  })

  it("keeps Unsorted, and deletes only an empty branch", () => {
    const stays = { status: 409, message: "Unsorted is where stock with no branch goes, so it stays." }
    expect(refusal(() => demoDeleteCategory(UNSORTED))).toEqual(stays)
    expect(refusal(() => demoUpdateCategory(UNSORTED, { active: false }))).toEqual(stays)
    expect(refusal(() => demoDeleteCategory(POKEMON))).toEqual({
      status: 409,
      message:
        "Pokémon still holds 4 branches. Move them out or switch the branch off.",
    })
    expect(refusal(() => demoDeleteCategory(SINGLES))).toEqual({
      status: 409,
      message: "Singles still holds 2 stock rows. Move them out or switch the branch off.",
    })
    expect(refusal(() => demoDeleteCategory(demoCategoryId("services")))).toEqual({
      status: 409,
      message:
        "Services still holds 4 branches and 1 till product. Move them out or switch the branch off.",
    })
    demoDeleteCategory(demoCategoryId("tcg.lorcana.graded"))
    expect(branch(demoCategoryId("tcg.lorcana.graded"))).toBeUndefined()
  })
})

describe("the till's branch route", () => {
  it("answers the trail, the visible children and the shelf stock, and searches beneath", () => {
    const view = demoTillBranch(SINGLES)
    expect(view.trail.map((step) => step.name)).toEqual(["Trading cards", "Pokémon"])
    expect(view.children).toEqual([])
    expect(view.items.map((item) => item.title)).toEqual(["Charizard ex"])

    const top = demoTillBranch(demoCategoryId("tcg"))
    expect(top.children.map((chip) => chip.name)[0]).toBe("Pokémon")
    expect(top.products.map((product) => product.name)).toEqual(["Single card"])

    const found = demoTillBranch(POKEMON, { q: "charizard" })
    expect(found.children).toEqual([])
    expect(found.items.map((item) => item.title)).toEqual(["Charizard ex"])
    expect(found.total).toBe(1)
  })
})
