/** Copy for the item page's Epos Now slot (components/EposStatus.tsx). */
import type { EposItem } from "../api"

export function eposTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso.replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

/** The heading and line for each state. Exported for its test. */
export function eposCopy(epos: EposItem | undefined, failed: boolean): { title: string; line: string; tone: "ok" | "wait" | "alert" | "off" } {
  if (failed) return { title: "Epos Now: status not loaded", line: "Check the connection and reopen the item.", tone: "off" }
  if (!epos) return { title: "Epos Now", line: "Checking.", tone: "off" }
  switch (epos.status) {
    case "synced": {
      const at = eposTime(epos.synced_at)
      return { title: "On Epos Now", line: `${at ? `Synced ${at}` : "Synced"}, product ${epos.epos_product_id}`, tone: "ok" }
    }
    case "waiting":
      return { title: "Waiting to sync", line: epos.message, tone: "wait" }
    case "needs_check":
      return { title: "Needs a check", line: epos.message, tone: "alert" }
    case "archived":
      return { title: "Off Epos Now", line: epos.message, tone: "off" }
    default:
      return { title: "Not on Epos Now", line: epos.message, tone: "off" }
  }
}
