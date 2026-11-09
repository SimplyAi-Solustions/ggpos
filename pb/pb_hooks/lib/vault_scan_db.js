// Database helpers for vault_scan.pb.js: shaping a `cards` record into the
// row the vault's Scan and Cards screens read, its NM market price (through
// the same pricing policy the price routes use, UK first), and the candidate
// pools for search and photo identification. Required inside each handler
// body, like every other pb_hooks module.
"use strict";

function util() {
  return require(__hooks + "/lib/vaultutil.js");
}

/** A small per-request cache of card_sets and games rows. */
function lookups(app) {
  var sets = {};
  var games = {};
  return {
    set: function (id) {
      if (!id) return null;
      if (sets[id] === undefined) {
        try {
          sets[id] = app.findRecordById("card_sets", id);
        } catch (err) {
          sets[id] = null;
        }
      }
      return sets[id];
    },
    game: function (id) {
      if (!id) return null;
      if (games[id] === undefined) {
        try {
          games[id] = app.findRecordById("games", id);
        } catch (err) {
          games[id] = null;
        }
      }
      return games[id];
    },
  };
}

/** The NM market for one card: the chosen row for the first finish that has any snapshot. */
function marketFor(app, record) {
  var policy = require(__hooks + "/adapters/pricing_policy.js");
  var finishes = [""].concat(util().jsonField(record, "finishes_available", []) || []);
  var settingsRow = util().settings(app);
  var priority = policy.tcgPriority(settingsRow);
  var now = new Date();
  for (var i = 0; i < finishes.length; i++) {
    var candidates = policy.snapshotsFor(app, "card", record.id, finishes[i]);
    if (!candidates.length) continue;
    var result = policy.choose(candidates, priority, now);
    if (result.chosen) return { finish: finishes[i], chosen: result.chosen, sources: result.sources };
  }
  return { finish: finishes[1] || "", chosen: null, sources: [] };
}

/** Graded prices kept on cards.prices.graded ({ "PSA 10": pence }), when a source supplies them. */
function gradedFor(record) {
  var prices = util().jsonField(record, "prices", {}) || {};
  var graded = prices.graded;
  var rows = [];
  if (!graded || typeof graded !== "object") return rows;
  for (var label in graded) {
    var value = graded[label];
    var pence = typeof value === "number" ? value : value && typeof value.gbp_market === "number" ? value.gbp_market : null;
    if (pence === null || !isFinite(pence) || pence <= 0) continue;
    var m = String(label).match(/^\s*([A-Za-z]+)\s+(.+)$/);
    rows.push({ grader: m ? m[1].toUpperCase() : String(label), grade: m ? m[2] : "", pence: Math.round(pence) });
  }
  rows.sort(function (a, b) {
    return b.pence - a.pence;
  });
  return rows;
}

/** The row every vault card list reads. `withPrice` adds the NM market and the "already hold" count (a few reads per card). */
function cardRow(app, record, look, withPrice) {
  var scan = require(__hooks + "/lib/vault_scan.js");
  var u = util();
  var set = look.set(record.getString("set"));
  var game = look.game(record.getString("game"));
  var ext = u.jsonField(record, "external_ids", {}) || {};
  var setExt = set ? u.jsonField(set, "external_ids", {}) || {} : {};
  var finishes = u.jsonField(record, "finishes_available", []) || [];
  var row = {
    id: record.id,
    game: game ? game.getString("key") : "",
    game_id: game ? game.id : "",
    game_name: game ? game.getString("name") : "",
    name: record.getString("name"),
    number: record.getString("number"),
    rarity: record.getString("rarity"),
    set_id: set ? set.id : "",
    set_code: set ? set.getString("code") : "",
    set_name: set ? set.getString("name") : "",
    set_total: set ? set.getInt("total") || null : null,
    release_date: set ? String(set.getString("release_date") || "").slice(0, 10) : "",
    series: set ? set.getString("series") : "",
    image_small: record.getString("image_small"),
    image_large: record.getString("image_large"),
    finishes: finishes,
    language: scan.languageOf(ext, setExt),
    variant: "",
    illustrator: ext.illustrator || "",
    nm_pence: null,
    nm_source: "",
    graded: gradedFor(record),
    held: 0,
  };
  row.variant = scan.variantTag({ name: row.name, set_name: row.set_name, rarity: row.rarity, finishes: finishes });
  if (withPrice) {
    var market = marketFor(app, record);
    if (market.chosen) {
      row.nm_pence = market.chosen.gbp_market;
      row.nm_source = market.chosen.source;
    }
    row.held = require(__hooks + "/lib/vault_snapshots_db.js").heldCount(app, record.id);
  }
  return row;
}

/** Plain objects for the pure scorers in lib/vault_scan.js. */
function scoringShape(row) {
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    set_code: row.set_code,
    set_name: row.set_name,
    set_total: row.set_total,
    release_date: row.release_date,
    game_key: row.game,
    language: row.language,
  };
}

function safeFind(app, filter, sort, limit, params) {
  try {
    return app.findRecordsByFilter("cards", filter, sort, limit, 0, params) || [];
  } catch (err) {
    console.log("[vault_scan] card query failed: " + err);
    return [];
  }
}

/** Cards a search query could mean, before scoring. Every word must appear (by its first letters) in the name, code or set. */
function searchPool(app, parsed, gameKey) {
  var scan = require(__hooks + "/lib/vault_scan.js");
  var clauses = [];
  var params = {};
  var terms = scan.likeTerms(parsed);
  for (var i = 0; i < terms.length; i++) {
    params["t" + i] = terms[i];
    clauses.push("(search_text ~ {:t" + i + "} || set.name ~ {:t" + i + "} || set.code ~ {:t" + i + "})");
  }
  if (parsed.number) {
    params.n = scan.num(parsed.number).replace(/^[a-z]+/, "") || parsed.number;
    clauses.push("number ~ {:n}");
  }
  if (parsed.code) {
    params.code = parsed.code.toLowerCase();
    clauses.push("(search_text ~ {:code} || number ~ {:code})");
  }
  if (!clauses.length) return [];
  if (gameKey) {
    params.game = gameKey;
    clauses.push("game.key = {:game}");
  }
  return safeFind(app, clauses.join(" && "), "-set.release_date", 400, params);
}

/** Cards a photo read could be: by collector number, and by name. */
function identifyPool(app, read, gameKey) {
  var scan = require(__hooks + "/lib/vault_scan.js");
  var seen = {};
  var out = [];
  function add(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && !seen[rows[i].id]) {
        seen[rows[i].id] = true;
        out.push(rows[i]);
      }
    }
  }
  var gameClause = gameKey ? " && game.key = {:game}" : "";
  var cnum = read.collector_number;
  if (!cnum && read.promo_code) {
    var m = String(read.promo_code).match(/(\d+)\s*$/);
    cnum = m ? m[1] : null;
  }
  if (cnum) {
    var raw = String(cnum).trim();
    var stripped = scan.num(raw);
    var digits = stripped.replace(/^[a-z]+/, "");
    var padded = digits.length && digits.length < 3 ? ("000" + digits).slice(-3) : digits;
    add(safeFind(app, "(number = {:a} || number = {:b} || number = {:c} || number = {:d})" + gameClause, "-set.release_date", 300, {
      a: raw,
      b: digits,
      c: padded,
      d: raw.toUpperCase(),
      game: gameKey,
    }));
  }
  var names = [read.name_en, read.name_printed].filter(Boolean);
  for (var j = 0; j < names.length; j++) {
    add(safeFind(app, "search_text ~ {:q}" + gameClause, "-set.release_date", 120, { q: String(names[j]).toLowerCase(), game: gameKey }));
  }
  return out;
}

module.exports = {
  lookups: lookups,
  marketFor: marketFor,
  gradedFor: gradedFor,
  cardRow: cardRow,
  scoringShape: scoringShape,
  searchPool: searchPool,
  identifyPool: identifyPool,
};
