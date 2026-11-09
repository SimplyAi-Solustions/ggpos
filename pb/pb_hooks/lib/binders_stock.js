/**
 * "In stock at GG": which binder pockets match an item on the shop's shelf,
 * and the alert written when a card a customer needs arrives.
 *
 * Matching rules, agreed with the staff side (which owns `items`):
 *  - an item is available only when items.status = "in_stock" and qty > 0;
 *    reserved, listed_ebay, sold, returned and written_off never count, and
 *    status alone is right because the till sync marks Epos sales sold
 *    within minutes;
 *  - the match is the exact print. A binder pocket holds a TCGdex card id
 *    and a language ("" means English); items.card points at a `cards`
 *    catalogue row whose external_ids.tcgdex is that same TCGdex id and
 *    whose `language` is the print's language. A Japanese print never
 *    matches an English pocket and nothing is bridged through tcgplayer,
 *    cardmarket or name lookups;
 *  - only needed pockets (owned = false) that are on a page (slot >= 0)
 *    match, and nothing beyond a boolean ever reaches a customer: no qty,
 *    price, cost, SKU or location.
 *
 * Pure functions at the top so `node --test` can load this file
 * (pb/scripts/binders_stock.test.cjs) without a PocketBase runtime; the
 * functions that need the database take `app` as an argument. Handlers
 * require() this inside their body - see pb/README.md on hook isolation.
 */

/** A pocket or catalogue language, normalised: blank means English. */
function normLang(lang) {
  const v = String(lang || "").trim().toLowerCase();
  return v || "en";
}

/** The identity of one exact print: TCGdex id plus language. */
function printKey(cardId, lang) {
  return String(cardId || "") + "|" + normLang(lang);
}

/** Whether an items row counts as on the shelf for customers. */
function itemIsAvailable(status, qty, card) {
  return status === "in_stock" && Number(qty) > 0 && !!card;
}

/**
 * The pockets that may show the badge: needed (never owned), on a page,
 * and the exact print the shop has. `pockets` is [{id, card_id, lang,
 * owned, slot}], `availableKeys` a set-like object from availableKeysFor.
 */
function matchNeededPockets(pockets, availableKeys) {
  const out = [];
  for (const p of pockets || []) {
    if (p.owned) continue;
    if (Number(p.slot) < 0) continue;
    if (availableKeys[printKey(p.card_id, p.lang)]) out.push(p.id);
  }
  return out;
}

/** The alert's one sentence. No price, ever. */
function alertMessage(cardName, binderName) {
  return (
    "Good news: " +
    cardName +
    " for your " +
    binderName +
    " binder is in at GG Entertainment. Pop in before it goes."
  );
}

// ---------------------------------------------------------------------
// Database lookups (take `app`; one batched query, never one per pocket)
// ---------------------------------------------------------------------

/**
 * `{ "<tcgdex id>|<lang>": 1 }` for every available shop item whose
 * catalogue card is one of the given TCGdex ids. One JOIN per chunk of
 * 400 ids, however many pockets the binder has.
 */
function availableKeysFor(app, cardIds) {
  const seen = {};
  const list = [];
  for (const raw of cardIds || []) {
    const id = String(raw || "");
    if (!id || seen[id]) continue;
    seen[id] = 1;
    list.push(id);
  }
  const keys = {};
  for (let start = 0; start < list.length; start += 400) {
    const chunk = list.slice(start, start + 400);
    const params = {};
    const marks = [];
    chunk.forEach((id, i) => {
      params["c" + i] = id;
      marks.push("{:c" + i + "}");
    });
    const rows = arrayOf(new DynamicModel({ tid: "", lang: "" }));
    app
      .db()
      .newQuery(
        "SELECT json_extract(c.external_ids, '$.tcgdex') AS tid, c.language AS lang" +
          " FROM items i JOIN cards c ON c.id = i.card" +
          " WHERE i.status = 'in_stock' AND i.qty > 0 AND i.card != ''" +
          " AND json_extract(c.external_ids, '$.tcgdex') IN (" +
          marks.join(", ") +
          ")"
      )
      .bind(params)
      .all(rows);
    for (const row of rows) {
      if (row.tid) keys[printKey(row.tid, row.lang)] = 1;
    }
  }
  return keys;
}

/** Plain {id, card_id, lang, owned, slot} from binder_cards records. */
function pocketsOf(records) {
  return (records || []).map((r) => ({
    id: r.id,
    card_id: r.getString("card_id"),
    lang: r.getString("lang"),
    owned: r.getBool("owned"),
    slot: r.getInt("slot"),
  }));
}

/** The exact print an items row holds: {tid, lang}, or null. */
function printOfItem(app, item) {
  const cardRef = item.getString("card");
  if (!cardRef) return null;
  let card;
  try {
    card = app.findRecordById("cards", cardRef);
  } catch (err) {
    return null;
  }
  // external_ids is a JSON field: goja hands back raw bytes, so read it the
  // way lib/vaultutil.js does, through toString then JSON.parse.
  let ext = {};
  try {
    const raw = card.get("external_ids");
    if (raw !== null && raw !== undefined) ext = JSON.parse(toString(raw)) || {};
  } catch (err) {
    ext = {};
  }
  const tid = String(ext.tcgdex || "");
  if (!tid) return null;
  return { tid: tid, lang: normLang(card.getString("language")) };
}

/** Catalogue row ids that are this exact print (same TCGdex id and language). */
function cardRowIdsForPrint(app, tid, lang) {
  const rows = arrayOf(new DynamicModel({ id: "", lang: "" }));
  app
    .db()
    .newQuery(
      "SELECT id, language AS lang FROM cards WHERE json_extract(external_ids, '$.tcgdex') = {:t}"
    )
    .bind({ t: tid })
    .all(rows);
  const out = [];
  for (const row of rows) {
    if (normLang(row.lang) === lang) out.push(String(row.id));
  }
  return out;
}

/** How many other available items hold this print, besides `excludeItemId`. */
function otherAvailableCount(app, tid, lang, excludeItemId) {
  const cardIds = cardRowIdsForPrint(app, tid, lang);
  if (!cardIds.length) return 0;
  const params = { x: String(excludeItemId || "") };
  const marks = [];
  cardIds.slice(0, 400).forEach((id, i) => {
    params["c" + i] = id;
    marks.push("{:c" + i + "}");
  });
  const counted = new DynamicModel({ n: 0 });
  app
    .db()
    .newQuery(
      "SELECT COUNT(*) AS n FROM items" +
        " WHERE status = 'in_stock' AND qty > 0 AND id != {:x}" +
        " AND card IN (" +
        marks.join(", ") +
        ")"
    )
    .bind(params)
    .one(counted);
  return Number(counted.n);
}

/**
 * An items row has just become available. If that is the moment its print
 * came back onto the shelf (no other copy was already available), write one
 * alert per customer whose binders still need it, alerts on, dedupe-keyed
 * so the same arrival can never tell anyone twice. Never throws: a failed
 * alert must never break a stock write.
 */
function onItemAvailable(app, item) {
  const print = printOfItem(app, item);
  if (!print) return;
  if (otherAvailableCount(app, print.tid, print.lang, item.id) > 0) return;

  const pockets = app.findRecordsByFilter(
    "binder_cards",
    "card_id = {:c} && owned = false && slot >= 0",
    "",
    500,
    0,
    { c: print.tid }
  );
  const binderCache = {};
  const byCustomer = {};
  for (const pocket of pockets) {
    if (normLang(pocket.getString("lang")) !== print.lang) continue;
    const binderId = pocket.getString("binder");
    if (!binderCache[binderId]) {
      try {
        binderCache[binderId] = app.findRecordById("binders", binderId);
      } catch (err) {
        continue;
      }
    }
    const binder = binderCache[binderId];
    if (binder.getBool("alerts_off")) continue;
    const customer = binder.getString("customer");
    if (!customer || byCustomer[customer]) continue;
    byCustomer[customer] = { binder: binder, cardName: pocket.getString("name") };
  }

  const col = app.findCollectionByNameOrId("binder_alerts");
  for (const customer of Object.keys(byCustomer)) {
    const hit = byCustomer[customer];
    // Still unread from the last arrival: nothing new to say.
    const unread = app.findRecordsByFilter(
      "binder_alerts",
      "customer = {:cu} && card_id = {:ca} && lang = {:l} && read_at = ''",
      "",
      1,
      0,
      { cu: customer, ca: print.tid, l: print.lang }
    );
    if (unread.length) continue;
    const r = new Record(col);
    r.set("customer", customer);
    r.set("binder", hit.binder.id);
    r.set("card_id", print.tid);
    r.set("lang", print.lang);
    r.set("card_name", hit.cardName);
    r.set("binder_name", hit.binder.getString("name"));
    r.set("message", alertMessage(hit.cardName, hit.binder.getString("name")));
    r.set("dedupe_key", customer + "|" + printKey(print.tid, print.lang) + "|" + item.id);
    try {
      app.save(r);
    } catch (err) {
      // The unique dedupe key kept an earlier alert for this arrival.
    }
  }
}

module.exports = {
  normLang,
  printKey,
  itemIsAvailable,
  matchNeededPockets,
  alertMessage,
  availableKeysFor,
  pocketsOf,
  printOfItem,
  otherAvailableCount,
  onItemAvailable,
};
