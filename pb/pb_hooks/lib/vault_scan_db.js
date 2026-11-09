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
/**
 * The card's market, fetching a first snapshot through the adapters when it
 * has none yet. The bulk catalogue import brings cards in without prices, so
 * the first scan or search of a card prices it on the spot rather than
 * showing "No data". snapshotCard is stamp limited (20 hours) and never
 * throws, so a slow or failed source just leaves the card unpriced.
 */
function ensurePriced(app, record) {
  var market = marketFor(app, record);
  if (market.chosen) return market;
  try {
    require(__hooks + "/lib/vault_snapshots_db.js").snapshotCard(app, record, {});
  } catch (err) {
    return market;
  }
  return marketFor(app, record);
}

function cardRow(app, record, look, withPrice, fetchMissing) {
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
    name_en: record.getString("name_en"),
    number: record.getString("number"),
    rarity: record.getString("rarity"),
    set_id: set ? set.id : "",
    set_code: set ? set.getString("code") : "",
    set_name: set ? set.getString("name") : "",
    set_abbr: set ? set.getString("abbr") : "",
    set_total: set ? set.getInt("total") || null : null,
    release_date: set ? String(set.getString("release_date") || "").slice(0, 10) : "",
    series: set ? set.getString("series") : "",
    image_small: record.getString("image_small"),
    image_large: record.getString("image_large"),
    finishes: finishes,
    language: record.getString("language") || scan.languageOf(ext, setExt),
    variant: "",
    illustrator: ext.illustrator || "",
    nm_pence: null,
    nm_source: "",
    price_warning: "",
    graded: gradedFor(record),
    held: 0,
  };
  row.variant = scan.variantTag({ name: row.name, set_name: row.set_name, rarity: row.rarity, finishes: finishes });
  if (withPrice) {
    var market = fetchMissing ? ensurePriced(app, record) : marketFor(app, record);
    if (market.chosen) {
      row.nm_pence = market.chosen.gbp_market;
      row.nm_source = market.chosen.source;
      row.price_warning = market.chosen.warning || "";
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
    name_en: row.name_en,
    number: row.number,
    set_code: row.set_code,
    set_abbr: row.set_abbr,
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

/**
 * TCG Pocket set ids on TCGdex ("A1", "A3a", "B1", "P-A"). Digital only, so
 * never a card on the counter, but the English search adapter can still
 * write one through.
 */
function isDigitalSetCode(code) {
  return /^(A\d+[a-z]?|B\d+[a-z]?|P-[AB])$/.test(String(code || ""));
}

/** The forms a printed collector number may be stored in: "099", "99", "TG05". */
function numberForms(cnum) {
  var scan = require(__hooks + "/lib/vault_scan.js");
  var raw = String(cnum).trim();
  var stripped = scan.num(raw);
  var digits = stripped.replace(/^[a-z]+/, "");
  var padded = digits.length && digits.length < 3 ? ("000" + digits).slice(-3) : digits;
  return { a: raw, b: digits, c: padded, d: raw.toUpperCase() };
}

/** LIKE fragments for a name: the whole name, and its longest word cut to 4 letters so a misread ending still finds it. */
function nameTerms(read) {
  var out = [];
  var names = [read.name_en, read.name_printed].filter(Boolean);
  for (var i = 0; i < names.length; i++) {
    var full = String(names[i]).toLowerCase().trim();
    if (full && out.indexOf(full) < 0) out.push(full);
    var words = full.split(/[^0-9a-zÀ-ɏ぀-ヿ一-鿿가-힯]+/).filter(function (w) {
      return w.length >= 4;
    });
    words.sort(function (x, y) {
      return y.length - x.length;
    });
    if (words[0]) {
      var cut = /^[a-z]/.test(words[0]) ? words[0].slice(0, 4) : words[0].slice(0, 2);
      if (out.indexOf(cut) < 0) out.push(cut);
    }
  }
  return out;
}

/** TCGdex's language code for a read's language. */
function tcgdexLang(lang) {
  var l = String(lang || "en").toLowerCase();
  if (l === "zh" || l === "zh-hk") return "zh-tw";
  var known = ["en", "ja", "ko", "zh-tw", "zh-cn", "th", "id", "fr", "de", "it", "es", "pt"];
  return known.indexOf(l) >= 0 ? l : "en";
}

/**
 * The catalogue missed: ask TCGdex live for the card by number and name in
 * the read's language (then English), and save what it finds so the next
 * scan of that card is local. Returns how many cards were written.
 */
function liveTcgdex(app, read) {
  var sync = require(__hooks + "/lib/catalogue_sync.js");
  var cnum = require(__hooks + "/lib/vault_scan.js").readNumber(read);
  if (!cnum) return 0;
  var forms = numberForms(cnum);
  var langs = [tcgdexLang(read.language)];
  if (langs[0] !== "en") langs.push("en");
  var written = 0;
  for (var li = 0; li < langs.length && !written; li++) {
    var lang = langs[li];
    var ids = [];
    if (read.set_code) {
      var direct = sync.tcgdexGet("/" + lang + "/sets/" + encodeURIComponent(read.set_code) + "/" + encodeURIComponent(forms.a), 6);
      if (direct && direct.id) ids.push(direct.id);
    }
    var names = lang === "en" ? [read.name_en, read.name_printed] : [read.name_printed, read.name_en];
    for (var n = 0; n < names.length && !ids.length; n++) {
      if (!names[n]) continue;
      var tries = [forms.a, forms.c, forms.b].filter(function (v, i, arr) {
        return v && arr.indexOf(v) === i;
      });
      for (var t = 0; t < tries.length && !ids.length; t++) {
        var list = sync.tcgdexGet("/" + lang + "/cards?name=" + encodeURIComponent(names[n]) + "&localId=" + encodeURIComponent(tries[t]), 6);
        for (var k = 0; Array.isArray(list) && k < list.length && ids.length < 5; k++) {
        var at = String(list[k].id).lastIndexOf("-");
        if (!isDigitalSetCode(String(list[k].id).slice(0, at))) ids.push(list[k].id);
      }
      }
    }
    var table = sync.speciesFor(app, lang);
    for (var j = 0; j < ids.length; j++) {
      var detail = sync.tcgdexGet("/" + lang + "/cards/" + encodeURIComponent(ids[j]), 6);
      if (!detail || !detail.id || !detail.set) continue;
      var rows = sync.tcgdexDetail(lang, detail, table);
      if (!rows.card) continue;
      try {
        sync.upsertBatch(app, { game: "pokemon", sets: [rows.set], cards: [rows.card] });
        written++;
      } catch (err) {
        console.log("[vault_scan] saving live TCGdex card failed: " + err);
      }
    }
  }
  return written;
}

/**
 * Cards a photo read could be, most specific query first:
 *   1. its number within the read's set (printed total, code or abbreviation)
 *   2. its number with its name
 *   3. its name alone
 *   4. its number alone, only when nothing above found anything
 * Ranking (lib/vault_scan.js rankForRead) decides the order and drops cards
 * whose name does not match. When no card matches both name and number, a
 * Pokemon read asks TCGdex live and saves the result (liveTcgdex).
 */
function identifyPool(app, read, gameKey, opts) {
  var scan = require(__hooks + "/lib/vault_scan.js");
  var seen = {};
  var out = [];
  var setLook = lookups(app);
  function add(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && !seen[rows[i].id]) {
        seen[rows[i].id] = true;
        var set = setLook.set(rows[i].getString("set"));
        if (set && isDigitalSetCode(set.getString("code"))) continue;
        out.push(rows[i]);
      }
    }
  }
  var gameClause = gameKey ? " && game.key = {:game}" : "";
  var cnum = scan.readNumber(read);
  var forms = cnum ? numberForms(cnum) : null;
  var numClause = "(number = {:a} || number = {:b} || number = {:c} || number = {:d})";
  function params(extra) {
    var p = { game: gameKey };
    if (forms) {
      p.a = forms.a;
      p.b = forms.b;
      p.c = forms.c;
      p.d = forms.d;
    }
    for (var k in extra || {}) p[k] = extra[k];
    return p;
  }
  var terms = nameTerms(read);

  if (forms) {
    var setParts = [];
    var sp = {};
    var total = read.set_total ? parseInt(scan.num(read.set_total).replace(/^[a-z]+/, ""), 10) : 0;
    if (total > 0) {
      setParts.push("set.total = {:tot}");
      sp.tot = total;
    }
    var code = scan.setcode(read.set_code);
    if (code) {
      setParts.push("set.code ~ {:sc} || set.abbr = {:sa}");
      sp.sc = String(read.set_code).trim();
      sp.sa = String(read.set_code).trim().toUpperCase();
    }
    if (setParts.length) add(safeFind(app, numClause + " && (" + setParts.join(" || ") + ")" + gameClause, "-set.release_date", 200, params(sp)));
    for (var t = 0; t < terms.length; t++) {
      add(safeFind(app, numClause + " && (search_text ~ {:q} || name_en ~ {:q})" + gameClause, "-set.release_date", 200, params({ q: terms[t] })));
    }
  }
  for (var j = 0; j < terms.length; j++) {
    add(safeFind(app, "(search_text ~ {:q} || name_en ~ {:q})" + gameClause, "-set.release_date", j === 0 ? 150 : 80, params({ q: terms[j] })));
  }
  if (forms && !out.length) add(safeFind(app, numClause + gameClause, "-set.release_date", 300, params()));

  // Nothing local matches both the name and the number: ask TCGdex once.
  var noLive = opts && opts.noLive;
  if (!noLive && forms && (gameKey === "pokemon" || (!gameKey && read.language && read.language !== "en")) && (read.name_en || read.name_printed)) {
    var look = lookups(app);
    var hit = false;
    for (var r = 0; r < out.length && !hit; r++) {
      var why = scan.readScore(read, scoringShape(cardRow(app, out[r], look, false))).why;
      hit = why.indexOf("number") >= 0 && (why.indexOf("name") >= 0 || why.indexOf("name~") >= 0);
    }
    if (!hit && liveTcgdex(app, read) > 0) return identifyPool(app, read, gameKey, { noLive: true });
  }
  return out;
}

module.exports = {
  ensurePriced: ensurePriced,
  lookups: lookups,
  marketFor: marketFor,
  gradedFor: gradedFor,
  cardRow: cardRow,
  scoringShape: scoringShape,
  searchPool: searchPool,
  identifyPool: identifyPool,
  nameTerms: nameTerms,
  isDigitalSetCode: isDigitalSetCode,
  numberForms: numberForms,
  tcgdexLang: tcgdexLang,
  liveTcgdex: liveTcgdex,
};
