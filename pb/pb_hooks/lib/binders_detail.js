/**
 * Card detail and artist gallery mapping for the customer magnifier
 * (binders.pb.js). Everything here is a whitelist: a TCGdex card object
 * carries cardmarket and tcgplayer pricing, and none of it may reach a
 * customer, so fields are copied by name and never spread. Tested by
 * pb/scripts/binders_detail.test.cjs.
 */

/** One attack or ability, text only. */
function moveOut(m) {
  if (!m) return null;
  return {
    type: m.type ? String(m.type) : "",
    // "energy", not "cost": the price-stripping regex eats any key with
    // "cost" in it, and an attack's energy cost is not a price.
    energy: Array.isArray(m.cost) ? m.cost.map(String) : [],
    name: m.name ? String(m.name) : "",
    effect: m.effect ? String(m.effect) : "",
    damage: m.damage === undefined || m.damage === null ? "" : String(m.damage),
  };
}

/**
 * The magnifier's card detail: identity and gameplay, no price of any kind.
 * `raw` is the TCGdex card object; `set` is the matching entry from the
 * cached catalogue (lib/binders.js catalog()), may be null; `releaseDate`
 * comes from the cached set detail, may be "".
 */
function cardDetailOut(raw, set, releaseDate) {
  const d = raw || {};
  const s = d.set || {};
  return {
    card_id: String(d.id || ""),
    name: String(d.name || ""),
    number: String(d.localId || ""),
    image: String(d.image || ""),
    rarity: String(d.rarity || ""),
    illustrator: String(d.illustrator || ""),
    category: String(d.category || ""),
    hp: d.hp === undefined || d.hp === null ? "" : String(d.hp),
    types: Array.isArray(d.types) ? d.types.map(String) : [],
    stage: String(d.stage || ""),
    evolve_from: String(d.evolveFrom || ""),
    description: String(d.description || ""),
    dex: Array.isArray(d.dexId) && d.dexId.length ? Number(d.dexId[0]) || 0 : 0,
    attacks: (Array.isArray(d.attacks) ? d.attacks : []).map(moveOut).filter(Boolean),
    abilities: (Array.isArray(d.abilities) ? d.abilities : []).map(moveOut).filter(Boolean),
    set: {
      id: String((set && set.id) || s.id || ""),
      name: String((set && set.name) || s.name || ""),
      logo: String((set && set.logo) || s.logo || ""),
      total: String((set && set.official) || (s.cardCount && s.cardCount.official) || ""),
      release_date: String(releaseDate || ""),
    },
  };
}

/**
 * An artist's printed cards, from the TCGdex illustrator listing joined with
 * the cached set catalogue. Newest set first, then card number. Returns only
 * identity fields; the client builds the gallery and the binder ideas from
 * these.
 */
function artistOut(name, briefCards, setMap) {
  const cards = [];
  for (const c of Array.isArray(briefCards) ? briefCards : []) {
    const id = String(c.id || "");
    const dash = id.lastIndexOf("-");
    const sid = dash > 0 ? id.slice(0, dash) : id;
    const st = setMap[sid];
    if (!st) continue;
    cards.push({
      card_id: id,
      name: String(c.name || ""),
      number: String(c.localId || ""),
      set_id: sid,
      set_name: String(st.name || ""),
      set_total: String(st.official || ""),
      serie: String(st.serie || ""),
      serie_name: String(st.serie_name || ""),
      set_order: Number(st.order) || 0,
      image: String(c.image || ""),
    });
  }
  cards.sort((a, b) => b.set_order - a.set_order || (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  const seen = {};
  const sets = [];
  for (const c of cards) {
    if (seen[c.set_id]) {
      seen[c.set_id].count++;
      continue;
    }
    const entry = { id: c.set_id, name: c.set_name, serie: c.serie, serie_name: c.serie_name, order: c.set_order, count: 1 };
    seen[c.set_id] = entry;
    sets.push(entry);
  }
  return { name: String(name || ""), count: cards.length, cards: cards, sets: sets };
}

/** True when a card id looks like a TCGdex id and is safe in a URL path. */
function validCardId(id) {
  return typeof id === "string" && id.length >= 3 && id.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9.\-_]*$/.test(id);
}

module.exports = { cardDetailOut, artistOut, validCardId, moveOut };
