// Full card catalogue import: turning TCGdex, Scryfall, OPTCG and Lorcast
// bulk data into `card_sets` and `cards` rows, and writing a batch of those
// rows into PocketBase.
//
// The normalizers at the top are pure (no PocketBase globals), so the Node
// importer (pb/scripts/catalogue-import.mjs) and its tests require this same
// file. upsertBatch() and the TCGdex helpers at the bottom run inside
// PocketBase only (catalogue_sync.pb.js).
//
// A batch is { game, sets: [SetRow], cards: [CardRow] }:
//   SetRow  { code, name, series, release_date, total, abbr, language, external_ids }
//   CardRow { set_code, number, name, name_en, language, rarity, variant,
//             finishes, image_small, image_large, external_ids }
"use strict";

var TCGDEX = "https://api.tcgdex.net/v2";

/** TCGdex languages the importer takes by default: English plus the Asian prints the shop buys. */
var TCGDEX_LANGS = ["en", "ja", "ko", "zh-tw", "zh-cn", "th", "id"];

/**
 * The suffix a non-English set code carries, so Japanese SV2a and Korean
 * SV2a are two card_sets rows. lib/vault_scan.js setcode() strips it again
 * before comparing with a printed code.
 */
var LANG_TAG = { ja: "ja", ko: "ko", "zh-tw": "tw", "zh-cn": "cn", th: "th", id: "id", fr: "fr", de: "de", it: "it", es: "es", pt: "pt" };

function setCodeFor(id, lang) {
  if (!lang || lang === "en") return String(id);
  return String(id) + "-" + (LANG_TAG[lang] || lang);
}

function dateOrEmpty(s) {
  var m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] + " 00:00:00.000Z" : "";
}

function clip(s, n) {
  return s === null || s === undefined ? "" : String(s).slice(0, n);
}

// ---------------------------------------------------------------------
// TCGdex
// ---------------------------------------------------------------------

/** TCG Pocket sets are digital only: the shop never holds one, so their cards are not imported. */
function isDigitalSet(s) {
  return !!(s && s.serie && /^tcgp$/i.test(String(s.serie.id || "")));
}

/** One TCGdex set detail (GET /v2/{lang}/sets/{id}) as a SetRow. */
function tcgdexSet(lang, s) {
  var count = s.cardCount || {};
  return {
    code: setCodeFor(s.id, lang),
    name: clip(s.name || s.id, 200),
    series: clip(s.serie && s.serie.name, 200),
    release_date: dateOrEmpty(s.releaseDate),
    total: count.official || count.total || 0,
    abbr: clip(s.abbreviation && s.abbreviation.official, 20),
    language: lang,
    external_ids: { tcgdex: s.id, language: lang, tcgdex_count: count.total || 0 },
  };
}

var SUFFIX = /(\s*(?:ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|Prism Star|◇|☆|δ|-GX|-EX))$/;

/** The species part of a Pokemon card name and its printed suffix. */
function splitSuffix(name) {
  var n = String(name || "").trim();
  var m = n.match(SUFFIX);
  if (!m) return { base: n, suffix: "" };
  return { base: n.slice(0, n.length - m[1].length).trim(), suffix: m[1].trim() };
}

/**
 * A translation table from TCGdex dex-id listings: dexByLang[lang][dexId] is
 * the list of card names that carry that Pokedex number. The shortest
 * suffix-free name is the plain species name ("Bulbasaur", "フシギダネ").
 * Returns { lang: { localSpecies: englishSpecies } }.
 */
function speciesTable(dexByLang) {
  function species(names) {
    var best = "";
    for (var i = 0; i < (names || []).length; i++) {
      var b = splitSuffix(names[i]).base;
      if (!b) continue;
      if (!best || b.length < best.length) best = b;
    }
    return best;
  }
  var en = dexByLang.en || {};
  var out = {};
  for (var lang in dexByLang) {
    if (lang === "en") continue;
    var table = {};
    var local = dexByLang[lang];
    for (var dex in local) {
      var enName = species(en[dex]);
      var localName = species(local[dex]);
      if (enName && localName) table[localName] = enName;
    }
    out[lang] = table;
  }
  return out;
}

/**
 * English name for a non-English Pokemon card name: the English species for
 * the longest local species name it contains, plus the printed suffix.
 * "オリーヴァex" to "Arboliva ex". Empty when nothing is known (trainers).
 */
function englishName(localName, table) {
  if (!localName || !table) return "";
  var parts = splitSuffix(localName);
  var best = "";
  for (var sp in table) {
    if (sp.length > best.length && parts.base.indexOf(sp) >= 0) best = sp;
  }
  if (!best) return "";
  var mega = /^メガ|^메가|^超級|^超级/.test(parts.base) && !/^Mega /.test(table[best]) ? "Mega " : "";
  var suffix = parts.suffix ? " " + parts.suffix.replace(/^-/, "") : "";
  return clip(mega + table[best] + suffix, 200);
}

/**
 * The cards of one TCGdex set detail as CardRows. `rarityById` maps a card
 * id to its rarity (from /v2/{lang}/rarities/{name}); `table` is that
 * language's species table for name_en.
 */
function tcgdexCards(lang, s, rarityById, table) {
  var code = setCodeFor(s.id, lang);
  var rows = [];
  if (isDigitalSet(s)) return rows;
  var cards = s.cards || [];
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    if (!c || !c.localId || !c.name) continue;
    var number = String(c.localId);
    try {
      number = decodeURIComponent(number);
    } catch (err) {
      // keep it as given
    }
    rows.push({
      set_code: code,
      number: clip(number, 40),
      name: clip(c.name, 200),
      name_en: lang === "en" ? clip(c.name, 200) : englishName(c.name, table),
      language: lang,
      rarity: clip((rarityById && rarityById[c.id]) || "", 100),
      variant: "",
      finishes: [],
      image_small: c.image ? c.image + "/low.webp" : "",
      image_large: c.image ? c.image + "/high.webp" : "",
      external_ids: { tcgdex: c.id, language: lang },
    });
  }
  return rows;
}

/** One TCGdex card detail (GET /v2/{lang}/cards/{id}) as a SetRow and a CardRow, for the live fallback. */
function tcgdexDetail(lang, d, table) {
  var s = d.set || {};
  var set = tcgdexSet(lang, { id: s.id, name: s.name, cardCount: s.cardCount, serie: null, releaseDate: "" });
  var row = tcgdexCards(lang, { id: s.id, cards: [{ id: d.id, localId: d.localId, name: d.name, image: d.image }] }, {}, table)[0];
  if (row) {
    row.rarity = clip(d.rarity || "", 100);
    var v = d.variants || {};
    var finishes = [];
    ["normal", "reverse", "holo", "firstEdition", "wPromo"].forEach(function (k) {
      if (v[k]) finishes.push(k);
    });
    row.finishes = finishes;
  }
  return { set: set, card: row };
}

// ---------------------------------------------------------------------
// Scryfall, OPTCG, Lorcast
// ---------------------------------------------------------------------

/** One Scryfall card object (default_cards bulk) as a CardRow, or null for digital-only cards. */
function scryfallCard(raw) {
  if (!raw || raw.digital || !raw.collector_number || !raw.set) return null;
  var images = raw.image_uris || (raw.card_faces && raw.card_faces[0] && raw.card_faces[0].image_uris) || {};
  var lang = raw.lang || "en";
  return {
    set_code: clip(raw.set, 40),
    number: clip(raw.collector_number, 40),
    name: clip(raw.printed_name && lang !== "en" ? raw.printed_name : raw.name, 200),
    name_en: clip(raw.name, 200),
    language: lang,
    rarity: clip(raw.rarity, 100),
    variant: clip((raw.promo_types || []).join(","), 60),
    finishes: raw.finishes || [],
    image_small: images.small || images.normal || "",
    image_large: images.normal || images.large || "",
    external_ids: { scryfall: raw.id, language: lang },
    tcgplayer_id: raw.tcgplayer_id != null ? String(raw.tcgplayer_id) : "",
    cardmarket_id: raw.cardmarket_id != null ? String(raw.cardmarket_id) : "",
  };
}

function scryfallSet(s) {
  return {
    code: clip(s.code, 40),
    name: clip(s.name, 200),
    series: clip(s.set_type, 200),
    release_date: dateOrEmpty(s.released_at),
    total: s.printed_size || s.card_count || 0,
    abbr: clip(String(s.code || "").toUpperCase(), 20),
    language: "en",
    external_ids: { scryfall: s.id },
  };
}

/**
 * OPTCG /api/allSetCards/ rows as { sets, cards }. A parallel (alt art)
 * shares its card code with the base print, so it is stored under its image
 * id ("OP01-001_p1") with variant "parallel". Images are left blank: OPTCG
 * bans hotlinking, so they are re-hosted when an item is created.
 */
function optcgRows(list) {
  var sets = {};
  var cards = [];
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var code = r && r.card_set_id;
    if (!code || !r.card_name) continue;
    var dash = code.lastIndexOf("-");
    var setCode = dash >= 0 ? code.slice(0, dash) : String(r.set_id || "");
    if (!setCode) continue;
    if (!sets[setCode]) sets[setCode] = { code: setCode, name: clip(r.set_name || setCode, 200), series: "", release_date: "", total: 0, abbr: setCode, language: "en", external_ids: { optcg: r.set_id } };
    var parallel = /\(parallel\)/i.test(r.card_name) || (r.card_image_id && r.card_image_id !== code);
    var number = parallel ? String(r.card_image_id || code + "_p") : code;
    if (seen[setCode + "|" + number]) continue;
    seen[setCode + "|" + number] = true;
    cards.push({
      set_code: setCode,
      number: clip(number, 40),
      name: clip(r.card_name.replace(/\s*\(Parallel\)\s*$/i, ""), 200),
      name_en: clip(r.card_name.replace(/\s*\(Parallel\)\s*$/i, ""), 200),
      language: "en",
      rarity: clip(r.rarity, 100),
      variant: parallel ? "parallel" : "",
      finishes: parallel ? ["parallel"] : ["normal"],
      image_small: "",
      image_large: "",
      external_ids: { optcg: r.card_image_id || code, language: "en", image_url: r.card_image || "" },
    });
  }
  return { sets: Object.keys(sets).map(function (k) { return sets[k]; }), cards: cards };
}

function lorcastSet(s) {
  return { code: clip(s.code, 40), name: clip(s.name, 200), series: "", release_date: dateOrEmpty(s.released_at), total: 0, abbr: clip(s.code, 20), language: "en", external_ids: { lorcast: s.id } };
}

function lorcastCard(raw) {
  if (!raw || !raw.collector_number || !raw.set) return null;
  var images = (raw.image_uris && raw.image_uris.digital) || {};
  var name = raw.version ? raw.name + " - " + raw.version : raw.name;
  return {
    set_code: clip(raw.set.code, 40),
    number: clip(raw.collector_number, 40),
    name: clip(name, 200),
    name_en: clip(name, 200),
    language: raw.lang || "en",
    rarity: clip(raw.rarity, 100),
    variant: "",
    finishes: raw.prices && raw.prices.usd_foil != null ? ["normal", "foil"] : ["normal"],
    image_small: images.small || images.normal || "",
    image_large: images.large || images.normal || "",
    external_ids: { lorcast: raw.id, language: raw.lang || "en" },
    tcgplayer_id: raw.tcgplayer_id != null ? String(raw.tcgplayer_id) : "",
  };
}

// ---------------------------------------------------------------------
// Writing a batch (PocketBase only)
// ---------------------------------------------------------------------

function searchText(row, setCode) {
  var parts = [row.name, row.name_en && row.name_en !== row.name ? row.name_en : "", row.number, setCode];
  return parts.filter(Boolean).join(" ").toLowerCase().slice(0, 400);
}

function jsonOf(record, field) {
  try {
    var raw = record.get(field);
    if (raw === null || raw === undefined) return null;
    var s = typeof raw === "string" ? raw : String(raw);
    if (!s || s === "null") return null;
    return JSON.parse(s);
  } catch (err) {
    return null;
  }
}

function merged(a, b) {
  var out = {};
  var k;
  for (k in a || {}) out[k] = a[k];
  for (k in b || {}) if (b[k] !== "" && b[k] !== null && b[k] !== undefined) out[k] = b[k];
  return out;
}

/** Set `field` to `value` when it differs; returns true when it changed. */
function put(record, field, value) {
  var cur = record.get(field);
  if (typeof value === "number") {
    if (Number(cur) === value) return false;
  } else if (String(cur === null || cur === undefined ? "" : cur) === String(value)) return false;
  record.set(field, value);
  return true;
}

/**
 * Upserts one batch inside a transaction. Rows written by hand
 * (source = manual) are left alone. Returns counts.
 */
function upsertBatch(app, batch) {
  var counts = { sets_created: 0, sets_updated: 0, cards_created: 0, cards_updated: 0, cards_unchanged: 0, skipped: 0 };
  var game = app.findFirstRecordByFilter("games", "key = {:key}", { key: batch.game });
  var nowIso = new Date().toISOString();
  app.runInTransaction(function (tx) {
    var setsCol = tx.findCollectionByNameOrId("card_sets");
    var cardsCol = tx.findCollectionByNameOrId("cards");
    var setByCode = {};
    function findSet(code) {
      if (setByCode[code] !== undefined) return setByCode[code];
      try {
        setByCode[code] = tx.findFirstRecordByFilter("card_sets", "game = {:g} && code = {:c}", { g: game.id, c: code });
      } catch (err) {
        setByCode[code] = null;
      }
      return setByCode[code];
    }
    var sets = batch.sets || [];
    for (var i = 0; i < sets.length; i++) {
      var s = sets[i];
      if (!s || !s.code) continue;
      var rec = findSet(s.code);
      var isNew = !rec;
      if (isNew) rec = new Record(setsCol, { game: game.id, code: s.code });
      var ch = isNew;
      if (s.name) ch = put(rec, "name", s.name) || ch;
      if (s.series) ch = put(rec, "series", s.series) || ch;
      if (s.release_date && !rec.getString("release_date")) ch = put(rec, "release_date", s.release_date) || ch;
      if (s.total) ch = put(rec, "total", s.total) || ch;
      if (s.abbr) ch = put(rec, "abbr", s.abbr) || ch;
      if (s.language) ch = put(rec, "language", s.language) || ch;
      var ext = merged(jsonOf(rec, "external_ids"), s.external_ids);
      if (JSON.stringify(ext) !== JSON.stringify(jsonOf(rec, "external_ids") || {})) {
        rec.set("external_ids", ext);
        ch = true;
      }
      if (!rec.getString("name")) rec.set("name", s.code);
      if (ch) {
        tx.save(rec);
        if (isNew) counts.sets_created++;
        else counts.sets_updated++;
      }
      setByCode[s.code] = rec;
    }

    var bySet = {};
    var cards = batch.cards || [];
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      if (!c || !c.set_code || !c.number || !c.name) {
        counts.skipped++;
        continue;
      }
      (bySet[c.set_code] = bySet[c.set_code] || []).push(c);
    }
    for (var code in bySet) {
      var setRec = findSet(code);
      if (!setRec) {
        setRec = new Record(setsCol, { game: game.id, code: code, name: code });
        tx.save(setRec);
        setByCode[code] = setRec;
        counts.sets_created++;
      }
      var existing = {};
      var have = tx.findRecordsByFilter("cards", "set = {:s}", "", 0, 0, { s: setRec.id }) || [];
      for (var h = 0; h < have.length; h++) existing[have[h].getString("number")] = have[h];
      var rows = bySet[code];
      for (var k = 0; k < rows.length; k++) {
        var row = rows[k];
        var card = existing[row.number];
        var created = !card;
        if (created) card = new Record(cardsCol, { game: game.id, set: setRec.id, number: row.number });
        else if (card.getString("source") === "manual") {
          counts.skipped++;
          continue;
        }
        var changed = created;
        changed = put(card, "name", row.name) || changed;
        if (row.name_en) changed = put(card, "name_en", row.name_en) || changed;
        if (row.language) changed = put(card, "language", row.language) || changed;
        if (row.rarity) changed = put(card, "rarity", row.rarity) || changed;
        if (row.variant) changed = put(card, "variant", row.variant) || changed;
        if (row.tcgplayer_id) changed = put(card, "tcgplayer_id", row.tcgplayer_id) || changed;
        if (row.cardmarket_id) changed = put(card, "cardmarket_id", row.cardmarket_id) || changed;
        if (row.finishes && row.finishes.length && !(jsonOf(card, "finishes_available") || []).length) {
          card.set("finishes_available", row.finishes);
          changed = true;
        }
        if (row.image_small && !card.getString("image_file")) changed = put(card, "image_small", row.image_small) || changed;
        if (row.image_large && !card.getString("image_file")) changed = put(card, "image_large", row.image_large) || changed;
        var cext = merged(jsonOf(card, "external_ids"), row.external_ids);
        if (JSON.stringify(cext) !== JSON.stringify(jsonOf(card, "external_ids") || {})) {
          card.set("external_ids", cext);
          changed = true;
        }
        changed = put(card, "search_text", searchText(row, code)) || changed;
        if (!changed) {
          counts.cards_unchanged++;
          continue;
        }
        card.set("source", "api");
        card.set("last_synced", nowIso);
        tx.save(card);
        existing[row.number] = card;
        if (created) counts.cards_created++;
        else counts.cards_updated++;
      }
    }
  });
  return counts;
}

// ---------------------------------------------------------------------
// Live TCGdex helpers (PocketBase only)
// ---------------------------------------------------------------------

function tcgdexGet(path, timeout) {
  try {
    var res = $http.send({ url: TCGDEX + path, method: "GET", timeout: timeout || 8, headers: { "user-agent": "GGVault/1.0 (ggentertainment.co.uk)" } });
    if (res.statusCode !== 200) return null;
    return res.json;
  } catch (err) {
    console.log("[catalogue] tcgdex " + path + " failed: " + err);
    return null;
  }
}

/** The species table kept by the importer for `lang` (adapter_state), or {}. */
function speciesFor(app, lang) {
  if (lang === "en") return {};
  try {
    var store = require(__hooks + "/adapters/statestore.js").forApp(app);
    return store.get("catalogue_species_" + lang) || {};
  } catch (err) {
    return {};
  }
}

module.exports = {
  TCGDEX: TCGDEX,
  TCGDEX_LANGS: TCGDEX_LANGS,
  LANG_TAG: LANG_TAG,
  setCodeFor: setCodeFor,
  isDigitalSet: isDigitalSet,
  splitSuffix: splitSuffix,
  speciesTable: speciesTable,
  englishName: englishName,
  tcgdexSet: tcgdexSet,
  tcgdexCards: tcgdexCards,
  tcgdexDetail: tcgdexDetail,
  scryfallCard: scryfallCard,
  scryfallSet: scryfallSet,
  optcgRows: optcgRows,
  lorcastSet: lorcastSet,
  lorcastCard: lorcastCard,
  searchText: searchText,
  upsertBatch: upsertBatch,
  tcgdexGet: tcgdexGet,
  speciesFor: speciesFor,
};
