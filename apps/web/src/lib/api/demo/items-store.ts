/**
 * The demo shop's stock, as one array.
 *
 * It lives in its own module because everything in `lib/api/demo/` needs it
 * and `lib/api/index.ts` writes to it: holding it in the barrel made the
 * demo stores import the barrel back, and a module-scope read across that
 * cycle (the Guild store reading the seed figures as it is evaluated) came
 * out undefined and left the app blank. A leaf module has nothing to cycle
 * with.
 *
 * Add stock appends to this very array, so an item added on one screen is
 * sellable on the next without a server. Nothing outside `lib/api/` should
 * touch it.
 */
import { DEMO_ITEMS } from "@/lib/api/fixtures"
import type { ItemRecord } from "@/lib/api/types"

/** Items created during a demo session, newest first. Never persisted. */
export const demoItems: ItemRecord[] = [...DEMO_ITEMS]
