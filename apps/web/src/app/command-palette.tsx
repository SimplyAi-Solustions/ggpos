import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Command } from "cmdk"
import { SearchIcon } from "lucide-react"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { MicroLabel } from "@/components/ui/micro-label"
import { ProductImage } from "@/components/product-image"
import { useTheme } from "@/components/theme-provider"
import { logout, useStaff } from "@/lib/auth"
import { searchCards, type CardHit } from "@/lib/api"

type PaletteAction = {
  id: string
  label: string
  hint?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The shortcut overlay, for anybody who reached for the mouse instead. */
  onShowShortcuts: () => void
}

/** Nothing is priced until Phase 2 joins the price snapshots. */
function MarketPlaceholder() {
  return (
    <span className="tnum font-mono text-[13px] text-muted-foreground-2">
      <span aria-hidden="true">-</span>
      <span className="sr-only">Not priced yet</span>
    </span>
  )
}

function CardRow({ card }: { card: CardHit }) {
  return (
    <>
      <ProductImage
        src={card.image}
        alt=""
        platform="tcg_card"
        height={40}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-foreground">{card.name}</span>
        <span className="block truncate text-[13px] text-muted-foreground-2">
          {card.setName} &middot; {card.number}
        </span>
      </span>
      <MarketPlaceholder />
    </>
  )
}

/**
 * One box for every action on the counter and for the card catalogue.
 * cmdk owns the keyboard; the paper panel and the hairlines are ours.
 * Filtering is done here rather than by cmdk so that catalogue hits, which
 * arrive already matched by the server, are never filtered a second time.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: CommandPaletteProps) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const [query, setQuery] = React.useState("")
  const admin = useStaff()?.role === "admin"

  // Reset on the way out rather than in an effect, so the query never lags a
  // frame behind the panel it belongs to.
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next) setQuery("")
      onOpenChange(next)
    },
    [onOpenChange]
  )

  const close = React.useCallback(() => setOpen(false), [setOpen])

  const go = React.useCallback(
    (to: string) => {
      close()
      void navigate({ to })
    },
    [close, navigate]
  )

  const actions = React.useMemo<PaletteAction[]>(
    () => [
      { id: "scan", label: "Scan", hint: "S", run: () => go("/counter/scan") },
      { id: "add", label: "Add stock", hint: "N", run: () => go("/counter/stock/new") },
      { id: "buyin", label: "New buy-in", hint: "B", run: () => go("/counter/trade") },
      // --- Selling and cash ---
      { id: "sell", label: "Sell", run: () => go("/counter/sell") },
      { id: "cash", label: "Cash session", run: () => go("/counter/cash") },
      { id: "labels", label: "Label queue", run: () => go("/counter/labels") },
      // --- end Selling and cash ---
      { id: "stock", label: "Stock", run: () => go("/counter/stock") },
      { id: "customers", label: "Customers", run: () => go("/counter/customers") },
      { id: "reports", label: "Reports", run: () => go("/counter/reports") },
      {
        id: "exports",
        label: "Exports and imports",
        run: () => go("/counter/exports"),
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        hint: "?",
        run: () => {
          close()
          onShowShortcuts()
        },
      },
      {
        id: "night",
        label: "Toggle night mode",
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark")
          close()
        },
      },
      {
        id: "signout",
        label: "Sign out",
        run: () => {
          close()
          logout()
          void navigate({ to: "/login" })
        },
      },
    ],
    [close, go, navigate, onShowShortcuts, setTheme, theme]
  )

  // --- Customers and trade ---
  const customerActions = React.useMemo<PaletteAction[]>(
    () => [
      { id: "new-buyin", label: "New buy-in", run: () => go("/counter/trade/new") },
      { id: "recent-buyins", label: "Recent buy-ins", run: () => go("/counter/trade") },
      // --- Quotes (Phase 5) ---
      { id: "quotes", label: "Quotes", run: () => go("/counter/quotes") },
      // --- end Quotes ---
      { id: "find-customer", label: "Find a customer", run: () => go("/counter/customers") },
      { id: "new-customer", label: "New customer", run: () => go("/counter/customers/new") },
    ],
    [go]
  )
  // --- end Customers and trade ---

  // --- Stock counts and settings ---
  // Settings is an admin screen and says so to anybody else, so the palette
  // does not offer it to a staff member in the first place. Counts are for
  // everybody: staff run them, an admin closes them.
  const countActions = React.useMemo<PaletteAction[]>(
    () => [
      { id: "stock-count", label: "Stock count", run: () => go("/counter/stock/count") },
      ...(admin
        ? [
            { id: "loyalty", label: "Loyalty", run: () => go("/counter/loyalty") },
            { id: "settings", label: "Settings", run: () => go("/counter/settings") },
          ]
        : []),
    ],
    [admin, go]
  )
  // --- end Stock counts and settings ---

  const needle = query.trim().toLowerCase()
  const visibleActions = needle
    ? actions.filter((action) => action.label.toLowerCase().includes(needle))
    : actions
  const visibleCustomerActions = needle
    ? customerActions.filter((action) => action.label.toLowerCase().includes(needle))
    : customerActions
  const visibleCountActions = needle
    ? countActions.filter((action) => action.label.toLowerCase().includes(needle))
    : countActions

  const deferred = React.useDeferredValue(query)
  const { data: cards = [], isFetching } = useQuery({
    queryKey: ["palette-cards", deferred],
    queryFn: () => searchCards(deferred, { limit: 6 }),
    enabled: open && deferred.trim().length >= 2,
    staleTime: 30_000,
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] max-h-[76svh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Commands and catalogue search</DialogTitle>
        <Command
          label="Commands and catalogue search"
          shouldFilter={false}
          loop
          className="flex min-h-0 flex-col"
        >
          <div className="flex items-center gap-3 border-b border-hairline-soft px-5 py-4">
            <SearchIcon
              aria-hidden="true"
              className="size-5 shrink-0 stroke-[1.25] text-foreground"
            />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Type a command or search the catalogue"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-base leading-[1.5] text-foreground caret-foreground outline-none placeholder:text-muted-foreground-2"
            />
            <Kbd>Esc</Kbd>
          </div>

          <Command.List className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <Command.Empty className="px-3 py-8 text-[15px] text-muted-foreground">
              {isFetching
                ? "Searching the catalogue."
                : "Nothing matches that. Try a card name, a set code or a number."}
            </Command.Empty>

            {visibleActions.length > 0 ? (
              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
              >
                {visibleActions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={action.id}
                    onSelect={action.run}
                    className="flex cursor-default items-center justify-between gap-4 rounded-[var(--radius)] px-3 py-2.5 text-[15px] text-foreground select-none data-[selected=true]:bg-secondary"
                  >
                    <span>{action.label}</span>
                    {action.hint ? <Kbd>{action.hint}</Kbd> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}

            {/* --- Customers and trade --- */}
            {visibleCustomerActions.length > 0 ? (
              <Command.Group
                heading="Customers and trade"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
              >
                {visibleCustomerActions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={action.id}
                    onSelect={action.run}
                    className="flex cursor-default items-center justify-between gap-4 rounded-[var(--radius)] px-3 py-2.5 text-[15px] text-foreground select-none data-[selected=true]:bg-secondary"
                  >
                    <span>{action.label}</span>
                    {action.hint ? <Kbd>{action.hint}</Kbd> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {/* --- end Customers and trade --- */}

            {/* --- Stock counts and settings --- */}
            {visibleCountActions.length > 0 ? (
              <Command.Group
                heading={admin ? "Counts and settings" : "Counts"}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
              >
                {visibleCountActions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={action.id}
                    onSelect={action.run}
                    className="flex cursor-default items-center justify-between gap-4 rounded-[var(--radius)] px-3 py-2.5 text-[15px] text-foreground select-none data-[selected=true]:bg-secondary"
                  >
                    <span>{action.label}</span>
                    {action.hint ? <Kbd>{action.hint}</Kbd> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {/* --- end Stock counts and settings --- */}

            {cards.length > 0 ? (
              <Command.Group
                heading="Catalogue"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
              >
                {cards.map((card) => (
                  <Command.Item
                    key={card.id}
                    value={card.id}
                    onSelect={() => {
                      close()
                      void navigate({
                        to: "/counter/stock/new",
                        search: { set: card.setCode, number: card.number },
                      })
                    }}
                    className="flex cursor-default items-center gap-4 rounded-[var(--radius)] px-3 py-2 select-none data-[selected=true]:bg-secondary"
                  >
                    <CardRow card={card} />
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>

          <div className="flex items-center justify-between gap-4 border-t border-hairline-soft px-5 py-3">
            <MicroLabel tone="hint">Enter to choose</MicroLabel>
            <MicroLabel tone="hint">Arrows to move</MicroLabel>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
