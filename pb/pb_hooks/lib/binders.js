/**
 * Helpers for binders.pb.js, the customer binder builder (ported from GG HQ).
 *
 * Card data comes from TCGdex (free, no key) and species names from PokeAPI.
 * Nothing in here reads or returns a price: customers never see values, so
 * every catalogue answer is reduced to identity fields before it leaves.
 *
 * Each handler runs in its own goja context, so handlers require() this file
 * inside their body and nothing is shared through globals.
 */

const TCG = "https://api.tcgdex.net/v2/en";
const UA = "GG-Vault/1.0 (ggpos.ggentertainment.co.uk)";
const KINDS = ["pokemon", "set", "illustrator", "custom"];
const COLORS = ["volt", "pop", "cyan", "violet", "lime", "orange", "onyx"];

function getJSON(url, timeout) {
  const r = $http.send({
    url: url,
    method: "GET",
    headers: { "User-Agent": UA, Accept: "application/json" },
    timeout: timeout || 25,
  });
  if (r.statusCode !== 200) throw new Error("HTTP " + r.statusCode + " from the card catalogue");
  return r.json;
}

// A small string cache in the app store: survives across requests, not restarts.
function cacheGet(key, maxAgeSec) {
  try {
    const raw = $app.store().get("ggbind:" + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now() - o.at > maxAgeSec * 1000) return null;
    return o.v;
  } catch (err) {
    return null;
  }
}
function cacheSet(key, v) {
  $app.store().set("ggbind:" + key, JSON.stringify({ at: Date.now(), v: v }));
  return v;
}

// Every English set in release order. TCG Pocket is a phone game, so it is left out.
function catalog() {
  const hit = cacheGet("catalog", 12 * 3600);
  if (hit) return hit;
  const series = getJSON(TCG + "/series");
  const out = [];
  let order = 0;
  for (const s of series) {
    if (s.id === "tcgp") continue;
    let det;
    try {
      det = getJSON(TCG + "/series/" + encodeURIComponent(s.id));
    } catch (err) {
      continue;
    }
    for (const st of det.sets || []) {
      order++;
      out.push({
        id: st.id,
        name: st.name,
        serie: s.id,
        serie_name: s.name,
        logo: st.logo || "",
        official: (st.cardCount && st.cardCount.official) || 0,
        total: (st.cardCount && st.cardCount.total) || 0,
        order: order,
      });
    }
  }
  return cacheSet("catalog", out);
}
function setMap() {
  const m = {};
  for (const s of catalog()) m[s.id] = s;
  return m;
}
function setIdOf(cardId) {
  const i = cardId.lastIndexOf("-");
  return i > 0 ? cardId.slice(0, i) : cardId;
}

const NAME_FIX = {
  "nidoran-f": "Nidoran F", "nidoran-m": "Nidoran M", "mr-mime": "Mr. Mime", "mime-jr": "Mime Jr.",
  "mr-rime": "Mr. Rime", farfetchd: "Farfetch'd", sirfetchd: "Sirfetch'd", "ho-oh": "Ho-Oh",
  "porygon-z": "Porygon-Z", "type-null": "Type: Null", flabebe: "Flabebe", "jangmo-o": "Jangmo-o",
  "hakamo-o": "Hakamo-o", "kommo-o": "Kommo-o", "wo-chien": "Wo-Chien", "chien-pao": "Chien-Pao",
  "ting-lu": "Ting-Lu", "chi-yu": "Chi-Yu",
};
function species() {
  const hit = cacheGet("species", 7 * 86400);
  if (hit) return hit;
  const j = getJSON("https://pokeapi.co/api/v2/pokemon-species?limit=2000", 30);
  const out = j.results
    .map((r) => {
      const id = parseInt(r.url.replace(/\/$/, "").split("/").pop(), 10);
      const label =
        NAME_FIX[r.name] ||
        r.name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      return { id: id, slug: r.name, label: label };
    })
    .sort((a, b) => a.id - b.id);
  return cacheSet("species", out);
}

function illustrators() {
  const hit = cacheGet("illustrators", 86400);
  if (hit) return hit;
  const list = getJSON(TCG + "/illustrators").filter(
    (n) => n && n.length < 60 && n.indexOf('"') < 0
  );
  return cacheSet("illustrators", list);
}

// Plain numbers first, then prefixed (TG, GG, SV) numbers.
function numKey(localId) {
  const s = String(localId || "");
  const m = /^(\D*)(\d+)(.*)$/.exec(s);
  if (!m) return "z" + s;
  return (m[1] ? "1" + m[1].toUpperCase() : "0") + ("000000" + m[2]).slice(-6) + m[3];
}
function briefCards(kind, query) {
  if (kind === "pokemon") return getJSON(TCG + "/cards?dexId=eq:" + encodeURIComponent(query));
  if (kind === "illustrator") return getJSON(TCG + "/cards?illustrator=eq:" + encodeURIComponent(query));
  if (kind === "set") return getJSON(TCG + "/sets/" + encodeURIComponent(query)).cards || [];
  return [];
}
function buildSlots(kind, query) {
  const sets = setMap();
  const cards = briefCards(kind, query);
  const out = [];
  for (const c of cards) {
    const sid = setIdOf(c.id);
    const st = sets[sid];
    if (!st) continue;
    out.push({
      card_id: c.id,
      name: c.name,
      number: c.localId || "",
      set_id: sid,
      set_name: st.name,
      set_total: String(st.official || ""),
      image: c.image || "",
      sortKey: (kind === "set" ? "" : ("00000" + st.order).slice(-5)) + numKey(c.localId),
    });
  }
  out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  out.forEach((s, i) => {
    s.sort = i + 1;
  });
  return out;
}

function cardDetail(cardId) {
  const d = getJSON(TCG + "/cards/" + encodeURIComponent(cardId), 20);
  // Identity only. TCGdex sends pricing on this object; it stops here.
  return {
    id: d.id,
    name: d.name || "",
    localId: d.localId || "",
    rarity: d.rarity || "",
    image: d.image || "",
    set_name: (d.set && d.set.name) || "",
  };
}

// The newest card whose scan actually exists (new sets list images before they upload).
function pickCover(slots) {
  const withImg = slots.filter((s) => s.image);
  for (let i = withImg.length - 1, tries = 0; i >= 0 && tries < 8; i--, tries++) {
    try {
      const r = $http.send({ url: withImg[i].image + "/low.webp", method: "HEAD", timeout: 8 });
      if (r.statusCode === 200) return withImg[i].image;
    } catch (err) {
      // Try the next one.
    }
  }
  return "";
}

/** Loads a binder and refuses unless it belongs to the signed-in customer. */
function ownBinder(app, auth, id) {
  let binder;
  try {
    binder = app.findRecordById("binders", id);
  } catch (err) {
    throw new NotFoundError("That binder does not exist.");
  }
  if (!auth || binder.getString("customer") !== auth.id) {
    throw new NotFoundError("That binder does not exist.");
  }
  return binder;
}

module.exports = {
  TCG, KINDS, COLORS, getJSON, catalog, setMap, setIdOf, species, illustrators,
  buildSlots, cardDetail, pickCover, ownBinder,
};
