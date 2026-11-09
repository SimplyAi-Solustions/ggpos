// Pure helpers for vault_scan.pb.js: the card-reading prompt, parsing the
// model's reply, query parsing, fuzzy scoring for search, ranking catalogue
// candidates against a photo read, and the "every signal agrees" rule.
//
// No PocketBase globals in here (no $app, $http, __hooks), so the same file
// runs under plain Node for the apps/vault tests
// (src/features/scan/identify-ranking.test.ts).
"use strict";

var HAIKU = "claude-haiku-5-5";
var SONNET = "claude-sonnet-5-5";

// Same transcription rules as the 09/11/2026 bake-off prompt
// (~/.buzz/REPOS/cardid-bakeoff/bakeoff.py), widened from Pokemon to the
// four games the vault searches, plus a `game` and `finish` key.
var PROMPT =
  "You are reading a photo of a single trading card: Pokemon, Magic: The Gathering, One Piece or Disney Lorcana. " +
  "The card may be held in a hand, in a sleeve or toploader, and fill only part of the frame; read only the card. " +
  "Transcribe what is printed. Do NOT identify or guess the card from memory: if something is not legible, use null and give it low confidence.\n\n" +
  "Return ONLY a JSON object, no prose, no code fences, with exactly these keys:\n" +
  "{\n" +
  '  "game": "pokemon"|"mtg"|"onepiece"|"lorcana"|null,\n' +
  '  "name_printed": string|null,      // card name exactly as printed, in its own script\n' +
  '  "name_en": string|null,           // English name if you can translate it confidently, else null\n' +
  '  "set_code": string|null,          // printed set code, e.g. "MEW", "SV2a", "PAL", "OP05", "BLB"\n' +
  '  "regulation_mark": string|null,   // single boxed letter such as "G", "H" (Pokemon only)\n' +
  '  "collector_number": string|null,  // number before the slash, as printed, e.g. "201", "025", "TG05", "OP05-119"\n' +
  '  "set_total": string|null,         // number after the slash, e.g. "165"\n' +
  '  "promo_code": string|null,        // for promos, e.g. "SVP 123", "SWSH050"\n' +
  '  "rarity_mark": string|null,       // printed rarity symbol name or letters (C, U, R, RR, AR, SR, SAR, UR, SEC, L)\n' +
  '  "finish": string|null,            // what you can see: "holo", "reverse holo", "foil", "non-foil", or null\n' +
  '  "language": string|null,          // ISO code of the card text: en, ja, zh-tw, zh-cn, ko, th, fr, de, it, es, pt\n' +
  '  "is_promo_stamped": boolean|null, // true if there is a promo, event, prerelease or other stamp\n' +
  '  "confidence": { "game": number, "name_printed": number, "name_en": number, "set_code": number, "collector_number": number, "set_total": number, "language": number }\n' +
  "}";

var READ_KEYS = [
  "game", "name_printed", "name_en", "set_code", "regulation_mark", "collector_number",
  "set_total", "promo_code", "rarity_mark", "finish", "language", "is_promo_stamped",
];

/** The model's reply as an object, tolerating code fences and stray prose. Null when unreadable. */
function parseModelJson(text) {
  if (!text) return null;
  var t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch (err) {
    var m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (err2) {
      return null;
    }
  }
}

/** A cleaned read: every key present, strings trimmed, confidences 0 to 1. */
function cleanRead(raw) {
  var read = {};
  raw = raw && typeof raw === "object" ? raw : {};
  for (var i = 0; i < READ_KEYS.length; i++) {
    var k = READ_KEYS[i];
    var v = raw[k];
    if (k === "is_promo_stamped") read[k] = v === true;
    else read[k] = v === null || v === undefined || v === "" ? null : String(v).trim().slice(0, 80);
  }
  if (read.game) {
    var g = read.game.toLowerCase();
    read.game = /pok/.test(g) ? "pokemon" : /magic|mtg/.test(g) ? "mtg" : /one ?piece/.test(g) ? "onepiece" : /lorcana/.test(g) ? "lorcana" : null;
  }
  if (read.language) read.language = read.language.toLowerCase();
  var conf = raw.confidence && typeof raw.confidence === "object" ? raw.confidence : {};
  read.confidence = {};
  var ck = ["game", "name_printed", "name_en", "set_code", "collector_number", "set_total", "language"];
  for (var j = 0; j < ck.length; j++) {
    var c = Number(conf[ck[j]]);
    read.confidence[ck[j]] = isFinite(c) ? Math.max(0, Math.min(1, c)) : read[ck[j]] ? 0.5 : 0;
  }
  return read;
}

/** Lower case, accents folded, only letters, digits and CJK/kana/hangul kept. */
function norm(s) {
  if (s === null || s === undefined) return "";
  var out = String(s).toLowerCase();
  if (out.normalize) out = out.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return out.replace(/[^0-9a-z぀-ヿ一-鿿가-힯]+/g, "");
}

/** "025" to "25", "TG05" to "tg5", "OP05-119" to "op05119". */
function num(s) {
  var n = norm(s);
  var m = n.match(/^([a-z]*)0*(\d+)([a-z]*)$/);
  return m ? m[1] + m[2] + m[3] : n;
}

/** A printed set code without a trailing language tag ("SVP EN"). */
function setcode(s) {
  return norm(String(s || "").trim().replace(/[\s_-]+(en|jp|ja|kr|ko|cn|zh|tw|th|fr|de|it|es|pt)$/i, ""));
}

/** Levenshtein distance, stopping early once it passes `max`. */
function distance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  var prev = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    var cur = [i];
    var best = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
      cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
      if (cur[k] < best) best = cur[k];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A search box query split into what it means: a collector number with an
 * optional set total ("215/203", "4/102"), a hyphenated card code
 * ("OP05-119"), and the remaining words (name words or a set code).
 */
function parseQuery(q) {
  var out = { number: null, total: null, code: null, words: [] };
  var tokens = String(q || "").trim().split(/\s+/).filter(Boolean);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    var frac = t.match(/^#?([A-Za-z]{0,4}\d+[A-Za-z]?)\/([A-Za-z]{0,3}\d+)$/);
    if (frac) {
      out.number = frac[1];
      out.total = frac[2];
      continue;
    }
    var code = t.match(/^([A-Za-z]{1,4}\d{1,3})-([A-Za-z]{0,2}\d{1,3})$/);
    if (code) {
      out.code = t.toUpperCase();
      continue;
    }
    if (/^#?\d{1,4}[a-z]?$/i.test(t) && (out.words.length > 0 || tokens.length > 1)) {
      out.number = t.replace(/^#/, "");
      continue;
    }
    var w = norm(t);
    if (w) out.words.push(w);
  }
  if (!out.words.length && !out.code && !out.number && tokens.length === 1) {
    var lone = tokens[0].replace(/^#/, "");
    if (/^\d{1,4}[a-z]?$/i.test(lone)) out.number = lone;
  }
  return out;
}

/** The SQL LIKE fragments worth asking the database for: each word's first 3 letters, so a typo later in a word still finds it. */
function likeTerms(parsed) {
  var terms = [];
  for (var i = 0; i < parsed.words.length; i++) {
    var w = parsed.words[i];
    terms.push(w.length > 4 ? w.slice(0, 3) : w);
  }
  return terms;
}

/** One query word against one card word: 1 exact, 0.85 prefix, 0.7 one typo, 0.45 two typos, else 0. */
function wordScore(qw, cw) {
  if (qw === cw) return 1;
  if (qw.length >= 3 && cw.indexOf(qw) === 0) return 0.85;
  var allowed = qw.length >= 8 ? 2 : qw.length >= 4 ? 1 : 0;
  if (allowed === 0) return 0;
  var d = distance(qw, cw, allowed);
  if (d === 1) return 0.7;
  if (d === 2) return 0.45;
  return 0;
}

/**
 * How well a card answers a parsed search, or 0 when it does not. `card` is
 * { name, number, set_code, set_name, set_total }.
 */
function searchScore(parsed, card) {
  var score = 0;
  var cardWords = String(card.name || "").toLowerCase().split(/[^0-9a-zÀ-ɏ぀-ヿ一-鿿가-힯]+/).map(norm).filter(Boolean);
  var setWords = String(card.set_name || "").toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  var code = setcode(card.set_code);

  for (var i = 0; i < parsed.words.length; i++) {
    var qw = parsed.words[i];
    var best = 0;
    for (var j = 0; j < cardWords.length; j++) best = Math.max(best, wordScore(qw, cardWords[j]));
    if (qw === code) best = Math.max(best, 1.2);
    for (var k = 0; k < setWords.length; k++) best = Math.max(best, wordScore(qw, setWords[k]) * 0.6);
    if (best === 0) return 0; // every word has to land somewhere
    score += best * 3;
  }
  if (parsed.number) {
    if (num(card.number) !== num(parsed.number)) return 0;
    score += 3;
    if (parsed.total) {
      if (card.set_total && num(card.set_total) === num(parsed.total)) score += 2;
      else if (card.set_total) score -= 1;
    }
  }
  if (parsed.code) {
    var full = norm(card.set_code) + num(card.number);
    var want = norm(parsed.code.replace(/-/, ""));
    if (full !== want && num(card.number) !== num(parsed.code)) return 0;
    score += 5;
  }
  return score;
}

/**
 * How well a card's name answers the read: 3 for an exact name (printed or
 * English, against the card's own name or its English name), 1.5 for a
 * near one (one contains the other, or a typo or two), else 0.
 */
function nameScore(read, card) {
  var names = [norm(read.name_printed), norm(read.name_en)].filter(Boolean);
  var cnames = [norm(card.name), norm(card.name_en)].filter(Boolean);
  if (!names.length || !cnames.length) return 0;
  for (var i = 0; i < names.length; i++) if (cnames.indexOf(names[i]) >= 0) return 3;
  for (var j = 0; j < names.length; j++) {
    for (var k = 0; k < cnames.length; k++) {
      var a = names[j];
      var b = cnames[k];
      if (Math.min(a.length, b.length) >= 3 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return 1.5;
      var allowed = Math.min(a.length, b.length) >= 10 ? 2 : Math.min(a.length, b.length) >= 5 ? 1 : 0;
      if (allowed && distance(a, b, allowed) <= allowed) return 1.5;
    }
  }
  return 0;
}

/** The collector number a read carries, from the number itself or a promo code. */
function readNumber(read) {
  var cnum = read.collector_number || null;
  if (!cnum && read.promo_code) {
    var m = String(read.promo_code).match(/(\d+)\s*$/);
    cnum = m ? m[1] : null;
  }
  return cnum;
}

/** How well a catalogue card matches what the model read off the photo. */
function readScore(read, card) {
  var score = 0;
  var why = [];
  var ns = nameScore(read, card);
  if (ns >= 3) {
    score += 3;
    why.push("name");
  } else if (ns > 0) {
    score += ns;
    why.push("name~");
  }
  var cnum = readNumber(read);
  if (cnum && num(card.number) === num(cnum)) {
    score += 2;
    why.push("number");
  }
  // The printed total ("099/094") tells sets apart that share a name and
  // a number. Secret rares print a number above it, so it counts on its own.
  if (read.set_total && card.set_total && num(card.set_total) === num(read.set_total)) {
    score += 2;
    why.push("set_total");
  }
  var code = setcode(read.set_code);
  if (code && (code === setcode(card.set_code) || code === setcode(card.set_abbr))) {
    score += 2;
    why.push("set_code");
  }
  // A Japanese read prefers the Japanese print and still offers the English ones.
  var lang = read.language || "en";
  var clang = card.language || "en";
  if (clang === lang) score += 0.75;
  // Another Asian print of the same card (a Chinese one for a Japanese read)
  // shares name, number and total: it must not crowd the read's own language.
  // English prints stay as the equivalent on offer.
  else if (read.language && clang !== "en") score -= 1.5;
  if (read.game && card.game_key && read.game === card.game_key) score += 0.5;
  return { score: score, why: why };
}

/**
 * Candidates ranked best first, each with its score and reasons. Newer sets
 * break ties. A card whose name does not match the read is dropped while
 * any card does match; when none does, the cards are kept and each carries
 * "no_name_match" so the screen and the verdict can say so.
 */
function rankForRead(read, cards) {
  var ranked = [];
  var named = 0;
  var hasName = !!(read.name_printed || read.name_en);
  for (var i = 0; i < cards.length; i++) {
    var r = readScore(read, cards[i]);
    if (!r.why.length) continue;
    if (r.why.indexOf("name") >= 0 || r.why.indexOf("name~") >= 0) named++;
    ranked.push({ card: cards[i], score: r.score, why: r.why });
  }
  if (hasName && named > 0) {
    ranked = ranked.filter(function (e) {
      return e.why.indexOf("name") >= 0 || e.why.indexOf("name~") >= 0;
    });
  } else if (hasName) {
    for (var j = 0; j < ranked.length; j++) ranked[j].why.push("no_name_match");
  }
  ranked.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.card.release_date || "").localeCompare(String(a.card.release_date || ""));
  });
  return ranked;
}

/** True when this read is weak enough that Sonnet should take a second look. */
function needsDeepDive(read) {
  if (!read) return true;
  if (!read.collector_number && !read.promo_code) return true;
  if (read.confidence.collector_number < 0.6) return true;
  if (!read.name_printed && !read.name_en) return true;
  return false;
}

var NON_EN = { ja: "Japanese", ko: "Korean", "zh-tw": "Traditional Chinese", "zh-cn": "Simplified Chinese", zh: "Chinese", th: "Thai", fr: "French", de: "German", it: "Italian", es: "Spanish", pt: "Portuguese" };

/**
 * Auto-accept only when every signal agrees: a collector number read with
 * confidence, a name read with confidence, the top candidate matching name
 * and number and its set (total or code), the language matching the
 * catalogue row, and clear daylight to the second candidate. Returns
 * { accept, reasons } where reasons say why not.
 */
function agreement(read, ranked) {
  var reasons = [];
  var top = ranked[0];
  if (!top) return { accept: false, reasons: ["No catalogue match"] };
  if (!read.collector_number) reasons.push("Collector number not read");
  else if (read.confidence.collector_number < 0.8) reasons.push("Collector number unclear");
  var nameConf = Math.max(read.confidence.name_printed || 0, read.confidence.name_en || 0);
  if (nameConf < 0.8) reasons.push("Name unclear");
  if (top.why.indexOf("no_name_match") >= 0) reasons.push("No card with this name found, check the name");
  else if (top.why.indexOf("name") < 0) reasons.push("Name does not match");
  if (top.why.indexOf("number") < 0) reasons.push("Number does not match");
  if (top.why.indexOf("set_total") < 0 && top.why.indexOf("set_code") < 0) reasons.push("Set not confirmed");
  var lang = read.language || "en";
  var cardLang = top.card.language || "en";
  if (lang !== cardLang) reasons.push((NON_EN[lang] || lang.toUpperCase()) + " print, confirm");
  if (ranked[1] && ranked[1].score > top.score - 2) reasons.push("Close alternatives");
  return { accept: reasons.length === 0, reasons: reasons };
}

/** Variant tag for a row: the most specific thing that tells look-alikes apart. */
function variantTag(card) {
  var name = String(card.name || "");
  var set = String(card.set_name || "");
  var rarity = String(card.rarity || "");
  if (/1st edition/i.test(set) || /1st edition/i.test(name)) return "1st Edition";
  if (/shadowless/i.test(set) || /shadowless/i.test(name)) return "Shadowless";
  if (/reverse/i.test(card.finish || "")) return "Reverse Holo";
  if (/special illustration|SIR/i.test(rarity)) return "Special Illustration";
  if (/illustration rare/i.test(rarity)) return "Illustration Rare";
  if (/hyper|gold|secret/i.test(rarity)) return "Secret Rare";
  if (/rainbow/i.test(rarity)) return "Rainbow Rare";
  if (/ultra/i.test(rarity)) return "Ultra Rare";
  if (/alt|alternate/i.test(rarity)) return "Alt Art";
  if (/enchanted/i.test(rarity)) return "Enchanted";
  if (/holo/i.test(rarity)) return "Holo";
  if (rarity && !/^(common|uncommon|rare)$/i.test(rarity)) return rarity;
  var finishes = card.finishes || [];
  if (finishes.length === 1 && /foil|holo/i.test(finishes[0])) return "Foil";
  return rarity || "";
}

/** Catalogue language of a card: external_ids.language, else the set's, else English. */
function languageOf(externalIds, setExternalIds) {
  var a = externalIds && externalIds.language;
  var b = setExternalIds && setExternalIds.language;
  return String(a || b || "en").toLowerCase();
}

module.exports = {
  HAIKU: HAIKU,
  SONNET: SONNET,
  PROMPT: PROMPT,
  parseModelJson: parseModelJson,
  cleanRead: cleanRead,
  norm: norm,
  num: num,
  setcode: setcode,
  distance: distance,
  parseQuery: parseQuery,
  likeTerms: likeTerms,
  searchScore: searchScore,
  nameScore: nameScore,
  readNumber: readNumber,
  readScore: readScore,
  rankForRead: rankForRead,
  needsDeepDive: needsDeepDive,
  agreement: agreement,
  variantTag: variantTag,
  languageOf: languageOf,
};
