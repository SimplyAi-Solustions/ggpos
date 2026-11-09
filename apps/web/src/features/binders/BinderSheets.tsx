import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CopyIcon, Link2Icon, Link2OffIcon } from "lucide-react"

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
import { browserShareTarget, shareOrCopy } from "@/features/portal/share"
import {
  addCard,
  COLORS,
  deleteBinder,
  img,
  searchCards,
  shareBinder,
  shareUrl,
  unshareBinder,
  updateBinder,
  type Binder,
  type SearchHit,
} from "@/features/binders/api"

export function AddCardSheet({
  open,
  onOpenChange,
  binder,
  slot,
  onAdded,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  binder: Binder
  /** The empty pocket that was tapped, if any. */
  slot?: number
  onAdded: () => void
}) {
  const [q, setQ] = React.useState("")
  const [term, setTerm] = React.useState("")
  const [adding, setAdding] = React.useState("")
  const [note, setNote] = React.useState("")
  const [target, setTarget] = React.useState(slot)

  // Wait for a pause in typing before asking the catalogue.
  React.useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(timer)
  }, [q])

  const search = useQuery({
    queryKey: ["portal", "binder-search", term],
    queryFn: () => searchCards(term),
    enabled: term.length >= 2,
    staleTime: 60_000,
  })
  const hits = term.length >= 2 ? (search.data ?? []) : []
  const busy = term.length >= 2 && search.isFetching

  async function add(c: SearchHit) {
    setAdding(c.card_id)
    try {
      const r = await addCard(binder.id, c.card_id, target)
      setNote(
        r.existed
          ? `${c.name} is already in this binder.`
          : r.restored
            ? `${c.name} is back in the binder.`
            : `${c.name} added.`
      )
      // The next card goes in the pocket after, so a run of adds fills in order.
      if (target !== undefined && !r.existed) setTarget(r.slot + 1)
      onAdded()
    } catch {
      setNote(`Could not add ${c.name}. Check your connection and try again.`)
    }
    setAdding("")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>Add a card</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          <input
            className="bx-search"
            autoFocus
            aria-label="Card name"
            placeholder="Card name, for example Pikachu"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {note ? (
            <p className="mt-3 text-[15px] text-muted-foreground" role="status">
              {note}
            </p>
          ) : null}
          <div className="bx-hits">
            {busy && !hits.length
              ? [0, 1, 2].map((i) => <div key={i} className="bx-skel" style={{ aspectRatio: "0.716" }} />)
              : null}
            {hits.map((c) => (
              <button key={c.card_id} type="button" className="bx-hit" disabled={!!adding} onClick={() => void add(c)}>
                {c.image ? <img src={img(c.image)} alt="" loading="lazy" /> : <span className="ph" />}
                <b>{c.name}</b>
                <small>{adding === c.card_id ? "Adding" : `${c.set_name}, ${c.number}`}</small>
              </button>
            ))}
          </div>
          {!busy && term.length >= 2 && search.isSuccess && !hits.length ? (
            <p className="mt-3 text-[15px] text-muted-foreground">No cards match {q}. Check the spelling.</p>
          ) : null}
          {search.isError ? (
            <p className="mt-3 text-[15px] text-destructive">The card catalogue is not answering. Try again in a minute.</p>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

export function SettingsSheet({
  open,
  onOpenChange,
  binder,
  onSaved,
  onDeleted,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  binder: Binder
  onSaved: () => void
  onDeleted: () => void
}) {
  const [name, setName] = React.useState(binder.name)
  const [owner, setOwner] = React.useState(binder.owner)
  const [color, setColor] = React.useState(binder.color)
  const [confirm, setConfirm] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  async function save() {
    setBusy(true)
    try {
      await updateBinder(binder.id, { name: name.trim(), owner: owner.trim(), color })
      onSaved()
      onOpenChange(false)
    } catch {
      setError("Could not save the binder. Check your connection and try again.")
    }
    setBusy(false)
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteBinder(binder.id)
      onOpenChange(false)
      onDeleted()
    } catch {
      setError("Could not delete the binder. Check your connection and try again.")
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>Binder settings</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          <div className="grid gap-8">
            <label className="grid gap-1.5">
              <MicroLabel>Name</MicroLabel>
              <input className="bx-search" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="grid gap-1.5">
              <MicroLabel>Who is it for</MicroLabel>
              <input className="bx-search" value={owner} maxLength={80} onChange={(e) => setOwner(e.target.value)} />
            </label>
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
        </SheetBody>
        <SheetFooter className={SHEET_COLUMN}>
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            {!confirm ? (
              <Button type="button" variant="text-destructive" disabled={busy} onClick={() => setConfirm(true)}>
                Delete binder
              </Button>
            ) : (
              <Button type="button" variant="text-destructive" disabled={busy} onClick={() => void remove()}>
                Delete {binder.name} for good
              </Button>
            )}
            <Button type="button" loading={busy} disabled={busy || !name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * The share link. Read only for whoever opens it; it never shows the
 * customer's name, the "who is it for" name, their wanted cards or a value.
 */
export function ShareSheet({
  open,
  onOpenChange,
  binder,
  onChanged,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
  binder: Binder
  onChanged: (token: string) => void
}) {
  const [token, setToken] = React.useState(binder.share_token)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState("")
  const url = token ? shareUrl(token) : ""
  const target = React.useMemo(() => browserShareTarget(), [])

  async function make() {
    setBusy(true)
    setError("")
    try {
      const r = await shareBinder(binder.id)
      setToken(r.token)
      onChanged(r.token)
    } catch {
      setError("Could not make the link. Check your connection and try again.")
    }
    setBusy(false)
  }

  async function stop() {
    setBusy(true)
    setError("")
    try {
      await unshareBinder(binder.id)
      setToken("")
      setNote("Link switched off. Anyone who had it now sees a closed page.")
      onChanged("")
    } catch {
      setError("Could not switch the link off. Check your connection and try again.")
    }
    setBusy(false)
  }

  async function send() {
    const result = await shareOrCopy(
      { title: binder.name, text: `My ${binder.name} binder`, url, copy: url },
      target
    )
    setNote(
      result === "shared"
        ? "Link shared."
        : result === "copied"
          ? "Link copied."
          : result === "cancelled"
            ? ""
            : "Your browser would not copy it. Press and hold the link to copy it."
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="bx-sheet pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className={SHEET_COLUMN}>
          <SheetTitle>Share this binder</SheetTitle>
        </SheetHeader>
        <SheetBody className={SHEET_COLUMN}>
          <div className="grid gap-6">
            <p className="text-[15px] text-muted-foreground">
              Anyone with the link can look through this binder. They cannot change anything, and it never shows your
              name.
            </p>
            {url ? (
              <div className="grid gap-1.5">
                <MicroLabel>Link</MicroLabel>
                <input className="bx-search bx-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              </div>
            ) : null}
            {note ? (
              <p className="text-[15px] text-muted-foreground" role="status">
                {note}
              </p>
            ) : null}
            {error ? <p className="text-[15px] text-destructive">{error}</p> : null}
          </div>
        </SheetBody>
        <SheetFooter className={SHEET_COLUMN}>
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            {url ? (
              <>
                <Button type="button" variant="text-destructive" disabled={busy} onClick={() => void stop()}>
                  <Link2OffIcon aria-hidden="true" />
                  Switch link off
                </Button>
                <Button type="button" disabled={busy} onClick={() => void send()}>
                  {target.share ? <Link2Icon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                  {target.share ? "Share link" : "Copy link"}
                </Button>
              </>
            ) : (
              <>
                <span />
                <Button type="button" loading={busy} disabled={busy} onClick={() => void make()}>
                  Make share link
                </Button>
              </>
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
