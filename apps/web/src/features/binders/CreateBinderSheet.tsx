import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { motion } from "motion/react"
import { BrushIcon, GaugeIcon, LayoutGridIcon, LibraryIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import { BinderCover } from "@/features/binders/BinderObject"
import { GridSwitch } from "@/features/binders/BinderParts"
import type { Grid } from "@/features/binders/layout"
import {
  artwork,
  COLORS,
  createBinder,
  DEX_SCOPES,
  img,
  listIllustrators,
  listSets,
  listSpecies,
  previewBinder,
  type BinderKind,
  type Preview,
  type SetEntry,
  type Species,
} from "@/features/binders/api"

const TYPES: { id: BinderKind; l: string; d: string; c: string; I: typeof SparklesIcon }[] = [
  { id: "pokemon", l: "A Pokémon", d: "Every English card printed for one Pokémon.", c: "#fedf01", I: SparklesIcon },
  { id: "set", l: "A set", d: "Complete a whole expansion, secret rares included.", c: "#3ee6ff", I: LibraryIcon },
  {
    id: "pokedex",
    l: "A Pokédex",
    d: "One pocket per Pokémon, national or one generation, with a sprite until the card goes in.",
    c: "#ff2e6b",
    I: GaugeIcon,
  },
  { id: "illustrator", l: "An artist", d: "Every card drawn by one illustrator.", c: "#a78bfa", I: BrushIcon },
  { id: "custom", l: "An empty binder", d: "Start empty and add any cards you like, in any pocket.", c: "#ff9a3c", I: LayoutGridIcon },
]

interface Pick {
  query: string
  label: string
  logo?: string
}

type PreviewState = { loading: true } | { error: string } | (Preview & { loading?: false })

export function CreateBinderSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  onCreated: (id: string) => void
}) {
  const [step, setStep] = React.useState(0)
  const [kind, setKind] = React.useState<BinderKind | "">("")
  const [q, setQ] = React.useState("")
  const [pick, setPick] = React.useState<Pick | null>(null)
  const [error, setError] = React.useState("")
  const [name, setName] = React.useState("")
  const [owner, setOwner] = React.useState("")
  const [color, setColor] = React.useState("volt")
  const [grid, setGrid] = React.useState<Grid>("3x3")
  const [busy, setBusy] = React.useState(false)

  const listQuery = useQuery({
    queryKey: ["portal", "binder-catalogue", kind],
    queryFn: async (): Promise<{ species?: Species[]; sets?: SetEntry[]; artists?: string[] }> =>
      kind === "pokemon"
        ? { species: await listSpecies() }
        : kind === "set"
          ? { sets: await listSets() }
          : { artists: await listIllustrators() },
    enabled: kind !== "" && kind !== "custom" && kind !== "pokedex",
    staleTime: 60 * 60_000,
  })
  const species = listQuery.data?.species ?? null
  const sets = listQuery.data?.sets ?? null
  const artists = listQuery.data?.artists ?? null
  const listError = listQuery.isError ? "The card catalogue is not answering. Try again in a minute." : ""

  const previewQuery = useQuery({
    queryKey: ["portal", "binder-preview", kind, pick?.query ?? ""],
    queryFn: () => previewBinder(kind as BinderKind, pick?.query ?? ""),
    enabled: !!pick && kind !== "" && kind !== "custom",
    staleTime: 10 * 60_000,
  })
  const preview: PreviewState | null = !pick || kind === "custom"
    ? null
    : previewQuery.isPending
      ? { loading: true }
      : previewQuery.isError
        ? { error: "Could not count the cards. Try again." }
        : previewQuery.data

  const s = q.trim().toLowerCase()
  const speciesHits = React.useMemo(
    () => (species ?? []).filter((p) => !s || p.label.toLowerCase().includes(s) || String(p.id) === s).slice(0, s ? 60 : 30),
    [species, s]
  )
  const setHits = React.useMemo(
    () =>
      (s ? (sets ?? []).filter((x) => `${x.name} ${x.serie_name} ${x.id}`.toLowerCase().includes(s)) : (sets ?? []))
        .slice()
        .reverse(),
    [sets, s]
  )
  const artistHits = React.useMemo(
    () => (artists ?? []).filter((x) => !s || x.toLowerCase().includes(s)).slice(0, 80),
    [artists, s]
  )
  const dexHits = React.useMemo(
    () => (kind === "pokedex" ? DEX_SCOPES.filter((g) => !s || `${g.label} ${g.id}`.toLowerCase().includes(s)) : []),
    [kind, s]
  )
  const listLoaded =
    kind === "pokedex" ? true : kind === "pokemon" ? !!species : kind === "set" ? !!sets : !!artists

  function choose(p: Pick) {
    setPick(p)
    setName((n) => (n && n !== pick?.label ? n : p.label))
  }

  function chooseType(t: BinderKind) {
    setKind(t)
    setQ("")
    setPick(null)
    if (t === "custom") {
      setName("")
      setStep(2)
    } else setStep(1)
  }

  async function create() {
    if (!kind) return
    setBusy(true)
    setError("")
    try {
      const r = await createBinder({
        kind,
        query: pick?.query ?? "",
        query_label: pick?.label ?? "",
        name: name.trim(),
        owner: owner.trim(),
        color,
        grid,
      })
      onCreated(r.id)
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : ""
      setError(msg || "Could not make the binder. Try again.")
      setBusy(false)
    }
  }

  const count = preview && "count" in preview ? preview.count : null
  const draft = {
    name: name || pick?.label || "New binder",
    owner,
    color,
    kind: kind || "custom",
    logo: kind === "set" ? pick?.logo : "",
    cover: preview && "sample" in preview ? (preview.sample[0]?.image ?? "") : "",
  }
  const title =
    step === 0
      ? "New binder"
      : step === 1
        ? kind === "pokemon"
          ? "Which Pokémon?"
          : kind === "set"
            ? "Which set?"
            : kind === "pokedex"
              ? "Which Pokédex?"
              : "Which artist?"
        : "Name the binder"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          {step === 0 ? (
            <div className="bx-types">
              {TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="bx-type"
                  style={{ "--c": t.c } as React.CSSProperties}
                  onClick={() => chooseType(t.id)}
                >
                  <span className="ic">
                    <t.I size={18} />
                  </span>
                  <span>
                    <b>{t.l}</b>
                    <small>{t.d}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <>
              <input
                className="bx-search"
                autoFocus
                aria-label="Search"
                placeholder={
                  kind === "pokemon"
                    ? "Pikachu"
                    : kind === "set"
                      ? "Base Set, Surging Sparks"
                      : kind === "pokedex"
                        ? "Kanto, generation 3"
                        : "Mitsuhiro Arita"
                }
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {listError ? <p className="mt-3 text-[15px] text-destructive">{listError}</p> : null}
              <div className="bx-pick">
                {!listLoaded && !listError
                  ? [0, 1, 2, 3, 4].map((i) => <div key={i} className="bx-skel" style={{ height: 56 }} />)
                  : null}
                {kind === "pokemon"
                  ? speciesHits.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`bx-opt ${pick?.query === String(p.id) ? "on" : ""}`}
                        onClick={() => choose({ query: String(p.id), label: p.label })}
                      >
                        <img
                          className="sprite"
                          src={artwork(p.id)}
                          alt=""
                          loading="lazy"
                          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                        />
                        <span>
                          <span className="t">{p.label}</span>
                          <br />
                          <span className="s">#{String(p.id).padStart(4, "0")}</span>
                        </span>
                      </button>
                    ))
                  : null}
                {kind === "set"
                  ? setHits.map((x, i) => (
                      <React.Fragment key={x.id}>
                        {!s && (i === 0 || setHits[i - 1].serie !== x.serie) ? (
                          <div className="bx-serie">{x.serie_name}</div>
                        ) : null}
                        <button
                          type="button"
                          className={`bx-opt ${pick?.query === x.id ? "on" : ""}`}
                          onClick={() => choose({ query: x.id, label: x.name, logo: x.logo })}
                        >
                          {x.logo ? (
                            <img
                              className="logo"
                              src={`${x.logo}.webp`}
                              alt=""
                              loading="lazy"
                              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                            />
                          ) : (
                            <span style={{ width: 74 }} />
                          )}
                          <span>
                            <span className="t">{x.name}</span>
                            <br />
                            <span className="s">
                              {x.serie_name}, {x.total} cards
                            </span>
                          </span>
                        </button>
                      </React.Fragment>
                    ))
                  : null}
                {kind === "pokedex"
                  ? dexHits.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        className={`bx-opt ${pick?.query === g.id ? "on" : ""}`}
                        onClick={() => choose({ query: g.id, label: g.label })}
                      >
                        <img
                          className="sprite pixel"
                          src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${g.from}.png`}
                          alt=""
                          loading="lazy"
                          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                        />
                        <span>
                          <span className="t">{g.label}</span>
                          <br />
                          <span className="s">
                            #{String(g.from).padStart(4, "0")} to #{String(g.to).padStart(4, "0")}, {g.to - g.from + 1} pockets
                          </span>
                        </span>
                      </button>
                    ))
                  : null}
                {kind === "illustrator"
                  ? artistHits.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`bx-opt ${pick?.query === n ? "on" : ""}`}
                        onClick={() => choose({ query: n, label: n })}
                      >
                        <span className="t">{n}</span>
                      </button>
                    ))
                  : null}
                {listLoaded && s && !speciesHits.length && !setHits.length && !artistHits.length && !dexHits.length ? (
                  <p className="text-[15px] text-muted-foreground">Nothing matches {q}.</p>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <div className="grid gap-8">
              <div style={{ width: "min(180px, 50vw)", margin: "0 auto" }}>
                <BinderCover binder={draft} stats={null} />
              </div>
              {preview && "sample" in preview && preview.sample.length > 0 ? (
                <div className="bx-fan" aria-hidden="true">
                  {preview.sample.slice(0, 5).map((x, i, a) => (
                    <motion.img
                      key={x.image}
                      src={img(x.image)}
                      alt=""
                      onError={(e) => (e.currentTarget.style.display = "none")}
                      initial={{ opacity: 0, rotate: 0, y: 30 }}
                      animate={{
                        opacity: 1,
                        rotate: (i - (a.length - 1) / 2) * 9,
                        y: Math.abs(i - (a.length - 1) / 2) * 6,
                      }}
                      transition={{ delay: 0.1 + i * 0.06, type: "spring", stiffness: 140, damping: 16 }}
                    />
                  ))}
                </div>
              ) : null}
              <label className="grid gap-1.5">
                <MicroLabel>Binder name</MicroLabel>
                <input
                  className="bx-search"
                  value={name}
                  maxLength={120}
                  placeholder={pick?.label || "Grails"}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="grid gap-1.5">
                <MicroLabel>Who is it for (optional)</MicroLabel>
                <input
                  className="bx-search"
                  value={owner}
                  maxLength={80}
                  placeholder="Layla"
                  onChange={(e) => setOwner(e.target.value)}
                />
              </label>
              <div className="grid gap-2">
                <MicroLabel>Pockets per page</MicroLabel>
                <GridSwitch grid={grid} onChange={setGrid} />
              </div>
              <div className="grid gap-2">
                <MicroLabel>Cover colour</MicroLabel>
                <div className="bx-swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-label={c.l}
                      aria-pressed={color === c.id}
                      className={`bx-swatch ${color === c.id ? "on" : ""}`}
                      style={{ "--c": c.c } as React.CSSProperties}
                      onClick={() => setColor(c.id)}
                    />
                  ))}
                </div>
              </div>
              {error ? <p className="text-[15px] text-destructive">{error}</p> : null}
            </div>
          ) : null}
        </SheetBody>
        <SheetFooter className={SHEET_COLUMN}>
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            {step > 0 ? (
              <Button
                type="button"
                variant="text"
                disabled={busy}
                onClick={() => setStep(kind === "custom" || step === 1 ? 0 : 1)}
              >
                Back
              </Button>
            ) : (
              <span />
            )}
            {step === 1 ? (
              <>
                <span className="text-[13px] text-muted-foreground-2">
                  {pick
                    ? preview && "loading" in preview && preview.loading
                      ? "Counting cards"
                      : count != null
                        ? `${count} cards`
                        : preview && "error" in preview
                          ? preview.error
                          : ""
                    : ""}
                </span>
                <Button type="button" trailingArrow disabled={!pick || !count} onClick={() => setStep(2)}>
                  Next
                </Button>
              </>
            ) : null}
            {step === 2 ? (
              <Button type="button" trailingArrow loading={busy} disabled={busy || !name.trim()} onClick={() => void create()}>
                Make binder
              </Button>
            ) : null}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
