import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import { MoonIcon, PlusIcon, SunIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { BinderCover, OpeningStage } from "@/features/binders/BinderObject"
import { CreateBinderSheet } from "@/features/binders/CreateBinderSheet"
import {
  getBinder,
  KINDS,
  listAllPockets,
  listBinders,
  listPockets,
  statsFor,
  type Binder,
  type BinderCard,
  type BinderStats,
} from "@/features/binders/api"
import { useBinderTheme } from "@/features/binders/theme"
import "@/features/binders/binders.css"

/**
 * The binder shelf: every binder this customer is building, as the physical
 * binders the GG HQ builder draws, with how far through each one they are.
 * No values anywhere, by design.
 */
export function ShelfScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [theme, toggleTheme] = useBinderTheme()
  const [creating, setCreating] = React.useState(false)
  // Bumped on every open, so the create sheet always starts at step one.
  const [run, setRun] = React.useState(0)
  const startNew = () => {
    setRun((n) => n + 1)
    setCreating(true)
  }
  const [stage, setStage] = React.useState<{
    binder: Binder
    stats: BinderStats
    preview: Pick<BinderCard, "image" | "owned">[]
  } | null>(null)

  const binders = useQuery({ queryKey: ["portal", "binders"], queryFn: listBinders })
  const pockets = useQuery({ queryKey: ["portal", "binder-pockets"], queryFn: listAllPockets })

  const statsById = React.useMemo(() => {
    const by: Record<string, Pick<BinderCard, "owned" | "image" | "slot">[]> = {}
    for (const p of pockets.data ?? []) (by[p.binder] ??= []).push(p)
    const out: Record<string, BinderStats> = {}
    for (const id in by) out[id] = statsFor(by[id])
    return out
  }, [pockets.data])

  function open(b: Binder) {
    void navigate({ to: "/account/binders/$id", params: { id: b.id } })
  }

  async function onCreated(id: string) {
    setCreating(false)
    void queryClient.invalidateQueries({ queryKey: ["portal", "binders"] })
    void queryClient.invalidateQueries({ queryKey: ["portal", "binder-pockets"] })
    try {
      const [b, cards] = await Promise.all([getBinder(id), listPockets(id)])
      setStage({ binder: b, stats: statsFor(cards), preview: cards.slice(0, 9).map((c) => ({ image: c.image || c.sprite, owned: c.owned })) })
    } catch {
      void navigate({ to: "/account/binders/$id", params: { id } })
    }
  }

  const list = binders.data ?? []

  if (binders.isError) {
    return (
      <LoadFailed
        title="Binders"
        error={binders.error}
        fallback="Your binders did not load. Check your connection and try again."
        onRetry={() => void binders.refetch()}
      />
    )
  }

  return (
    <div className="bx-root bx-screen pt-16 sm:pt-24">
      <div className="bx-topbar">
        <span className="flex-1" />
        <button type="button" className="bx-icon" onClick={toggleTheme} aria-label={theme === "dark" ? "Light pages" : "Dark pages"}>
          {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
        </button>
      </div>
      <PageTitle>Binders</PageTitle>
      <Lede>
        Build a binder for a set, a Pokédex, a Pokémon or an artist. Tick cards off as you collect them, and tell the
        shop which ones you want.
      </Lede>

      <div className="mt-10">
        <Button type="button" onClick={startNew}>
          <PlusIcon aria-hidden="true" />
          New binder
        </Button>
      </div>

      <div className="bx-shelf mt-12">
          {binders.isPending
            ? [0, 1].map((i) => <div key={i} className="bx-skel" style={{ aspectRatio: "100/122" }} />)
            : list.map((b, i) => {
                const st = statsById[b.id] ?? { total: 0, got: 0, cover: "" }
                return (
                  <motion.div
                    key={b.id}
                    className="bx-shelf-item"
                    initial={{ opacity: 0, y: 30, rotateX: 20 }}
                    animate={{ opacity: 1, y: 0, rotateX: 0 }}
                    transition={{ type: "spring", stiffness: 110, damping: 16, delay: 0.08 + i * 0.07 }}
                  >
                    <BinderCover binder={b} stats={st} onOpen={() => open(b)} />
                    <div className="bx-shelf-cap">
                      <b>{b.name}</b>
                      <small>
                        {KINDS[b.kind]}
                        {b.query_label && b.query_label !== b.name ? `, ${b.query_label}` : ""}
                      </small>
                    </div>
                  </motion.div>
                )
              })}
          {!binders.isPending ? (
            <div className="bx-shelf-item">
              <button type="button" className="bx-new" onClick={startNew}>
                <span className="bx-plus">
                  <PlusIcon size={22} />
                </span>
                <b>New binder</b>
                <small>A set, a Pokédex, a Pokémon, an artist, or empty</small>
              </button>
            </div>
          ) : null}
      </div>

      <CreateBinderSheet key={run} open={creating} onOpenChange={setCreating} onCreated={(id) => void onCreated(id)} />
      <AnimatePresence>
        {stage ? (
          <OpeningStage
            key={stage.binder.id}
            binder={stage.binder}
            stats={stage.stats}
            preview={stage.preview}
            onDone={() => {
              const id = stage.binder.id
              setStage(null)
              void navigate({ to: "/account/binders/$id", params: { id } })
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  )
}
