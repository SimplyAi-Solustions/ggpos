import type { Artist, ArtistCard } from "@/features/binders/api"

/**
 * The artist page's pure logic: naming, and the ready-made binder ideas
 * built from the artist's printed cards. No network and no AI call; one tap
 * on an idea makes a custom binder from the cards listed here.
 */

/** The Pokémon's name without battle suffixes: "Pikachu ex" -> "Pikachu". */
export function baseSpeciesName(name: string): string {
  let out = String(name || "").trim()
  for (;;) {
    const next = out.replace(
      /\s+(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LEGEND|Prime|Star|δ|LV\.\s?X)$/u,
      ""
    )
    if (next === out) return out
    out = next.trim()
  }
}

export interface BinderIdea {
  key: string
  title: string
  note: string
  cards: ArtistCard[]
}

function groupBy<T>(list: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const t of list) {
    const k = keyOf(t)
    if (!k) continue
    const hit = m.get(k)
    if (hit) hit.push(t)
    else m.set(k, [t])
  }
  return m
}

function biggest<T>(groups: Map<string, T[]>): [string, T[]] | null {
  let best: [string, T[]] | null = null
  for (const [k, v] of groups) if (!best || v.length > best[1].length) best = [k, v]
  return best
}

const MIN_IDEA = 4

/**
 * Three or four ready-made binder suggestions from the data: the Pokémon the
 * artist has drawn most, their biggest set, their biggest era (series), and
 * where they started. An idea is dropped when it is too small to be a binder
 * or when it is just the whole collection again.
 */
export function buildIdeas(artist: Artist): BinderIdea[] {
  const cards = artist.cards
  const ideas: BinderIdea[] = []
  const worthIt = (list: ArtistCard[]) => list.length >= MIN_IDEA && list.length < artist.count

  const species = biggest(groupBy(cards, (c) => baseSpeciesName(c.name)))
  if (species && worthIt(species[1])) {
    ideas.push({
      key: "species",
      title: `${species[0]} by ${artist.name}`,
      note: `Every ${species[0]} this artist has drawn`,
      cards: species[1],
    })
  }

  const set = biggest(groupBy(cards, (c) => c.set_id))
  if (set && worthIt(set[1])) {
    ideas.push({
      key: "set",
      title: `${artist.name} in ${set[1][0].set_name}`,
      note: "Their biggest single set",
      cards: set[1],
    })
  }

  const eras = groupBy(cards, (c) => c.serie)
  const era = biggest(eras)
  if (era && worthIt(era[1]) && eras.size > 1) {
    ideas.push({
      key: "era",
      title: `${artist.name}, ${era[1][0].serie_name} era`,
      note: "Their biggest era, in one binder",
      cards: era[1],
    })
  }

  // Where they started: the oldest series, when it is not already idea 3.
  if (eras.size > 1) {
    let first: ArtistCard[] | null = null
    for (const list of eras.values()) {
      if (!first || list[0].set_order < first[0].set_order) first = list
    }
    if (first && worthIt(first) && (!era || first !== era[1])) {
      ideas.push({
        key: "first",
        title: `Early ${artist.name}`,
        note: `Their first era, ${first[0].serie_name}`,
        cards: first,
      })
    }
  }

  return ideas.slice(0, 4)
}

/** The Bulbapedia page for an artist, for the "Read more" link. */
export function bulbapediaUrl(name: string): string {
  return `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(name.trim().replace(/\s+/g, "_"))}`
}
