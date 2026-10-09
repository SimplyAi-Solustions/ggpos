// GENERATED FILE. Do not edit.
// Source: packages/shared/src. Regenerate with: pnpm --filter @gg/shared build:hooks
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.STARTER_TREE = exports.TCG_GAMES = exports.UNSORTED_KEY = exports.CATEGORY_PATH_SEPARATOR = exports.MAX_CATEGORY_DEPTH = exports.CATEGORY_KINDS = void 0;
exports.starterBranches = starterBranches;
exports.fileItem = fileItem;
exports.lineageOf = lineageOf;
exports.pathOf = pathOf;
exports.isWithin = isWithin;
exports.moveProblem = moveProblem;
exports.buildCategoryTree = buildCategoryTree;
exports.flattenCategoryTree = flattenCategoryTree;
exports.subtreeHeight = subtreeHeight;
/** Item kinds a branch can default to (items.kind). */
exports.CATEGORY_KINDS = ["single", "graded", "retro", "sealed", "accessory", "other"];
/** Branches go this many levels deep at most: depth 0 to 7. */
exports.MAX_CATEGORY_DEPTH = 8;
exports.CATEGORY_PATH_SEPARATOR = " / ";
/** The one branch that always exists: stock the filing rules cannot place. */
exports.UNSORTED_KEY = "unsorted";
// ---------------------------------------------------------------------------
// The starter tree
// ---------------------------------------------------------------------------
/** The trading card games the shop sells, with their `games.key`. */
exports.TCG_GAMES = [
    { key: "pokemon", name: "Pokémon", slug: "pokemon" },
    { key: "mtg", name: "Magic: The Gathering", slug: "mtg" },
    { key: "yugioh", name: "Yu-Gi-Oh!", slug: "yugioh" },
    { key: "onepiece", name: "One Piece", slug: "onepiece" },
    { key: "lorcana", name: "Disney Lorcana", slug: "lorcana" },
];
function tcgBranch(game) {
    const base = `tcg.${game.slug}`;
    const sealed = { kind: "sealed", game: game.key, tax_scheme: "standard" };
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
                    { key: `${base}.sealed.packs`, name: "Booster packs", defaults: Object.assign(Object.assign({}, sealed), { platform: "booster_pack" }) },
                    { key: `${base}.sealed.boxes`, name: "Booster boxes", defaults: Object.assign(Object.assign({}, sealed), { platform: "booster_box" }) },
                    { key: `${base}.sealed.etbs`, name: "ETBs and collections", defaults: Object.assign(Object.assign({}, sealed), { platform: "etb" }) },
                    { key: `${base}.sealed.tins`, name: "Tins and bundles", defaults: sealed },
                ],
            },
            {
                key: `${base}.accessories`,
                name: "Accessories",
                defaults: { kind: "accessory", game: game.key, tax_scheme: "standard" },
            },
        ],
    };
}
const RETRO_MAKERS = [
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
];
function consoleBranch(maker, console) {
    const base = `retro.${maker}.${console.slug}`;
    return {
        key: base,
        name: console.name,
        defaults: { game: "retro" },
        children: [
            {
                key: `${base}.games`,
                name: "Games",
                defaults: Object.assign({ kind: "retro", game: "retro", tax_scheme: "margin" }, (console.box ? { platform: console.box } : {})),
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
    };
}
function leaves(prefix, names, defaults) {
    return names.map((name) => (Object.assign({ key: `${prefix}.${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`, name }, (defaults ? { defaults } : {}))));
}
/**
 * The tree a new shop starts with. Staff rename, move, add and switch off
 * branches in Settings; the keys stay with the branches they were seeded
 * on, so the filing rules keep finding them whatever they are called.
 */
exports.STARTER_TREE = [
    {
        key: "tcg",
        name: "Trading cards",
        children: [
            ...exports.TCG_GAMES.map(tcgBranch),
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
    { key: exports.UNSORTED_KEY, name: "Unsorted" },
];
/** The starter tree depth first, each branch with its parent's key ("" at the top). */
function starterBranches() {
    const out = [];
    const walk = (list, parent, depth) => {
        for (const branch of list) {
            out.push({ branch, parent, depth });
            if (branch.children)
                walk(branch.children, branch.key, depth + 1);
        }
    };
    walk(exports.STARTER_TREE, "", 0);
    return out;
}
// ---------------------------------------------------------------------------
// Filing: where an item belongs when nobody has chosen a branch
// ---------------------------------------------------------------------------
/** The retro console whose Games branch a boxed platform files into. */
const RETRO_BY_PLATFORM = {
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
};
const TCG_SEALED_BY_PLATFORM = {
    booster_pack: "packs",
    booster_box: "boxes",
    etb: "etbs",
};
/**
 * The key of the branch an item files into when nobody chose one: by kind
 * and game for cards and sealed product, by the boxed platform for a retro
 * game, and Unsorted for anything the facts do not settle (a PS2-or-Xbox
 * case, a console, an "other"). The caller falls back to Unsorted when the
 * key no longer exists.
 */
function fileItem(facts) {
    var _a;
    const game = exports.TCG_GAMES.find((entry) => entry.key === facts.game);
    const kind = facts.kind;
    if (game) {
        const base = `tcg.${game.slug}`;
        if (kind === "single")
            return `${base}.singles`;
        if (kind === "graded")
            return `${base}.graded`;
        if (kind === "accessory")
            return `${base}.accessories`;
        if (kind === "sealed") {
            const shape = facts.platform ? TCG_SEALED_BY_PLATFORM[facts.platform] : undefined;
            return shape ? `${base}.sealed.${shape}` : `${base}.sealed`;
        }
        return exports.UNSORTED_KEY;
    }
    if (kind === "retro" && facts.platform)
        return (_a = RETRO_BY_PLATFORM[facts.platform]) !== null && _a !== void 0 ? _a : exports.UNSORTED_KEY;
    if (kind === "accessory")
        return "accessories";
    return exports.UNSORTED_KEY;
}
// ---------------------------------------------------------------------------
// The derived fields, and the tree from a flat list
// ---------------------------------------------------------------------------
/** "|rootId|...|ownId|" from the parent's lineage ("" at the top). */
function lineageOf(parentLineage, id) {
    return parentLineage ? `${parentLineage}${id}|` : `|${id}|`;
}
/** "Trading cards / Pokémon / Singles" from the parent's path ("" at the top). */
function pathOf(parentPath, name) {
    return parentPath ? `${parentPath}${exports.CATEGORY_PATH_SEPARATOR}${name}` : name;
}
/** Whether a branch with this lineage is `id` or sits anywhere under it. */
function isWithin(lineage, id) {
    return !!id && lineage.includes(`|${id}|`);
}
/**
 * Why `branchId` cannot move under a parent with this lineage and depth,
 * or null: not into itself or anything beneath it, and not deeper than the
 * tree allows once its own subtree comes with it.
 */
function moveProblem(branchId, parent, subtreeHeight) {
    if (parent && isWithin(parent.lineage, branchId)) {
        return "A branch cannot go inside itself or one of its own branches.";
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth + subtreeHeight >= exports.MAX_CATEGORY_DEPTH) {
        return `Branches go ${exports.MAX_CATEGORY_DEPTH} levels deep at most. Put this one higher up.`;
    }
    return null;
}
function bySortThenName(a, b) {
    return a.sort - b.sort || a.name.localeCompare(b.name, "en-GB");
}
/**
 * The tree from a flat list of rows, siblings by `sort` then name, with
 * each node's depth, path, lineage and visibility worked out from its
 * ancestors. A row whose parent is missing sits at the top.
 */
function buildCategoryTree(rows) {
    var _a;
    const ids = new Set(rows.map((row) => row.id));
    const byParent = new Map();
    for (const row of rows) {
        const parent = row.parent && ids.has(row.parent) && row.parent !== row.id ? row.parent : "";
        const list = (_a = byParent.get(parent)) !== null && _a !== void 0 ? _a : [];
        list.push(row);
        byParent.set(parent, list);
    }
    const seen = new Set();
    const build = (parentId, parent) => {
        var _a;
        return ((_a = byParent.get(parentId)) !== null && _a !== void 0 ? _a : [])
            .slice()
            .sort(bySortThenName)
            .filter((row) => !seen.has(row.id))
            .map((row) => {
            var _a, _b;
            seen.add(row.id);
            const node = {
                row,
                depth: parent ? parent.depth + 1 : 0,
                path: pathOf((_a = parent === null || parent === void 0 ? void 0 : parent.path) !== null && _a !== void 0 ? _a : "", row.name),
                lineage: lineageOf((_b = parent === null || parent === void 0 ? void 0 : parent.lineage) !== null && _b !== void 0 ? _b : "", row.id),
                visible: row.active && (parent ? parent.visible : true),
                children: [],
            };
            node.children = build(row.id, node);
            return node;
        });
    };
    return build("", null);
}
/** The tree depth first, the order an editor or a picker lists it in. */
function flattenCategoryTree(nodes) {
    const out = [];
    const walk = (list) => {
        for (const node of list) {
            out.push(node);
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
}
/** How many levels sit below a node: 0 for a leaf. */
function subtreeHeight(node) {
    return node.children.reduce((most, child) => Math.max(most, subtreeHeight(child) + 1), 0);
}
