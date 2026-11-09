/// <reference path="../pb_data/types.d.ts" />

/**
 * vault_stock.pb.js - the routes behind the vault's Stock feature
 * (apps/vault/src/features/stock). Collections: 1789821500_vault_stock.js.
 *
 *   GET  /api/vault/stock/inventory           (staff)
 *        Every item still held (in_stock, reserved, listed_ebay), flattened,
 *        with its market value: the chosen UK-first snapshot for its card
 *        (condition adjusted) or retro title, else market_at_intake.
 *        { items: InventoryItem[], generated_at }
 *
 *   POST /api/vault/stock/reprice             (staff)
 *        { changes: [{ item, price }], source?: "manual" | "bulk" | "import" }
 *        Sets each sticker price, writes one item_price_changes row per item
 *        whose price actually moved, and flips a printed print-list entry to
 *        needs_reprint. All or nothing. { changed, unchanged }
 *
 *   POST /api/vault/stock/proposals/decide    (admin or manager)
 *        { ids: [...], decision: "approve" | "reject" }
 *        Approve applies each pending proposal's new_price the same way
 *        (source "rule"). { approved, rejected, skipped }
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() and helper lives inside the handler body - see pb/README.md.
 */

// ---------------------------------------------------------------------
// GET /api/vault/stock/inventory
// ---------------------------------------------------------------------
routerAdd(
  "GET",
  "/api/vault/stock/inventory",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const policy = require(`${__hooks}/adapters/pricing_policy.js`);

    const settingsRow = util.settings(e.app);
    const tcg = policy.tcgPriority(settingsRow);
    const retro = policy.retroPriority(settingsRow);
    const multipliers = policy.conditionMultipliers(settingsRow);
    const now = new Date();

    const cache = {};
    function lookup(collection, id) {
      if (!id) return null;
      const key = collection + ":" + id;
      if (key in cache) return cache[key];
      let record = null;
      try {
        record = e.app.findRecordById(collection, id);
      } catch (err) {
        record = null;
      }
      cache[key] = record;
      return record;
    }

    const marketCache = {};
    function chosenMarket(field, ownerId, finish, priority) {
      const key = field + ":" + ownerId + ":" + finish;
      if (key in marketCache) return marketCache[key];
      let value = null;
      try {
        const result = policy.choose(policy.snapshotsFor(e.app, field, ownerId, finish), priority, now);
        if (result.chosen && typeof result.chosen.gbp_market === "number") {
          value = { pence: result.chosen.gbp_market, source: result.chosen.source || "" };
        }
      } catch (err) {
        value = null;
      }
      marketCache[key] = value;
      return value;
    }

    // Latest price change per item, for "hand-stickered".
    const lastSource = {};
    try {
      const changes = e.app.findRecordsByFilter("item_price_changes", "id != ''", "created", 0, 0);
      for (let i = 0; i < changes.length; i++) {
        lastSource[changes[i].getString("item")] = changes[i].getString("source");
      }
    } catch (err) {
      // No history yet.
    }

    const records = e.app.findRecordsByFilter(
      "items",
      "status = 'in_stock' || status = 'reserved' || status = 'listed_ebay' || status = ''",
      "-created",
      0,
      0
    );

    const out = [];
    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      const kind = item.getString("kind");
      const cardId = item.getString("card");
      const retroId = item.getString("retro_title");
      const card = lookup("cards", cardId);
      const game = lookup("games", item.getString("game"));
      const location = lookup("locations", item.getString("location"));
      const category = lookup("categories", item.getString("category"));

      let market = null;
      let marketSource = "";
      if (card && kind !== "graded") {
        const chosen = chosenMarket("card", cardId, item.getString("finish"), tcg);
        if (chosen) {
          const condition = item.getString("condition") || "NM";
          market = policy.adjustForConditionSafe(chosen.pence, condition, multipliers);
          marketSource = chosen.source;
        }
      } else if (retroId) {
        const chosen = chosenMarket("retro_title", retroId, item.getString("completeness"), retro);
        if (chosen) {
          market = chosen.pence;
          marketSource = chosen.source;
        }
      }
      if (market === null && item.getInt("market_at_intake") > 0) {
        market = item.getInt("market_at_intake");
        marketSource = "intake";
      }

      let image = "";
      const photos = item.get("photos");
      if (photos && photos.length) {
        image = "/api/files/items/" + item.id + "/" + photos[0];
      } else if (card) {
        image = card.getString("image_file")
          ? "/api/files/cards/" + card.id + "/" + card.getString("image_file")
          : card.getString("image_small") || card.getString("image_large");
      }

      out.push({
        id: item.id,
        sku: item.getString("sku"),
        kind: kind,
        title: item.getString("title") || (card ? card.getString("name") : "") || "Untitled item",
        card: cardId,
        game: item.getString("game"),
        game_name: game ? game.getString("name") : "",
        set_code: item.getString("set_code"),
        number: item.getString("number"),
        finish: item.getString("finish"),
        condition: item.getString("condition"),
        grade_company: item.getString("grade_company"),
        grade: item.getString("grade"),
        qty: item.getInt("qty") || 1,
        price: item.getInt("price"),
        cost: item.getInt("cost"),
        market: market,
        market_source: marketSource,
        location: item.getString("location"),
        location_name: location ? location.getString("name") : "",
        category: item.getString("category"),
        category_path: category ? category.getString("path") || category.getString("name") : "",
        status: item.getString("status") || "in_stock",
        image: image,
        notes: item.getString("notes"),
        label_printed_at: item.getString("label_printed_at"),
        hand_priced: lastSource[item.id] === "manual",
        acquired_at: item.getString("acquired_at"),
        created: item.getString("created"),
        updated: item.getString("updated"),
      });
    }

    return e.json(200, { items: out, generated_at: now.toISOString() });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/stock/reprice
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/stock/reprice",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const body = util.body(e);
    const source = ["manual", "bulk", "import"].indexOf(util.asStr(body.source)) >= 0 ? util.asStr(body.source) : "manual";

    const list = Array.isArray(body.changes) ? body.changes : [];
    if (list.length === 0) throw e.badRequestError("Pick at least one item to reprice.", null);
    if (list.length > 2000) throw e.badRequestError("Reprice at most 2,000 items at a time.", null);

    const changes = [];
    for (let i = 0; i < list.length; i++) {
      const id = util.asStr(list[i] && list[i].item);
      const price = util.asInt(list[i] && list[i].price, -1);
      if (!id) throw e.badRequestError("Every change needs an item.", null);
      if (price < 0 || price > 10000000) {
        throw e.badRequestError("Enter a price in pence, £0.00 or more.", null);
      }
      changes.push({ id: id, price: price });
    }

    let changed = 0;
    let unchanged = 0;
    e.app.runInTransaction((txApp) => {
      const history = txApp.findCollectionByNameOrId("item_price_changes");
      for (let i = 0; i < changes.length; i++) {
        let item;
        try {
          item = txApp.findRecordById("items", changes[i].id);
        } catch (err) {
          throw e.notFoundError("One of those items was not found. Refresh the list and try again.", null);
        }
        const old = item.getInt("price");
        if (old === changes[i].price) {
          unchanged++;
          continue;
        }
        item.set("price", changes[i].price);
        txApp.save(item);
        txApp.save(
          new Record(history, {
            item: item.id,
            old_price: old,
            new_price: changes[i].price,
            source: source,
            staff: e.auth.id,
          })
        );
        try {
          const entry = txApp.findFirstRecordByFilter("stock_print_list", "item = {:item}", { item: item.id });
          if (entry.getString("status") === "printed") {
            entry.set("status", "needs_reprint");
            txApp.save(entry);
          }
        } catch (err) {
          // Not on the print list.
        }
        changed++;
      }
    });

    return e.json(200, { changed: changed, unchanged: unchanged });
  },
  $apis.requireAuth("staff")
);

// ---------------------------------------------------------------------
// POST /api/vault/stock/proposals/decide
// ---------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/vault/stock/proposals/decide",
  (e) => {
    const util = require(`${__hooks}/lib/vaultutil.js`);
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw e.forbiddenError("Only an admin or a manager can approve price changes.", null);
    }

    const body = util.body(e);
    const decision = util.asStr(body.decision);
    if (decision !== "approve" && decision !== "reject") {
      throw e.badRequestError("Choose approve or reject.", null);
    }
    const ids = [];
    if (Array.isArray(body.ids)) {
      for (let i = 0; i < body.ids.length; i++) {
        const id = util.asStr(body.ids[i]);
        if (id) ids.push(id);
      }
    }
    if (ids.length === 0) throw e.badRequestError("Pick at least one price change.", null);

    let approved = 0;
    let rejected = 0;
    let skipped = 0;
    const at = new Date().toISOString();
    e.app.runInTransaction((txApp) => {
      const history = txApp.findCollectionByNameOrId("item_price_changes");
      for (let i = 0; i < ids.length; i++) {
        let proposal;
        try {
          proposal = txApp.findRecordById("price_proposals", ids[i]);
        } catch (err) {
          skipped++;
          continue;
        }
        if (proposal.getString("status") !== "pending") {
          skipped++;
          continue;
        }
        proposal.set("decided_by", e.auth.id);
        proposal.set("decided_at", at);
        if (decision === "reject") {
          proposal.set("status", "rejected");
          txApp.save(proposal);
          rejected++;
          continue;
        }
        let item;
        try {
          item = txApp.findRecordById("items", proposal.getString("item"));
        } catch (err) {
          skipped++;
          continue;
        }
        const old = item.getInt("price");
        const next = proposal.getInt("new_price");
        if (old !== next) {
          item.set("price", next);
          txApp.save(item);
          txApp.save(
            new Record(history, {
              item: item.id,
              old_price: old,
              new_price: next,
              source: "rule",
              rule: proposal.getString("rule"),
              staff: e.auth.id,
            })
          );
          try {
            const entry = txApp.findFirstRecordByFilter("stock_print_list", "item = {:item}", { item: item.id });
            if (entry.getString("status") === "printed") {
              entry.set("status", "needs_reprint");
              txApp.save(entry);
            }
          } catch (err) {
            // Not on the print list.
          }
        }
        proposal.set("status", "approved");
        txApp.save(proposal);
        approved++;
      }
    });

    return e.json(200, { approved: approved, rejected: rejected, skipped: skipped });
  },
  $apis.requireAuth("staff")
);
