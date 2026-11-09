/// <reference path="../pb_data/types.d.ts" />

/**
 * binders.pb.js - the customer binder builder (ported from GG HQ).
 *
 *   GET  /api/vault/binders/catalog/{what}   sets | pokemon | illustrators
 *   GET  /api/vault/binders/search?q=        card search, for adding singles
 *   POST /api/vault/binders/preview          {kind, query} -> count and sample
 *   POST /api/vault/binders                  create and fill a binder
 *   POST /api/vault/binders/{id}/add         {card_id}
 *   POST /api/vault/binders/{id}/bulk        {cards: [...]}
 *
 * Customers only, and only their own binders. No route here reads or returns
 * a price: values are staff business. Reading and ticking pockets goes
 * through the binders and binder_cards collection rules.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

routerAdd(
  "GET",
  "/api/vault/binders/catalog/{what}",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const what = e.request.pathValue("what");
    e.response.header().set("Cache-Control", "private, max-age=3600");
    try {
      if (what === "sets") return e.json(200, { sets: L.catalog() });
      if (what === "pokemon") return e.json(200, { species: L.species() });
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
    return e.json(200, { cards: out.slice(0, 80) });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders/preview",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const b = e.requestInfo().body || {};
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
    return e.json(200, {
      count: slots.length,
      sets: Object.keys(sets).length,
      sample: slots
        .filter((s) => s.image)
        .slice(-14)
        .reverse()
        .map((s) => ({ name: s.name, image: s.image, set_name: s.set_name })),
    });
  },
  $apis.requireAuth("customers")
);

routerAdd(
  "POST",
  "/api/vault/binders",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const b = e.requestInfo().body || {};
    const kind = String(b.kind || "");
    if (L.KINDS.indexOf(kind) < 0) throw new BadRequestError("Pick what the binder is for.");
    const name = String(b.name || "").trim().slice(0, 120);
    if (!name) throw new BadRequestError("Give the binder a name.");
    const query = String(b.query || "").trim().slice(0, 200);
    if (kind !== "custom" && !query) throw new BadRequestError("Pick what the binder is for.");

    const existing = e.app.countRecords("binders", $dbx.hashExp({ customer: e.auth.id }));
    if (existing >= 50) throw new BadRequestError("You have 50 binders. Delete one before starting another.");

    let slots = [];
    if (kind !== "custom") {
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
    const cover = L.pickCover(slots);
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
      rec.set("sort", Date.now() / 1000);
      tx.save(rec);
      for (const s of slots) {
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
        r.set("sort", s.sort * 10);
        r.set("owned", false);
        tx.save(r);
      }
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
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const b = e.requestInfo().body || {};
    const cardId = String(b.card_id || "").slice(0, 80);
    if (!cardId) throw new BadRequestError("Pick a card to add.");
    const existing = e.app.findRecordsByFilter(
      "binder_cards",
      "binder = {:b} && card_id = {:c} && variant = ''",
      "",
      1,
      0,
      { b: binder.id, c: cardId }
    );
    if (existing.length) return e.json(200, { id: existing[0].id, existed: true });

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
    r.set("owned", !!b.owned);
    if (b.owned) r.set("owned_at", new DateTime());
    e.app.save(r);
    if (!binder.getString("cover") && d.image) {
      binder.set("cover", d.image);
      e.app.save(binder);
    }
    return e.json(200, { id: r.id });
  },
  $apis.requireAuth("customers")
);

// Fill a binder in one go with cards the client already resolved.
routerAdd(
  "POST",
  "/api/vault/binders/{id}/bulk",
  (e) => {
    const L = require(`${__hooks}/lib/binders.js`);
    const binder = L.ownBinder(e.app, e.auth, e.request.pathValue("id"));
    const list = (e.requestInfo().body || {}).cards || [];
    if (!Array.isArray(list) || !list.length || list.length > 600) {
      throw new BadRequestError("Send between 1 and 600 cards.");
    }
    const col = e.app.findCollectionByNameOrId("binder_cards");
    const last = e.app.findRecordsByFilter("binder_cards", "binder = {:b}", "-sort", 1, 0, { b: binder.id });
    let sort = last.length ? last[0].getFloat("sort") : 0;
    let added = 0;
    e.app.runInTransaction((tx) => {
      for (const c of list) {
        if (!c || !c.card_id || !c.name) continue;
        sort += 10;
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
        try {
          tx.save(r);
          added++;
        } catch (err) {
          // Already in the binder (unique slot); skip it.
        }
      }
    });
    return e.json(200, { added: added });
  },
  $apis.requireAuth("customers")
);
