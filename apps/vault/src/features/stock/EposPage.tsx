import * as React from "react"
import { Link } from "@tanstack/react-router"
import { CircleCheck, Save } from "lucide-react"

import { useStaff } from "@/lib/auth"
import { Badge, Button, EmptyState, Money, PageHeader, Panel, Skeleton, useToast } from "@/ui"

import {
  errorText,
  resolveEposCheck,
  saveEposSettings,
  useEposSettings,
  useStockMutation,
  type EposCategoryMap,
  type EposCheck,
  type EposSettingsView,
} from "./api"
import { SelectField } from "./components/SelectField"
import { StockNav } from "./components/StockNav"
import { KIND_LABEL } from "./lib/item-view"

const TAX_GROUPS = [
  { value: "26457", label: "NoTax (not VAT registered)" },
  { value: "26456", label: "20VAT" },
]

function whenText(iso: string | null | undefined): string {
  if (!iso) return "never"
  const d = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return "never"
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** Stock, Epos Now: where Vault items land in Epos Now, and anything the sync left for a person. */
export function EposPage() {
  const staff = useStaff()
  const allowed = staff?.role === "admin" || staff?.role === "manager"
  const view = useEposSettings(allowed)

  return (
    <section>
      <PageHeader eyebrow="Inventory" title="Epos Now">
        Vault stock goes on the Epos Now till as its own products, and till sales come back here.
      </PageHeader>
      <StockNav />
      {!allowed ? (
        <EmptyState title="Admins and managers only">Ask an admin to change the Epos Now settings.</EmptyState>
      ) : view.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : view.isError ? (
        <EmptyState title="Epos Now settings did not load">{errorText(view.error, "Check the connection and try again.")}</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Checks checks={view.data.checks} canResolve={allowed} />
          <Mapping view={view.data} canEdit={staff?.role === "admin"} />
        </div>
      )}
    </section>
  )
}

function Checks({ checks, canResolve }: { checks: EposCheck[]; canResolve: boolean }) {
  const toast = useToast()
  const resolve = useStockMutation(resolveEposCheck)
  return (
    <Panel className="lg:order-2">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Needs a check</h2>
        {checks.length > 0 ? <Badge tone="pop">{checks.length}</Badge> : <Badge tone="ok">Clear</Badge>}
      </div>
      {checks.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-fg-2">
          <CircleCheck className="size-4 text-ok" aria-hidden />
          Nothing waiting for a person.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {checks.map((check) => (
            <li key={`${check.kind}:${check.id}`} className="flex flex-col gap-1.5 py-3 first:pt-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {check.item ? (
                      <Link to="/stock/$id" params={{ id: check.item }} className="hover:underline">
                        {check.title || check.sku || "Item"}
                      </Link>
                    ) : (
                      check.title || check.sku || "Deleted item"
                    )}
                  </p>
                  <p className="text-xs text-fg-3">
                    {check.kind === "sale"
                      ? `${check.refund ? "Till refund" : "Till sale"} ${check.transaction_id}, ${whenText(check.at)}`
                      : `${check.action === "archive" ? "Archive" : "Product"}${check.epos_product_id ? ` ${check.epos_product_id}` : ""}, ${whenText(check.at)}`}
                    {check.kind === "sale" && check.sale_price ? (
                      <>
                        {", "}
                        <Money pence={check.sale_price} className="text-xs text-fg-3" />
                      </>
                    ) : null}
                  </p>
                </div>
                <Badge tone={check.kind === "sale" ? "warn" : "pop"}>{check.kind === "sale" ? "Sale" : "Product"}</Badge>
              </div>
              <p className="text-sm text-fg-2">{check.message}</p>
              {canResolve && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  loading={resolve.isPending && resolve.variables?.id === check.id}
                  onClick={() =>
                    resolve.mutate(check, {
                      onSuccess: () =>
                        toast({ message: check.kind === "sale" ? "Marked resolved." : "Marked resolved. The sync will try it again.", tone: "ok" }),
                      onError: (error) => toast({ message: errorText(error, "Not saved. Try again."), tone: "alert" }),
                    })
                  }
                >
                  Mark resolved
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Mapping({ view, canEdit }: { view: EposSettingsView; canEdit: boolean }) {
  const toast = useToast()
  const [map, setMap] = React.useState<EposCategoryMap>(view.settings.category_map)
  const [tax, setTax] = React.useState(String(view.settings.tax_group_id))
  const save = useStockMutation(saveEposSettings)
  const options = view.categories.map((c) => ({ value: String(c.id), label: c.name }))
  // A saved id the cached list does not know still shows.
  const withSaved = (id: number) =>
    id && !options.some((o) => o.value === String(id)) ? [{ value: String(id), label: `Category ${id}` }, ...options] : options

  const setPart = (part: "game" | "kind", key: string, value: string) =>
    setMap((m) => {
      const next = { ...m[part] }
      if (value) next[key] = Number(value)
      else delete next[key]
      return { ...m, [part]: next }
    })

  return (
    <Panel className="lg:order-1">
      <h2 className="font-semibold">Epos Now categories</h2>
      <p className="mb-4 text-sm text-fg-2">
        Where each Vault item goes on the till. A kind wins over a game. Categories last read from Epos Now {whenText(view.categories_refreshed_at)}
        {view.categories.length === 0 ? ", none yet: the shop Mac sync reads them on its next run." : "."}
      </p>
      <fieldset disabled={!canEdit} className="flex flex-col gap-3">
        <SelectField
          label="Everything else"
          placeholder="No category: item waits"
          value={map.default ? String(map.default) : ""}
          options={withSaved(map.default)}
          onChange={(v) => setMap((m) => ({ ...m, default: Number(v) || 0 }))}
        />
        <h3 className="label-mono mt-2 text-[10px] text-fg-3">By kind</h3>
        {view.kinds.map((kind) => (
          <SelectField
            key={kind}
            label={KIND_LABEL[kind] ?? kind}
            placeholder="Use the game"
            value={map.kind[kind] ? String(map.kind[kind]) : ""}
            options={withSaved(map.kind[kind] ?? 0)}
            onChange={(v) => setPart("kind", kind, v)}
          />
        ))}
        <h3 className="label-mono mt-2 text-[10px] text-fg-3">By game</h3>
        {view.games.map((game) => (
          <SelectField
            key={game.key}
            label={game.name}
            placeholder="Use everything else"
            value={map.game[game.key] ? String(map.game[game.key]) : ""}
            options={withSaved(map.game[game.key] ?? 0)}
            onChange={(v) => setPart("game", game.key, v)}
          />
        ))}
        <SelectField
          label="Tax group"
          hint="Set on every Vault product. Change it only if the shop registers for VAT."
          value={tax}
          options={TAX_GROUPS.some((t) => t.value === tax) ? TAX_GROUPS : [{ value: tax, label: `Tax group ${tax}` }, ...TAX_GROUPS]}
          onChange={setTax}
        />
      </fieldset>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-fg-3">
          {view.waiting} waiting to sync. Till sales last read {whenText(view.sales_polled_at)}.
        </p>
        {canEdit ? (
          <Button
            icon={<Save className="size-4" aria-hidden />}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { tax_group_id: Number(tax) || 0, category_map: map },
                {
                  onSuccess: (res) =>
                    toast({ message: res.requeued > 0 ? `Saved. ${res.requeued} waiting items will try again.` : "Saved.", tone: "ok" }),
                  onError: (error) => toast({ message: errorText(error, "Not saved. Try again."), tone: "alert" }),
                }
              )
            }
          >
            Save
          </Button>
        ) : (
          <p className="text-xs text-fg-3">Only an admin can change these.</p>
        )}
      </div>
    </Panel>
  )
}
