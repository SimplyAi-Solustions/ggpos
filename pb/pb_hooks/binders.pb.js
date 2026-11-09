/// <reference path="../pb_data/types.d.ts" />

/**
 * binders.pb.js - the customer binder builder (ported from GG HQ, v2).
 *
 * Customers, own binders only:
 *   GET    /api/vault/binders/catalog/{what}    sets | pokemon | illustrators | generations
 *   GET    /api/vault/binders/search?q=         card search, for adding singles
 *   POST   /api/vault/binders/preview           {kind, query} -> count and sample
 *   POST   /api/vault/binders                   create and fill a binder
 *   POST   /api/vault/binders/{id}/add          {card_id, slot?}
 *   POST   /api/vault/binders/{id}/bulk         {cards: [...]}
 *   POST   /api/vault/binders/{id}/layout       {pockets: [{id, slot?, owned?}], min_slots?}
 *   GET    /api/vault/binder-availability/{id}  needed pocket ids the shop has in stock
 *   POST   /api/vault/binders/{id}/share        make (or return) the share link
 *   DELETE /api/vault/binders/{id}/share        switch the share link off
 *   POST   /api/vault/binder-wanted             {pocket} -> ask the shop for that card
 *   DELETE /api/vault/binder-wanted/{id}        cancel my request
 *
 * Anyone with the link (read only):
 *   GET    /api/vault/binder-share/{token}      the binder and its pockets
 *
 * Staff:
 *   GET    /api/vault/binder-wanted?status=open requests, with counts per card
 *   POST   /api/vault/binder-wanted/{id}/close  {status: fulfilled | cancelled, note?}
 *
 * No route here reads or returns a price: values are staff business, and
 * every customer and share response goes through stripPrices on the way out.
 * Reading binders and pockets through the collection API is covered by the
 * onRecordEnrich hook at the bottom, which hides any price-like field.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

routerAdd(
  "GET",
  "/api/vault/binders/catalog/{what}",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const what = e.request.pathValue("what");
    e.response.header().set("Cache-Control", "private, max-age=3600");
    if (what === "generations") {
      return e.json(200, {
        generations: [V.NATIONAL].concat(V.GENERATIONS).map((g) => ({
          id: g.id,
          label: g.label,
          from: g.from,
          to: g.to,
          count: g.to - g.from + 1,
        })),
      });
    }
    try {
      if (what === "sets") return e.json(200, V.stripPrices({ sets: L.catalog() }));
      if (what === "pokemon") return e.json(200, V.stripPrices({ species: L.species() }));
      if (what === "illustrators") return e.json(200, { illustrators: L.illustrators() });
    } catch (err) {
      return e.json(502, { message: "The card catalogue is not answering. Try again in a minute." });
    }
    throw new NotFoundError("Unknown catalogue.");
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "GET",
  "/api/vault/binders/search",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const q = String(e.request.url.query().get("q") || "").trim();
    if (q.length < 2) return e.json(200, { cards: [] });
    let list;
    try {
      list = L.getJSON(L.TCG + "/cards?name=" + encodeURIComponent(q) + "&pagination:itemsPerPage=120");
    } catch (err) {
      return e.json(502, { message: "The card catalogue is not answering. Try again in a minute." });
    }
    const sets = L.setMap();
    const out = [];
    for (const c of list) {
      const st = sets[L.setIdOf(c.id)];
      if (!st) continue;
      out.push({
        card_id: c.id,
        name: c.name,
        number: c.localId,
        set_id: st.id,
        set_name: st.name,
        set_total: String(st.official || ""),
        image: c.image || "",
        order: st.order,
      });
    }
    out.sort((a, b) => b.order - a.order);
    return e.json(200, V.stripPrices({ cards: out.slice(0, 80) }));
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders/preview",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const b = e.requestInfo().body || {};
    if (b.kind === "pokedex") {
      const scope = V.dexScope(String(b.query || ""));
      if (!scope) throw new BadRequestError("Pick the national Pokedex or one generation.");
      const count = scope.to - scope.from + 1;
      const step = Math.max(1, Math.floor(count / 14));
      const sample = [];
      for (let n = scope.from; n <= scope.to && sample.length < 14; n += step) {
        sample.push({ name: "#" + n, image: V.spriteUrl(n), set_name: "" });
      }
      return e.json(200, { count: count, sets: 0, sample: sample });
    }
    if (["pokemon", "set", "illustrator"].indexOf(b.kind) < 0 || !b.query) {
      throw new BadRequestError("Pick what the binder is for.");
    }
    let slots;
    try {
      slots = L.buildSlots(b.kind, String(b.query));
    } catch (err) {
      return e.json(502, { message: "The card catalogue is not answering. Try again in a minute." });
    }
    const sets = {};
    slots.forEach((s) => {
      sets[s.set_id] = 1;
    });
    return e.json(
      200,
      V.stripPrices({
        count: slots.length,
        sets: Object.keys(sets).length,
        sample: slots
          .filter((s) => s.image)
          .slice(-14)
          .reverse()
          .map((s) => ({ name: s.name, image: s.image, set_name: s.set_name })),
      })
    );
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const b = e.requestInfo().body || {};
    const kind = String(b.kind || "");
    if (L.KINDS.indexOf(kind) < 0 && kind !== "pokedex") throw new BadRequestError("Pick what the binder is for.");
    const name = String(b.name || "").trim().slice(0, 120);
    if (!name) throw new BadRequestError("Give the binder a name.");
    const query = String(b.query || "").trim().slice(0, 200);
    if (kind !== "custom" && !query) throw new BadRequestError("Pick what the binder is for.");
    const grid = V.gridOf(String(b.grid || ""));

    const existing = e.app.countRecords("binders", $dbx.hashExp({ customer: e.auth.id }));
    if (existing >= 50) throw new BadRequestError("You have 50 binders. Delete one before starting another.");

    let slots = [];
    let dexScope = "";
    if (kind === "pokedex") {
      const scope = V.dexScope(query);
      if (!scope) throw new BadRequestError("Pick the national Pokedex or one generation.");
      dexScope = scope.id;
      const names = {};
      try {
        for (const s of L.species()) names[s.id] = s.label;
      } catch (err) {
        // PokeAPI is down: pockets fall back to "No. 0025" names.
      }
      slots = V.dexSlots(scope.id, names);
    } else if (kind !== "custom") {
      try {
        slots = L.buildSlots(kind, query);
      } catch (err) {
        return e.json(502, { message: "The card catalogue is not answering. Try again in a minute." });
      }
      if (!slots.length) throw new BadRequestError("No printed cards found for that.");
    }
    let logo = "";
    if (kind === "set") {
      const st = L.setMap()[query];
      logo = st ? st.logo : "";
    }
    const cover = kind === "pokedex" || kind === "custom" ? "" : L.pickCover(slots);
    const color = L.COLORS.indexOf(b.color) >= 0 ? b.color : "volt";

    const binders = e.app.findCollectionByNameOrId("binders");
    const cardsCol = e.app.findCollectionByNameOrId("binder_cards");
    const rec = new Record(binders);
    e.app.runInTransaction((tx) => {
      rec.set("customer", e.auth.id);
      rec.set("name", name);
      rec.set("owner", String(b.owner || "").trim().slice(0, 80));
      rec.set("kind", kind);
      rec.set("query", query);
      rec.set("query_label", String(b.query_label || "").slice(0, 200));
      rec.set("color", color);
      rec.set("master", false);
      rec.set("logo", logo);
      rec.set("cover", cover);
      rec.set("grid", grid);
      rec.set("dex_scope", dexScope);
      rec.set("min_slots", kind === "custom" ? V.perPage(grid) : 0);
      rec.set("share_token", "");
      rec.set("sort", Date.now() / 1000);
      tx.save(rec);
      slots.forEach((s, i) => {
        const r = new Record(cardsCol);
        r.set("binder", rec.id);
        r.set("card_id", s.card_id);
        r.set("variant", "");
        r.set("name", s.name);
        r.set("number", s.number);
        r.set("set_id", s.set_id);
        r.set("set_name", s.set_name);
        r.set("set_total", s.set_total);
        r.set("image", s.image);
        r.set("dex", s.dex || 0);
        r.set("sprite", s.sprite || "");
        r.set("sort", (i + 1) * 10);
        r.set("slot", i);
        r.set("owned", false);
        tx.save(r);
      });
    });
    return e.json(200, { id: rec.id, cards: slots.length });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders/{id}/add",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const b = e.requestInfo().body || {};
    const cardId = String(b.card_id || "").slice(0, 80);
    if (!cardId) throw new BadRequestError("Pick a card to add.");

    const used = e.app
      .findRecordsByFilter("binder_cards", "binder = {:b} && slot >= 0", "", 0, 0, { b: binder.id })
      .map((r) => r.getInt("slot"));
    const wantSlot = typeof b.slot === "number" && b.slot >= 0 && b.slot <= 20000 ? Math.floor(b.slot) : -1;
    const slot = wantSlot >= 0 && used.indexOf(wantSlot) < 0 ? wantSlot : V.firstFreeSlot(used, 0);

    const existing = e.app.findRecordsByFilter(
      "binder_cards",
      "binder = {:b} && card_id = {:c} && variant = ''",
      "",
      1,
      0,
      { b: binder.id, c: cardId }
    );
    if (existing.length) {
      const r = existing[0];
      // Taken out earlier (slot -1): put it back rather than refusing.
      if (r.getInt("slot") < 0) {
        r.set("slot", slot);
        e.app.save(r);
        return e.json(200, { id: r.id, slot: slot, restored: true });
      }
      return e.json(200, { id: r.id, slot: r.getInt("slot"), existed: true });
    }

    let d;
    try {
      d = L.cardDetail(cardId);
    } catch (err) {
      return e.json(502, { message: "The card catalogue is not answering. Try again in a minute." });
    }
    const st = L.setMap()[L.setIdOf(cardId)];
    const last = e.app.findRecordsByFilter("binder_cards", "binder = {:b}", "-sort", 1, 0, { b: binder.id });
    const r = new Record(e.app.findCollectionByNameOrId("binder_cards"));
    r.set("binder", binder.id);
    r.set("card_id", cardId);
    r.set("variant", "");
    r.set("name", d.name);
    r.set("number", d.localId);
    r.set("set_id", st ? st.id : L.setIdOf(cardId));
    r.set("set_name", d.set_name || (st ? st.name : ""));
    r.set("set_total", st ? String(st.official || "") : "");
    r.set("rarity", d.rarity);
    r.set("image", d.image);
    r.set("sort", (last.length ? last[0].getFloat("sort") : 0) + 10);
    r.set("slot", slot);
    r.set("owned", !!b.owned);
    if (b.owned) r.set("owned_at", new DateTime());
    e.app.save(r);
    if (!binder.getString("cover") && d.image) {
      binder.set("cover", d.image);
      e.app.save(binder);
    }
    return e.json(200, { id: r.id, slot: slot });
  },
  $apis.requireAuth("customers")
);

// Fill a binder in one go with cards the client already resolved.
routerAdd(
  "POST",
  "/api/vault/binders/{id}/bulk",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const list = (e.requestInfo().body || {}).cards || [];
    if (!Array.isArray(list) || !list.length || list.length > 600) {
      throw new BadRequestError("Send between 1 and 600 cards.");
    }
    const col = e.app.findCollectionByNameOrId("binder_cards");
    const last = e.app.findRecordsByFilter("binder_cards", "binder = {:b}", "-sort", 1, 0, { b: binder.id });
    const used = e.app
      .findRecordsByFilter("binder_cards", "binder = {:b} && slot >= 0", "", 0, 0, { b: binder.id })
      .map((r) => r.getInt("slot"));
    let sort = last.length ? last[0].getFloat("sort") : 0;
    let added = 0;
    e.app.runInTransaction((tx) => {
      for (const c of list) {
        if (!c || !c.card_id || !c.name) continue;
        sort += 10;
        const slot = V.firstFreeSlot(used, 0);
        const r = new Record(col);
        r.set("binder", binder.id);
        r.set("card_id", String(c.card_id).slice(0, 80));
        r.set("variant", "");
        r.set("name", String(c.name).slice(0, 200));
        r.set("number", String(c.number || "").slice(0, 30));
        r.set("set_id", String(c.set_id || "").slice(0, 60));
        r.set("set_name", String(c.set_name || "").slice(0, 120));
        r.set("set_total", String(c.set_total || "").slice(0, 20));
        r.set("rarity", String(c.rarity || "").slice(0, 80));
        r.set("image", String(c.image || "").slice(0, 500));
        r.set("group_name", String(c.group_name || "").slice(0, 120));
        r.set("group_shape", c.group_shape === "col" ? "col" : "row");
        r.set("lang", String(c.lang || "en").slice(0, 5));
        r.set("manual", !!c.manual);
        r.set("owned", false);
        r.set("sort", sort);
        r.set("slot", slot);
        try {
          tx.save(r);
          used.push(slot);
          added++;
        } catch (err) {
          // Already in the binder (unique card and variant); skip it.
        }
      }
    });
    return e.json(200, { added: added });
  },
  $apis.requireAuth("customers")
);

/**
 * Applies a batch of pocket moves and owned flags in one transaction: the
 * multi-select actions, page operations, undo and redo all land here. The
 * batch is refused whole if any pocket is not in this binder or two pockets
 * would share a position.
 */
routerAdd(
  "POST",
  "/api/vault/binders/{id}/layout",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const b = e.requestInfo().body || {};
    const changes = b.pockets || [];
    const rows = e.app.findRecordsByFilter("binder_cards", "binder = {:b}", "", 0, 0, { b: binder.id });
    const byId = {};
    for (const r of rows) byId[r.id] = r;
    const problem = V.checkLayoutChanges(changes, byId);
    if (problem) throw new BadRequestError(problem);
    let minSlots = null;
    if (b.min_slots !== undefined) {
      if (typeof b.min_slots !== "number" || b.min_slots < 0 || b.min_slots > 20000) {
        throw new BadRequestError("The page count is out of range. Reload and try again.");
      }
      minSlots = Math.floor(b.min_slots);
    }

    // Final positions: unchanged rows keep theirs.
    const finalSlot = {};
    for (const r of rows) finalSlot[r.id] = r.getInt("slot");
    for (const c of changes) if (c.slot !== undefined) finalSlot[c.id] = c.slot;
    const clashes = V.slotClashes(Object.keys(finalSlot).map((k) => finalSlot[k]));
    if (clashes.length) {
      throw new BadRequestError("Two cards would share a pocket. Reload the binder and try again.");
    }

    e.app.runInTransaction((tx) => {
      for (const c of changes) {
        const r = byId[c.id];
        let dirty = false;
        if (c.slot !== undefined && c.slot !== r.getInt("slot")) {
          r.set("slot", c.slot);
          dirty = true;
        }
        if (c.owned !== undefined && c.owned !== r.getBool("owned")) {
          r.set("owned", c.owned);
          r.set("owned_at", c.owned ? new DateTime() : "");
          dirty = true;
        }
        if (dirty) tx.save(r);
      }
      if (minSlots !== null && minSlots !== binder.getInt("min_slots")) {
        binder.set("min_slots", minSlots);
        tx.save(binder);
      }
    });
    return e.json(200, { changed: changes.length });
  },
  $apis.requireAuth("customers")
);

// Which of this binder's needed pockets the shop has on the shelf right
// now. One batched catalogue join however many pockets there are, and the
// answer is pocket ids only: no qty, price, SKU or location ever leaves.
routerAdd(
  "GET",
  "/api/vault/binder-availability/{id}",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const S = require(`${__hooks}/lib/binders_stock.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const rows = e.app.findRecordsByFilter(
      "binder_cards",
      "binder = {:b} && owned = false && slot >= 0",
      "",
      0,
      0,
      { b: binder.id }
    );
    const pockets = S.pocketsOf(rows);
    const keys = S.availableKeysFor(e.app, pockets.map((p) => p.card_id));
    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, { in_stock: S.matchNeededPockets(pockets, keys) });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders/{id}/share",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    let token = binder.getString("share_token");
    if (!token) {
      // 32 characters from 62: about 190 bits, not guessable.
      token = $security.randomString(32);
      binder.set("share_token", token);
      e.app.save(binder);
    }
    return e.json(200, { token: token });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "DELETE",
  "/api/vault/binders/{id}/share",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    if (binder.getString("share_token")) {
      binder.set("share_token", "");
      e.app.save(binder);
    }
    return e.json(200, { token: "" });
  },
  $apis.requireAuth("customers")
);

// The read-only share view. No sign-in; the token is the only key. It
// returns what the binder is and which pockets are filled, never who owns
// it, their customer record, their wanted list or any value.
routerAdd("GET", "/api/vault/binder-share/{token}", (e) => {
  const V = require(`${__hooks}/lib/binders_v2.js`);
  const S = require(`${__hooks}/lib/binders_stock.js`);
  const token = String(e.request.pathValue("token") || "");
  const gone = "This share link has been switched off or never existed. Ask for a new link.";
  if (token.length < 24 || token.length > 64 || !/^[A-Za-z0-9]+$/.test(token)) {
    throw new NotFoundError(gone);
  }
  const found = e.app.findRecordsByFilter("binders", "share_token = {:t}", "", 1, 0, { t: token });
  if (!found.length) throw new NotFoundError(gone);
  const binder = found[0];
  const rows = e.app.findRecordsByFilter("binder_cards", "binder = {:b} && slot >= 0", "slot", 0, 0, {
    b: binder.id,
  });
  // The badge shows on the share page too: a boolean per needed pocket,
  // never a quantity or a value.
  const simple = S.pocketsOf(rows);
  const keys = S.availableKeysFor(e.app, simple.map((p) => p.card_id));
  const flagged = {};
  for (const id of S.matchNeededPockets(simple, keys)) flagged[id] = true;
  e.response.header().set("Cache-Control", "no-store");
  e.response.header().set("X-Robots-Tag", "noindex");
  return e.json(
    200,
    V.stripPrices({
      binder: V.shareBinderOut(binder),
      pockets: rows.map((r) => {
        const out = V.pocketOut(r);
        if (flagged[r.id]) out.in_stock = true;
        return out;
      }),
    })
  );
});

// A customer asks the shop for a card they need. The card comes from their
// own pocket, never from the request body.
routerAdd(
  "POST",
  "/api/vault/binder-wanted",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const b = e.requestInfo().body || {};
    let pocket;
    try {
      pocket = e.app.findRecordById("binder_cards", String(b.pocket || ""));
    } catch (err) {
      throw new NotFoundError("That card is not in your binders. Reload and try again.");
    }
    const binder = L.ownBinder(e.app, e.auth, pocket.getString("binder"));
    const cardId = pocket.getString("card_id");
    const findOpen = () =>
      e.app.findRecordsByFilter(
        "binder_wanted",
        "customer = {:c} && card_id = {:k} && status = 'open'",
        "",
        1,
        0,
        { c: e.auth.id, k: cardId }
      );
    const open = findOpen();
    if (open.length) return e.json(200, { id: open[0].id, card_id: cardId, existed: true });

    const openCount = e.app.countRecords("binder_wanted", $dbx.hashExp({ customer: e.auth.id, status: "open" }));
    if (openCount >= 300) {
      throw new BadRequestError("You have 300 open requests. Cancel some before asking for more.");
    }
    const r = new Record(e.app.findCollectionByNameOrId("binder_wanted"));
    r.set("customer", e.auth.id);
    r.set("card_id", cardId);
    r.set("card_name", pocket.getString("name"));
    r.set("number", pocket.getString("number"));
    r.set("set_id", pocket.getString("set_id"));
    r.set("set_name", pocket.getString("set_name"));
    r.set("image", pocket.getString("image") || pocket.getString("sprite"));
    r.set("dex", pocket.getInt("dex"));
    r.set("binder", binder.id);
    r.set("status", "open");
    try {
      e.app.save(r);
    } catch (err) {
      // Lost a race with a double tap: the unique index kept one open request.
      const again = findOpen();
      if (again.length) return e.json(200, { id: again[0].id, card_id: cardId, existed: true });
      throw err;
    }
    return e.json(200, { id: r.id, card_id: cardId });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "DELETE",
  "/api/vault/binder-wanted/{id}",
  (e) => {
    let r;
    try {
      r = e.app.findRecordById("binder_wanted", e.request.pathValue("id"));
    } catch (err) {
      throw new NotFoundError("That request does not exist.");
    }
    if (r.getString("customer") !== e.auth.id) throw new NotFoundError("That request does not exist.");
    if (r.getString("status") === "open") {
      r.set("status", "cancelled");
      r.set("closed_at", new DateTime());
      e.app.save(r);
    }
    return e.json(200, { id: r.id, status: r.getString("status") });
  },
  $apis.requireAuth("customers")
);

// Staff: which cards customers are after, most wanted first.
routerAdd(
  "GET",
  "/api/vault/binder-wanted",
  (e) => {
    const status = String(e.request.url.query().get("status") || "open");
    if (["open", "cancelled", "fulfilled"].indexOf(status) < 0) {
      throw new BadRequestError("Status must be open, cancelled or fulfilled.");
    }
    const rows = e.app.findRecordsByFilter("binder_wanted", "status = {:s}", "-created", 2000, 0, { s: status });
    const cards = {};
    const customerCache = {};
    const requests = [];
    for (const r of rows) {
      const k = r.getString("card_id");
      if (!cards[k]) {
        cards[k] = {
          card_id: k,
          card_name: r.getString("card_name"),
          number: r.getString("number"),
          set_id: r.getString("set_id"),
          set_name: r.getString("set_name"),
          image: r.getString("image"),
          dex: r.getInt("dex"),
          count: 0,
          latest: r.getString("created"),
        };
      }
      cards[k].count++;
      const cid = r.getString("customer");
      if (!customerCache[cid]) {
        try {
          const c = e.app.findRecordById("customers", cid);
          customerCache[cid] = { id: cid, code: c.getString("code"), name: c.getString("name") };
        } catch (err) {
          customerCache[cid] = { id: cid, code: "", name: "" };
        }
      }
      requests.push({
        id: r.id,
        card_id: k,
        card_name: r.getString("card_name"),
        set_name: r.getString("set_name"),
        binder: r.getString("binder"),
        status: r.getString("status"),
        created: r.getString("created"),
        customer: customerCache[cid],
      });
    }
    const list = Object.keys(cards)
      .map((k) => cards[k])
      .sort((a, b) => b.count - a.count || (a.latest < b.latest ? 1 : -1));
    return e.json(200, { status: status, total: rows.length, cards: list, requests: requests });
  },
  $apis.requireAuth("staff")
);

routerAdd(
  "POST",
  "/api/vault/binder-wanted/{id}/close",
  (e) => {
    const b = e.requestInfo().body || {};
    const status = String(b.status || "fulfilled");
    if (status !== "fulfilled" && status !== "cancelled") {
      throw new BadRequestError("Close a request as fulfilled or cancelled.");
    }
    let r;
    try {
      r = e.app.findRecordById("binder_wanted", e.request.pathValue("id"));
    } catch (err) {
      throw new NotFoundError("That request does not exist.");
    }
    r.set("status", status);
    r.set("closed_at", new DateTime());
    if (b.note !== undefined) r.set("staff_note", String(b.note).slice(0, 500));
    e.app.save(r);
    return e.json(200, { id: r.id, status: status });
  },
  $apis.requireAuth("staff")
);

// Collection API reads (binders, pockets, wanted requests) by anyone but
// staff: hide any price-like field, so a column added later cannot leak a
// value to a customer.
onRecordEnrich(
  (e) => {
    const V = require(`${__hooks}/lib/binders_v2.js`);
    const auth = e.requestInfo ? e.requestInfo.auth : null;
    const isStaff = !!auth && auth.collection().name === "staff";
    if (!isStaff) {
      const names = [];
      const fields = e.record.collection().fields;
      for (let i = 0; i < fields.length; i++) names.push(fields[i].getName());
      const hide = V.priceFieldNames(names);
      if (hide.length) e.record.hide(...hide);
    }
    return e.next();
  },
  "binders",
  "binder_cards",
  "binder_wanted",
  "binder_alerts"
);
