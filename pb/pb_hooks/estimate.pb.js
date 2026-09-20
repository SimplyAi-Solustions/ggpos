/// <reference path="../pb_data/types.d.ts" />

/**
 * estimate.pb.js - the public indicative offer calculator that drives
 * sign-ups (docs/PLAN.md, "Public"; docs/api-contract.md's Phase 5
 * section).
 *
 *   GET /api/vault/estimate/search?q=
 *   GET /api/vault/estimate?card=<id>&condition=NM&finish=normal
 *
 * Both are public: no auth, rate limited (the migration adds the
 * PocketBase-level rules), no writes, and never an adapter call - only the
 * catalogue and price_snapshots rows already on file. Logic lives in
 * lib/estimate.js, per CLAUDE.md's "keep hooks small".
 *
 * Neither route is wired to $apis.requireAuth, so neither needs a staff or
 * customer token; PocketBase still resolves e.auth from a bearer token if
 * one happens to be sent, but nothing here reads it.
 *
 * Each registered handler runs in its own isolated goja context, so every
 * require() lives inside the handler body - see pb/README.md.
 */

function queryParam(e, util, name) {
  let value = "";
  try {
    const info = e.requestInfo();
    value = util.asStr(info && info.query ? info.query[name] : "");
  } catch (err) {
    value = "";
  }
  if (!value) {
    try {
      value = util.asStr(e.request.url.query().get(name));
    } catch (err) {
      // Leave it blank.
    }
  }
  return value;
}

// ---------------------------------------------------------------------
// GET /api/vault/estimate/search?q=
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/estimate/search", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const estimateLib = require(`${__hooks}/lib/estimate.js`);

  const q = queryParam(e, util, "q");
  const rows = estimateLib.searchCatalogue(e.app, q);

  const cards = [];
  for (let i = 0; i < rows.length; i++) {
    const card = rows[i];
    if (!card) continue;
    let setName = "";
    try {
      setName = e.app.findRecordById("card_sets", card.getString("set")).getString("name");
    } catch (err) {
      setName = "";
    }
    cards.push({
      id: card.id,
      name: card.getString("name"),
      set: setName,
      number: card.getString("number"),
      image: card.getString("image_large") || card.getString("image_small") || "",
    });
  }

  return e.json(200, { cards: cards });
});

// ---------------------------------------------------------------------
// GET /api/vault/estimate?card=<id>&condition=NM&finish=normal
// ---------------------------------------------------------------------
routerAdd("GET", "/api/vault/estimate", (e) => {
  const util = require(`${__hooks}/lib/vaultutil.js`);
  const policy = require(`${__hooks}/adapters/pricing_policy.js`);
  const estimateLib = require(`${__hooks}/lib/estimate.js`);

  const cardId = queryParam(e, util, "card");
  if (!cardId) {
    throw e.badRequestError("Pick a card first.", null);
  }
  const condition = policy.normalizeCondition(queryParam(e, util, "condition"));
  if (condition === null) {
    throw e.badRequestError("Pick a condition: NM, LP, MP, HP or DMG.", null);
  }
  const finish = queryParam(e, util, "finish");

  const result = estimateLib.estimateForCard(e.app, cardId, condition, finish);
  if (!result) {
    throw e.notFoundError("Card not found. Search again or visit the shop for a look in person.", null);
  }

  return e.json(200, result);
});
