# Inventory API contract (Phase 9)

The contract the Phase 9 packages build against, in waves. `docs/EPOS-PLAN.md` (Phase 9, decision 7) is the plan; `docs/api-contract-epos.md` is the till's contract, whose rules (money in pence, capabilities through `lib/permissions.js`, refusal bodies, no em-dashes or exclamation marks in any sentence) all apply here.

---

## 1. Wave 1: the category tree

Every stock item and every till product has one home branch in a tree of any depth (eight levels at most), brand before type: Trading cards > Pokémon > Singles; Retro > Sega > Mega Drive > Games. Staff find anything without a barcode by browsing it, at the till and in Stock. A starter tree is seeded; staff rename, move, add and switch off branches.

### 1.1 Already laid

- **`packages/shared/src/categories.ts`**: the starter tree (`STARTER_TREE`, `starterBranches()`), the filing rule (`fileItem({ kind, game, platform })` answers a branch key), the derived fields (`lineageOf`, `pathOf`, `isWithin`, `moveProblem`), the tree from a flat list (`buildCategoryTree`, `flattenCategoryTree`, `subtreeHeight`), and the route types `CategoryBranch` and `CategoryTree`. Tested in `packages/shared/test/categories.test.ts`. The hooks load it from `pb_hooks/lib/shared/categories.js`.
- **`packages/shared/src/epos-types.ts`**: `TillCatalogue.branches`, `TillBranchChip`, `TillBranchView`.
- **`pb/pb_migrations/1789821000_category_tree.js`**:
  - `categories`: `name` (60), `parent` (self, empty at the top), `sort`, `active`, `image` (png, jpeg, webp, 5 MB, thumbs `160x0`, `320x0`), `key` (the stable name of a seeded branch, `tcg.pokemon.singles`; empty for one staff add), `default_kind`, `default_game`, `default_platform`, `default_tax_scheme`, and the derived `path` ("Trading cards / Pokémon / Singles"), `lineage` ("|rootId|...|ownId|") and `depth` (0 at the top). Unique indexes on (`parent`, `name` case-insensitive) and on `key` when set. Rules: staff read; manager and admin write.
  - The starter tree seeded: 235 branches, siblings ten apart in `sort`, every branch active.
  - `items.category` (indexed), every existing row filed by `fileItem` from its kind, its game's key and its retro title's platform key; what the rule cannot place goes to Unsorted.
  - `till_products.category` now points at the tree, not at the quick-key pages: memberships to Services > Memberships, table time to Services > Table time, event entry to Services > Events, other services and deposits to Services, the open-price "Single card" to Trading cards, anything else to the top-level branch named like its old page, else Unsorted.
  - `till_categories` is unchanged: those rows are the till's **quick-key pages** from now on.
- **`pb/pb_hooks/lib/till.js`**: a till product's line on an X or Z is labelled with its top-level branch ("Services").

### 1.2 Keeping the tree (B4)

`pb_hooks/categories.pb.js` (record hooks and routes) and `pb_hooks/lib/categories.js` (the logic), on every create and update, through the collection API or a route:

- `name` trimmed, 1 to 60 characters: 400 "Give the branch a name." The parent must exist: 400 "That parent branch was not found."
- No branch inside itself or its own subtree, and no deeper than eight levels with its subtree: 400 with `moveProblem`'s sentences ("A branch cannot go inside itself or one of its own branches.", "Branches go 8 levels deep at most. Put this one higher up.").
- Sibling names are unique, case-insensitively: 400 "There is already a branch called Singles here."
- `path`, `lineage` and `depth` are always derived from the parent; whatever a request sends for them is ignored. A rename or a move rewrites every branch beneath it in the same transaction.
- `key` is the migration's: a request can neither set nor change it.
- Deleting a branch that still holds branches, stock rows or till products is refused: 409 "Singles still holds 2 branches, 120 stock rows and 1 till product. Move them out or switch the branch off." (only the parts that are not zero). Unsorted (`key = "unsorted"`) can be neither deleted nor switched off: 409 "Unsorted is where stock with no branch goes, so it stays."
- Switching a branch off hides it and everything beneath it from the pickers, the till and the tree's `visible` flag; its stock keeps its branch and still sells by scan or SKU.

Filing new stock: an item created with no `category` is filed by `fileItem` from its kind, its game's key and its retro title's platform key, falling back to Unsorted when that key no longer exists. This covers Add stock without a branch, buy-in and part-exchange completion, the Card Uploader import and anything else that creates items. An item or till product created or updated with a `category` that does not exist is refused: 400 "That branch was not found." A till product created with no `category` goes to Unsorted.

### 1.3 Routes (B4)

Capability `stock_manage` (`lib/permissions.js`, manager and admin by default, with the usual override) for every write route; staff for reads.

**`GET /api/vault/categories/tree`** (staff): `CategoryTree`, every branch switched off or not, depth first in tree order (`buildCategoryTree`: siblings by `sort` then name). `defaults` carry ids. `counts.items` and `counts.items_total` count stock rows on the shelf (`status = 'in_stock' && qty > 0`) in the branch itself and in its whole subtree; `counts.products` counts active till products.

**`POST /api/vault/categories/{id}/move`** (`stock_manage`): `{ "parent": "<id>" | "", "before"?: "<sibling id>" }`. Moves the branch under `parent`, placed before `before` or last, renumbers the new parent's children 10, 20, 30, rewrites the subtree's derived fields, and answers the whole `CategoryTree`. The refusals in 1.2; 400 "That branch is not under the new parent." for a `before` that is not.

**`POST /api/vault/categories/reorder`** (`stock_manage`): `{ "parent": "<id>" | "", "order": ["<id>", ...] }`, every child of `parent` exactly once: 400 "That order does not match the branches here. Reload and try again." Sets `sort` 10, 20, 30 in that order and answers the `CategoryTree`.

**`POST /api/vault/categories/assign`** (`stock_manage`): `{ "category": "<id>", "items"?: ["<id>", ...], "products"?: ["<id>", ...] }`, 500 ids at most between them: 400 "File up to 500 at a time." Moves those stock rows and till products into the branch in one transaction (an id that does not exist is refused, 404 "One of those was not found. Reload and try again."), writes one `category_assign` audit row with the branch id and the two counts, and answers `{ "items": n, "products": n }`. This is how Unsorted is emptied.

**`GET /api/vault/till/catalogue`** gains `branches`: the visible top-level branches in order, as `TillBranchChip` (`items` is the subtree's shelf count). The rail shows the quick-key pages first, then these.

**`GET /api/vault/till/branch/{id}?q=&page=`** (staff): `TillBranchView`. 404 "That branch was not found." for a branch that is missing or not visible. `trail` runs from the top-level branch down to the parent. `children` are the visible child branches in order. `products` are the active till products whose home is this branch. `items` are stock rows on the shelf whose home is this branch, by title, 40 a page. With `q`, `products` and `items` are those anywhere in the subtree whose name, title or SKU matches, still 40 a page; `children` is then empty.

**Stock filtered by branch**: the items collection takes `category.lineage ~ '|<id>|'` for a branch and everything beneath it; B4 checks it works for a staff token and stays quick on a few thousand rows.

### 1.4 Reports (B4)

- **X and Z `by_category`**: every line, stock or till product, is labelled with the first two levels of its branch's path ("Trading cards / Pokémon", "Retro / Sega", "Services / Table time"; a top-level branch alone when it has no second level, "Other" when there is none). `packages/shared/src/till.ts` and the demo X follow.
- **Sales report `by=category`**: optional `branch=<id>`. The rows are the branch's child branches (the top-level branches without `branch`), each `{ key: <id>, label, net, count, has_children }`, plus one row `{ key: <branch id>, label: "In <name> itself", ... }` for lines whose home is the branch itself when there are any. Net after discounts and refunds, as the report's other dimensions. The CSV carries the full path. The filter and the drill-down survive a saved view (`saved_reports.filters` gains `branch`).

### 1.5 The quick-key pages (B4)

A second migration, `1789821060_till_pages.js`, switches off the seeded pages the tree replaces: an active `till_categories` row with no keys (as seeded, Sealed, Accessories and Services). Pages with keys, Quick among them, stay. `30-sales.sh` sets up its own dynamic page for the dynamic-page checks. `down()` switches the same rows back on (by name).

### 1.6 The web (F4)

- **One picker** (`components/category-picker/` or `features/categories/`), used everywhere a branch is chosen: a sheet (a bottom sheet on a phone) with the breadcrumb, the current level's branches as hairline rows with their shelf counts and a chevron for those with branches beneath, a search across every path, and "Choose this branch" as the block. Switched-off branches are not offered.
- **Settings, Categories** (manager and admin): the tree as an indented list with expand and collapse, the shelf count per branch, drag to reorder among siblings and to move under another branch (touch friendly, with a "Move to" action through the picker as the keyboard and touch fallback), add a branch here or beneath, rename in place, switch off and on, delete when empty, and a sheet for the branch's defaults (kind, game, platform, VAT treatment) and image. Unsorted shows its count and a "File these" flow: pick rows, pick a branch, `assign`.
- **The till**: the rail shows the quick-key pages then the top-level branches. A branch opens its view in the catalogue pane: a breadcrumb with a back step, child branches as folder tiles (name, shelf count), then the branch's products and stock rows as the till's usual tiles, then "Load more" while there are pages. The scan field searches within the branch while one is open, and everywhere from a page.
- **Stock**: a branch filter (the picker) that includes everything beneath it, a Category column showing the last two levels of the path, and filing selected rows into a branch from the bulk actions (`assign`).
- **Add stock**: the branch is chosen first or picked up from an EAN's existing stock line, and its defaults fill in the kind, game, platform and VAT treatment, each still editable; the new item is saved with `category`.
- **The item page**: the branch's path, with Change (the picker).
- **Reports**: Sales gains "By category" with drill-down rows (`has_children`), a breadcrumb back up, and the branch kept in a saved view.
- **Demo mode**: the starter tree from the shared module with stable demo ids, the demo stock filed by `fileItem`, and every route above answered from memory.

### 1.7 Packages

**B4** (server) owns: new `pb/pb_hooks/categories.pb.js` and `pb/pb_hooks/lib/categories.js`; the item-create filing in `pb/pb_hooks/items.pb.js`; `pb/pb_hooks/till_catalogue.pb.js` and `pb/pb_hooks/lib/tillcatalogue.js` (the branches and the branch route); `pb/pb_hooks/lib/till.js` and `packages/shared/src/till.ts` (the labels); the sales report (`pb/pb_hooks/lib/reports/sales.js`, its registry entry and `saved_reports` filter checks); new `pb/pb_migrations/1789821060_till_pages.js`; new `pb/scripts/checks/32-categories.sh`; and in `pb/scripts/check.sh`, `28-till.sh` and `30-sales.sh` only what its changes reach.

**F4** (web) owns: the picker, `apps/web/src/features/settings/` (the Categories section), `apps/web/src/features/till/` (the rail and the branch view), `apps/web/src/features/stock/`, `apps/web/src/features/intake/` (Add stock), the item page, `apps/web/src/features/reports/` (the category dimension), new `apps/web/src/lib/api/categories.ts` and its demo, the till catalogue's demo, new `e2e/categories.spec.ts` and changes to the specs its screens reach.

Everything else: ask in the report.
