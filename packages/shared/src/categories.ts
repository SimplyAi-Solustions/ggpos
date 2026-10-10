/**
 * The stock category tree (docs/EPOS-PLAN.md, decision 7;
 * docs/api-contract-inventory.md, section 1).
 *
 * Every stock item and till product has one home branch in a tree of any
 * depth (eight levels at most), brand before type: Trading cards > Pokémon >
 * Singles, Retro > Sega > Mega Drive > Games. A branch keeps three derived
 * fields the server maintains: `path` (the names from the top, joined by
 * " / "), `lineage` ("|rootId|...|ownId|", so a whole subtree is one
 * `lineage ~ '|id|'` match) and `depth` (0 at the top).
 *
 * This module is pure and shared by the server (the migration that seeds
 * the starter tree and files existing stock, the hooks that keep the
 * derived fields, the item-create hook that files new stock) and the web
 * app (the editor, the pickers, the till and demo mode), so they agree on
 * the tree's shape and on where an item belongs.
 */

/** Item kinds a branch can default to (items.kind). */
export const CATEGORY_KINDS = ["single", "graded", "retro", "sealed", "accessory", "other"] as const
export type CategoryKind = (typeof CATEGORY_KINDS)[number]

/** A branch's default scheme; with `vat_rate` it is one of the five treatments (./vat). */
export type CategoryTaxScheme = "margin" | "standard" | "zero" | "exempt"

/** Branches go this many levels deep at most: depth 0 to 7. */
export const MAX_CATEGORY_DEPTH = 8

export const CATEGORY_PATH_SEPARATOR = " / "

/** The one branch that always exists: stock the filing rules cannot place. */
export const UNSORTED_KEY = "unsorted"

/**
 * What a new item in a branch starts with. `game` and `platform` are the
 * `games.key` and `platforms.key` of the seed data; the server resolves
 * them to ids.
 */
export interface CategoryDefaults {
  kind?: CategoryKind
  game?: string
  platform?: string
  tax_scheme?: CategoryTaxScheme
  /** With a standard scheme: 5 is reduced, 0 or empty the shop's standard rate. */
  vat_rate?: number
}

/** A branch of the starter tree, with a stable key the filing rules use. */
export interface StarterBranch {
  key: string
  name: string
  defaults?: CategoryDefaults
  children?: StarterBranch[]
}

// ---------------------------------------------------------------------------
// The starter tree
// ---------------------------------------------------------------------------

/** The trading card games the shop sells, with their `games.key`. */
export const TCG_GAMES: readonly { key: string; name: string; slug: string }[] = [
  { key: "pokemon", name: "Pokémon", slug: "pokemon" },
  { key: "mtg", name: "Magic: The Gathering", slug: "mtg" },
  { key: "yugioh", name: "Yu-Gi-Oh!", slug: "yugioh" },
  { key: "onepiece", name: "One Piece", slug: "onepiece" },
  { key: "lorcana", name: "Disney Lorcana", slug: "lorcana" },
]

function tcgBranch(game: { key: string; name: string; slug: string }): StarterBranch {
  const base = `tcg.${game.slug}`
  const sealed = { kind: "sealed" as const, game: game.key, tax_scheme: "standard" as const }
  return {
    key: base,
    name: game.name,
    defaults: { game: game.key },
    children: [
      { key: `${base}.singles`, name: "Singles", defaults: { kind: "single", game: game.key, tax_scheme: "margin" } },
      { key: `${base}.graded`, name: "Graded", defaults: { kind: "graded", game: game.key, tax_scheme: "margin" } },
      {
        key: `${base}.sealed`,
        name: "Sealed",
        defaults: sealed,
        children: [
          { key: `${base}.sealed.packs`, name: "Booster packs", defaults: { ...sealed, platform: "booster_pack" } },
          { key: `${base}.sealed.boxes`, name: "Booster boxes", defaults: { ...sealed, platform: "booster_box" } },
          { key: `${base}.sealed.etbs`, name: "ETBs and collections", defaults: { ...sealed, platform: "etb" } },
          { key: `${base}.sealed.tins`, name: "Tins and bundles", defaults: sealed },
        ],
      },
      {
        key: `${base}.accessories`,
        name: "Accessories",
        defaults: { kind: "accessory", game: game.key, tax_scheme: "standard" },
      },
    ],
  }
}

interface Console {
  slug: string
  name: string
  /** The `platforms.key` its boxed games are framed in, when there is one. */
  box?: string
}

const RETRO_MAKERS: readonly { slug: string; name: string; consoles: Console[] }[] = [
  {
    slug: "sega",
    name: "Sega",
    consoles: [
      { slug: "mastersystem", name: "Master System" },
      { slug: "megadrive", name: "Mega Drive", box: "megadrive_box" },
      { slug: "megacd", name: "Mega CD" },
      { slug: "32x", name: "32X" },
      { slug: "saturn", name: "Saturn" },
      { slug: "dreamcast", name: "Dreamcast" },
      { slug: "gamegear", name: "Game Gear" },
    ],
  },
  {
    slug: "nintendo",
    name: "Nintendo",
    consoles: [
      { slug: "nes", name: "NES" },
      { slug: "snes", name: "SNES", box: "snes_pal_box" },
      { slug: "n64", name: "Nintendo 64", box: "n64_box" },
      { slug: "gamecube", name: "GameCube", box: "gamecube_case" },
      { slug: "wii", name: "Wii" },
      { slug: "wiiu", name: "Wii U" },
      { slug: "switch", name: "Switch", box: "switch_case" },
      { slug: "gameboy", name: "Game Boy", box: "gameboy_cart" },
      { slug: "gbc", name: "Game Boy Color", box: "gameboy_cart" },
      { slug: "gba", name: "Game Boy Advance", box: "gameboy_cart" },
      { slug: "ds", name: "DS" },
      { slug: "3ds", name: "3DS" },
    ],
  },
  {
    slug: "sony",
    name: "Sony",
    consoles: [
      { slug: "ps1", name: "PlayStation", box: "ps1_case" },
      { slug: "ps2", name: "PlayStation 2", box: "ps2_case" },
      { slug: "ps3", name: "PlayStation 3" },
      { slug: "ps4", name: "PlayStation 4" },
      { slug: "psp", name: "PSP" },
      { slug: "vita", name: "PS Vita" },
    ],
  },
  {
    slug: "microsoft",
    name: "Microsoft",
    consoles: [
      { slug: "xbox", name: "Xbox", box: "ps2_case" },
      { slug: "xbox360", name: "Xbox 360" },
      { slug: "xboxone", name: "Xbox One" },
    ],
  },
  {
    slug: "atari",
    name: "Atari",
    consoles: [
      { slug: "2600", name: "Atari 2600" },
      { slug: "7800", name: "Atari 7800" },
      { slug: "lynx", name: "Lynx" },
      { slug: "jaguar", name: "Jaguar" },
    ],
  },
  {
    slug: "other",
    name: "Other makers",
    consoles: [
      { slug: "neogeo", name: "Neo Geo" },
      { slug: "c64", name: "Commodore 64" },
      { slug: "amiga", name: "Amiga" },
      { slug: "spectrum", name: "ZX Spectrum" },
    ],
  },
]

function consoleBranch(maker: string, console: Console): StarterBranch {
  const base = `retro.${maker}.${console.slug}`
  return {
    key: base,
    name: console.name,
    defaults: { game: "retro" },
    children: [
      {
        key: `${base}.games`,
        name: "Games",
        defaults: { kind: "retro", game: "retro", tax_scheme: "margin", ...(console.box ? { platform: console.box } : {}) },
      },
      {
        key: `${base}.consoles`,
        name: "Consoles",
        defaults: { kind: "retro", game: "retro", platform: "console", tax_scheme: "margin" },
      },
      {
        key: `${base}.accessories`,
        name: "Accessories",
        defaults: { kind: "accessory", game: "retro", tax_scheme: "margin" },
      },
    ],
  }
}

function leaves(prefix: string, names: string[], defaults?: CategoryDefaults): StarterBranch[] {
  return names.map((name) => ({
    key: `${prefix}.${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    name,
    ...(defaults ? { defaults } : {}),
  }))
}

/**
 * The tree a new shop starts with. Staff rename, move, add and switch off
 * branches in Settings; the keys stay with the branches they were seeded
 * on, so the filing rules keep finding them whatever they are called.
 */
export const STARTER_TREE: readonly StarterBranch[] = [
  {
    key: "tcg",
    name: "Trading cards",
    children: [
      ...TCG_GAMES.map(tcgBranch),
      {
        key: "tcg.other",
        name: "Other card games",
        children: leaves("tcg.other", ["Singles", "Sealed", "Accessories"]),
      },
    ],
  },
  {
    key: "retro",
    name: "Retro",
    defaults: { game: "retro" },
    children: RETRO_MAKERS.map((maker) => ({
      key: `retro.${maker.slug}`,
      name: maker.name,
      defaults: { game: "retro" },
      children: maker.consoles.map((console) => consoleBranch(maker.slug, console)),
    })),
  },
  {
    key: "boardgames",
    name: "Board games",
    defaults: { kind: "other", tax_scheme: "standard" },
    children: leaves("boardgames", ["Family", "Strategy", "Party", "Card games", "Expansions"], {
      kind: "other",
      tax_scheme: "standard",
    }),
  },
  {
    key: "minis",
    name: "Miniatures and paints",
    defaults: { kind: "other", tax_scheme: "standard" },
    children: leaves("minis", ["Warhammer 40,000", "Age of Sigmar", "Other miniatures", "Paints", "Tools and hobby"], {
      kind: "other",
      tax_scheme: "standard",
    }),
  },
  {
    key: "pc",
    name: "PC parts",
    defaults: { kind: "other", tax_scheme: "standard" },
    children: leaves("pc", ["Graphics cards", "Processors", "Memory", "Storage", "Peripherals"], {
      kind: "other",
      tax_scheme: "standard",
    }),
  },
  {
    key: "accessories",
    name: "Accessories",
    defaults: { kind: "accessory", tax_scheme: "standard" },
    children: leaves("accessories", ["Sleeves", "Top loaders", "Binders", "Deck boxes", "Playmats", "Storage"], {
      kind: "accessory",
      tax_scheme: "standard",
    }),
  },
  {
    key: "food",
    name: "Drinks and snacks",
    defaults: { kind: "other", tax_scheme: "standard" },
    children: leaves("food", ["Drinks", "Snacks"], { kind: "other", tax_scheme: "standard" }),
  },
  {
    key: "services",
    name: "Services",
    children: leaves("services", ["Table time", "Events", "Repairs", "Memberships"]),
  },
  { key: UNSORTED_KEY, name: "Unsorted" },
]

/** The starter tree depth first, each branch with its parent's key ("" at the top). */
export function starterBranches(): { branch: StarterBranch; parent: string; depth: number }[] {
  const out: { branch: StarterBranch; parent: string; depth: number }[] = []
  const walk = (list: readonly StarterBranch[], parent: string, depth: number) => {
    for (const branch of list) {
      out.push({ branch, parent, depth })
      if (branch.children) walk(branch.children, branch.key, depth + 1)
    }
  }
  walk(STARTER_TREE, "", 0)
  return out
}

// ---------------------------------------------------------------------------
// Filing: where an item belongs when nobody has chosen a branch
// ---------------------------------------------------------------------------

/** The retro console whose Games branch a boxed platform files into. */
const RETRO_BY_PLATFORM: Readonly<Record<string, string>> = {
  megadrive_box: "retro.sega.megadrive.games",
  snes_pal_box: "retro.nintendo.snes.games",
  n64_box: "retro.nintendo.n64.games",
  gamecube_case: "retro.nintendo.gamecube.games",
  switch_case: "retro.nintendo.switch.games",
  gameboy_cart: "retro.nintendo.gameboy.games",
  gameboy_box: "retro.nintendo.gameboy.games",
  ps1_case: "retro.sony.ps1.games",
  // ps2_case frames PlayStation 2 and Xbox games alike, and console every
  // maker's machines, so neither says where an item belongs.
}

const TCG_SEALED_BY_PLATFORM: Readonly<Record<string, string>> = {
  booster_pack: "packs",
  booster_box: "boxes",
  etb: "etbs",
}

export interface FilingFacts {
  /** items.kind. */
  kind: string
  /** The item's `games.key`. */
  game?: string
  /** The `platforms.key` of the item's retro title, or the sealed product's shape. */
  platform?: string
}

/**
 * The key of the branch an item files into when nobody chose one: by kind
 * and game for cards and sealed product, by the boxed platform for a retro
 * game, and Unsorted for anything the facts do not settle (a PS2-or-Xbox
 * case, a console, an "other"). The caller falls back to Unsorted when the
 * key no longer exists.
 */
export function fileItem(facts: FilingFacts): string {
  const game = TCG_GAMES.find((entry) => entry.key === facts.game)
  const kind = facts.kind
  if (game) {
    const base = `tcg.${game.slug}`
    if (kind === "single") return `${base}.singles`
    if (kind === "graded") return `${base}.graded`
    if (kind === "accessory") return `${base}.accessories`
    if (kind === "sealed") {
      const shape = facts.platform ? TCG_SEALED_BY_PLATFORM[facts.platform] : undefined
      return shape ? `${base}.sealed.${shape}` : `${base}.sealed`
    }
    return UNSORTED_KEY
  }
  if (kind === "retro" && facts.platform) return RETRO_BY_PLATFORM[facts.platform] ?? UNSORTED_KEY
  if (kind === "accessory") return "accessories"
  return UNSORTED_KEY
}

// ---------------------------------------------------------------------------
// The derived fields, and the tree from a flat list
// ---------------------------------------------------------------------------

/** "|rootId|...|ownId|" from the parent's lineage ("" at the top). */
export function lineageOf(parentLineage: string, id: string): string {
  return parentLineage ? `${parentLineage}${id}|` : `|${id}|`
}

/** "Trading cards / Pokémon / Singles" from the parent's path ("" at the top). */
export function pathOf(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}${CATEGORY_PATH_SEPARATOR}${name}` : name
}

/** Whether a branch with this lineage is `id` or sits anywhere under it. */
export function isWithin(lineage: string, id: string): boolean {
  return !!id && lineage.includes(`|${id}|`)
}

/**
 * Why `branchId` cannot move under a parent with this lineage and depth,
 * or null: not into itself or anything beneath it, and not deeper than the
 * tree allows once its own subtree comes with it.
 */
export function moveProblem(
  branchId: string,
  parent: { lineage: string; depth: number } | null,
  subtreeHeight: number
): string | null {
  if (parent && isWithin(parent.lineage, branchId)) {
    return "A branch cannot go inside itself or one of its own branches."
  }
  const depth = parent ? parent.depth + 1 : 0
  if (depth + subtreeHeight >= MAX_CATEGORY_DEPTH) {
    return `Branches go ${MAX_CATEGORY_DEPTH} levels deep at most. Put this one higher up.`
  }
  return null
}

export interface CategoryRow {
  id: string
  name: string
  parent: string
  sort: number
  active: boolean
}

export interface CategoryNode<T extends CategoryRow = CategoryRow> {
  row: T
  depth: number
  path: string
  lineage: string
  /** Active, and every branch above it active too. */
  visible: boolean
  children: CategoryNode<T>[]
}

function bySortThenName(a: CategoryRow, b: CategoryRow): number {
  return a.sort - b.sort || a.name.localeCompare(b.name, "en-GB")
}

/**
 * The tree from a flat list of rows, siblings by `sort` then name, with
 * each node's depth, path, lineage and visibility worked out from its
 * ancestors. A row whose parent is missing sits at the top.
 */
export function buildCategoryTree<T extends CategoryRow>(rows: readonly T[]): CategoryNode<T>[] {
  const ids = new Set(rows.map((row) => row.id))
  const byParent = new Map<string, T[]>()
  for (const row of rows) {
    const parent = row.parent && ids.has(row.parent) && row.parent !== row.id ? row.parent : ""
    const list = byParent.get(parent) ?? []
    list.push(row)
    byParent.set(parent, list)
  }
  const seen = new Set<string>()
  const build = (parentId: string, parent: CategoryNode<T> | null): CategoryNode<T>[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort(bySortThenName)
      .filter((row) => !seen.has(row.id))
      .map((row) => {
        seen.add(row.id)
        const node: CategoryNode<T> = {
          row,
          depth: parent ? parent.depth + 1 : 0,
          path: pathOf(parent?.path ?? "", row.name),
          lineage: lineageOf(parent?.lineage ?? "", row.id),
          visible: row.active && (parent ? parent.visible : true),
          children: [],
        }
        node.children = build(row.id, node)
        return node
      })
  return build("", null)
}

/** The tree depth first, the order an editor or a picker lists it in. */
export function flattenCategoryTree<T extends CategoryRow>(nodes: readonly CategoryNode<T>[]): CategoryNode<T>[] {
  const out: CategoryNode<T>[] = []
  const walk = (list: readonly CategoryNode<T>[]) => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** How many levels sit below a node: 0 for a leaf. */
export function subtreeHeight<T extends CategoryRow>(node: CategoryNode<T>): number {
  return node.children.reduce((most, child) => Math.max(most, subtreeHeight(child) + 1), 0)
}

// ---------------------------------------------------------------------------
// What the routes answer (docs/api-contract-inventory.md, section 1)
// ---------------------------------------------------------------------------

/** One branch as `GET /api/vault/categories/tree` lists it, depth first. */
export interface CategoryBranch {
  id: string
  name: string
  /** "" at the top. */
  parent: string
  path: string
  lineage: string
  depth: number
  sort: number
  active: boolean
  /** Active, and every branch above it active too. */
  visible: boolean
  /** The seeded key ("tcg.pokemon.singles"), or "" for a branch staff added. */
  key: string
  image_url: string
  /**
   * As ids: the server resolves the starter tree's game and platform keys.
   * `vat_rate` is `categories.default_vat_rate`, which with `tax_scheme`
   * makes the branch's VAT treatment (docs/api-contract-launch.md, section 3).
   */
  defaults: {
    kind: CategoryKind | ""
    game: string
    platform: string
    tax_scheme: CategoryTaxScheme | ""
    vat_rate?: number
  }
  counts: {
    /** Child branches, switched off ones included. */
    children: number
    /** Till products whose home is this branch. */
    products: number
    /** Stock rows in stock whose home is this branch. */
    items: number
    /** The same for this branch and everything under it. */
    items_total: number
  }
}

export interface CategoryTree {
  branches: CategoryBranch[]
}
