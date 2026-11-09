import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon } from "lucide-react"

import { PageTitle } from "@/components/ui/page-title"
import { LoadFailed } from "@/features/portal/LoadFailed"
import {
  bulkAdd,
  createBinder,
  getArtist,
  img,
  listOwnedCardIds,
  type ArtistCard,
} from "@/features/binders/api"
import { buildIdeas, bulbapediaUrl, type BinderIdea } from "@/features/binders/artist"
import { CardDetailSheet, type DetailItem } from "@/features/binders/CardDetail"
import { Pocket } from "@/features/binders/Pocket"
import "@/features/binders/binders.css"

const PAGE = 48
const IDEA_COLORS = ["pop", "cyan", "violet", "lime"] as const

/**
 * One artist: who they are, every card they have drawn (newest first), which
 * ones this customer owns, and one-tap binders built from the data. Facts
 * stop at what the card database says; the Bulbapedia link is where the
 * biography lives.
 */
export function ArtistScreen({ name }: { name: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const artistQ = useQuery({ queryKey: ["portal", "artist", name], queryFn: () => getArtist(name), staleTime: 3600_000 })
  const ownedQ = useQuery({ queryKey: ["portal", "owned-card-ids"], queryFn: listOwnedCardIds, staleTime: 60_000 })
  const [limit, setLimit] = React.useState(PAGE)
  const [inspect, setInspect] = React.useState<number | null>(null)
  const [busy, setBusy] = React.useState("")
  const [error, setError] = React.useState("")

  const artist = artistQ.data
  const owned = React.useMemo(() => ownedQ.data ?? new Set<string>(), [ownedQ.data])
  const ideas = React.useMemo(() => (artist ? buildIdeas(artist) : []), [artist])
  const shown = React.useMemo(() => (artist ? artist.cards.slice(0, limit) : []), [artist, limit])
  const ownedCount = React.useMemo(
    () => (artist ? artist.cards.reduce((n, c) => n + (owned.has(c.card_id) ? 1 : 0), 0) : 0),
    [artist, owned]
  )
  const detailItems = React.useMemo<DetailItem[]>(
    () =>
      shown.map((c) => ({
        id: c.card_id,
        card_id: c.card_id,
        name: c.name,
        number: c.number,
        set_name: c.set_name,
        set_total: c.set_total,
        image: c.image,
        owned: owned.has(c.card_id),
      })),
    [shown, owned]
  )

  const firstSet = artist?.sets.length ? artist.sets[artist.sets.length - 1] : null
  const latestSet = artist?.sets.length ? artist.sets[0] : null

  function refreshShelf() {
    void queryClient.invalidateQueries({ queryKey: ["portal", "binders"] })
    void queryClient.invalidateQueries({ queryKey: ["portal", "binder-pockets"] })
  }

  async function makeFull() {
    if (!artist || busy) return
    setBusy("full")
    setError("")
    try {
      const made = await createBinder({
        kind: "illustrator",
        query: artist.name,
        query_label: artist.name,
        name: artist.name,
        owner: "",
        color: "volt",
        grid: "3x3",
      })
      refreshShelf()
      void navigate({ to: "/account/binders/$id", params: { id: made.id } })
    } catch {
      setError("Could not make the binder. Check your connection and try again.")
      setBusy("")
    }
  }

  async function makeIdea(idea: BinderIdea, i: number) {
    if (busy) return
    setBusy(idea.key)
    setError("")
    try {
      const made = await createBinder({
        kind: "custom",
        query: "",
        query_label: idea.note,
        name: idea.title.slice(0, 120),
        owner: "",
        color: IDEA_COLORS[i % IDEA_COLORS.length],
        grid: "3x3",
      })
      await bulkAdd(made.id, idea.cards)
      refreshShelf()
      void navigate({ to: "/account/binders/$id", params: { id: made.id } })
    } catch {
      setError("Could not make the binder. Check your connection and try again.")
      setBusy("")
    }
  }

  if (artistQ.isError) {
    return (
      <LoadFailed
        title={name}
        error={artistQ.error}
        fallback="This artist did not load. Check your connection and try again."
        onRetry={() => void artistQ.refetch()}
      />
    )
  }

  return (
    <div className="bx-root bx-screen pt-8 sm:pt-14">
      <div className="bx-topbar">
        <Link to="/account/binders" className="bx-back">
          <ArrowLeftIcon aria-hidden="true" className="size-4 stroke-[1.25]" />
          Binders
        </Link>
      </div>

      <p className="bx-kicker mt-4">Artist</p>
      <PageTitle className="bx-title-main">{name}</PageTitle>
      {artist ? (
        <p className="bx-sub">
          {artist.count} cards across {artist.sets.length} sets
          {firstSet && latestSet && firstSet.id !== latestSet.id
            ? `, from ${firstSet.name} to ${latestSet.name}`
            : firstSet
              ? `, all in ${firstSet.name}`
              : ""}
          {ownedCount ? `. You own ${ownedCount} of them.` : ""}
        </p>
      ) : (
        <div className="bx-skel mt-4" style={{ height: 22, width: "70%" }} />
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" className="bx-detail-main bx-artist-make" disabled={!artist || !!busy} onClick={() => void makeFull()}>
          <PlusIcon aria-hidden="true" />
          {busy === "full" ? "Making" : `Make a binder of ${name}`}
        </button>
        <a className="bx-artist-wiki" href={bulbapediaUrl(name)} target="_blank" rel="noopener noreferrer">
          Read more on Bulbapedia
          <ExternalLinkIcon aria-hidden="true" />
        </a>
      </div>
      {error ? (
        <p className="bx-error mt-4 text-[14px]" role="alert">
          {error}
        </p>
      ) : null}

      {ideas.length ? (
        <>
          <h2 className="bx-section mt-10">Binder ideas</h2>
          <div className="bx-ideas">
            {ideas.map((idea, i) => (
              <button
                key={idea.key}
                type="button"
                className="gg-card click bx-idea"
                style={{ "--accent": `var(--${IDEA_COLORS[i % IDEA_COLORS.length]}, #3ee6ff)` } as React.CSSProperties}
                disabled={!!busy}
                onClick={() => void makeIdea(idea, i)}
              >
                <span className="bx-idea-fan" aria-hidden="true">
                  {idea.cards
                    .filter((c) => c.image)
                    .slice(0, 3)
                    .map((c, j) => (
                      <img key={c.card_id} src={img(c.image)} alt="" loading="lazy" style={{ rotate: `${(j - 1) * 7}deg` }} />
                    ))}
                </span>
                <span className="bx-idea-text">
                  <b>{busy === idea.key ? "Making the binder" : idea.title}</b>
                  <small>
                    {idea.note}. {idea.cards.length} cards, one tap.
                  </small>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <h2 className="bx-section mt-10">Every card, newest first</h2>
      <div className="bx-artist-grid">
        {!artist
          ? Array.from({ length: 6 }, (_, i) => <div key={i} className="bx-skel" style={{ aspectRatio: "0.716" }} />)
          : shown.map((c: ArtistCard, i) => (
              <Pocket
                key={c.card_id}
                c={{ id: c.card_id, card_id: c.card_id, name: c.name, number: c.number, set_name: c.set_name, set_total: c.set_total, image: c.image, dex: 0, sprite: "" }}
                owned={owned.has(c.card_id)}
                onInspect={() => setInspect(i)}
                onTap={() => setInspect(i)}
              />
            ))}
      </div>
      {artist && artist.cards.length > limit ? (
        <div className="mt-8 grid justify-center">
          <button type="button" className="bx-chip" onClick={() => setLimit((n) => n + PAGE * 2)}>
            Show more, {artist.cards.length - limit} left
          </button>
        </div>
      ) : null}

      <CardDetailSheet
        open={inspect !== null}
        onOpenChange={(o) => setInspect(o ? inspect : null)}
        items={detailItems}
        index={Math.min(inspect ?? 0, Math.max(0, detailItems.length - 1))}
        onIndex={setInspect}
        canCreate
      />
    </div>
  )
}
