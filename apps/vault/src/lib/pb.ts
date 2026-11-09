import PocketBase from "pocketbase"

/**
 * One PocketBase client for the whole app, same as apps/web/src/lib/pb.ts.
 *
 * In production PocketBase serves this app from pb_public, so the app and the
 * API share an origin and the base URL is "/". In dev the Vite server proxies
 * `/api` and `/_` to 127.0.0.1:8091. `VITE_PB_URL` overrides it.
 *
 * The SDK keeps its auth store in localStorage under `pocketbase_auth`. The
 * customer pages (/account) share that store on the same origin, so the
 * session code below only accepts a `staff` record.
 */
export const pb = new PocketBase(import.meta.env.VITE_PB_URL ?? "/")

/** Screens refresh through TanStack Query, so the SDK's auto-cancel is off. */
pb.autoCancellation(false)
