/**
 * The offline queue.
 *
 * Two things the counter is allowed to do without a server: mark a basket
 * sold and queue labels (docs/PLAN.md, "Core flows and rules > Offline").
 * Both are held here under a client id, in IndexedDB so they survive a
 * reload, and replayed in the order they were taken once the connection is
 * back. A buy-in is never queued: it needs the server.
 *
 * Replay stops at the first refusal. The server's own sentence is kept
 * beside the action as a conflict, because an already-sold item or a closed
 * cash session is a thing a person has to sort out, not a thing to retry,
 * and everything queued behind it may depend on what they decide.
 *
 * Nothing in here imports the API layer: the caller registers a sender, so
 * the queue can be driven by the real routes, by demo fixtures or by a test.
 */
import { ClientResponseError } from "pocketbase"

import { refusalMessage, refusalOrFallback } from "@/lib/api/refusal"
import { noteNetworkFailure, noteNetworkSuccess } from "@/lib/offline/net"
import { openStore, type KeyValueStore } from "@/lib/offline/store"
import type { CompleteSalePayload, LabelTemplateKey } from "@/lib/api/types"

export type QueuedKind = "mark_sold" | "queue_labels"

export interface QueuedSaleWork {
  kind: "mark_sold"
  body: CompleteSalePayload
}

export interface QueuedLabelWork {
  kind: "queue_labels"
  itemIds: string[]
  template?: LabelTemplateKey
}

export type QueuedWork = QueuedSaleWork | QueuedLabelWork

/**
 * One basket line, kept so a refused sale can be read back in full.
 *
 * The title is looked up when the sheet shows it rather than stored here: a
 * conflict only exists after the server has answered, so the connection is
 * back by the time anybody reads one.
 */
export interface QueuedLine {
  itemId: string
  qty: number
  /** Integer GBP pence. */
  unitPrice: number
}

export interface QueuedEntry {
  /**
   * The client id. It keys the row in IndexedDB and makes enqueueing the
   * same action twice a no-op, so a double press or a reload mid-save can
   * never put two of one sale in the queue.
   */
  id: string
  work: QueuedWork
  /** ISO timestamp. Replay runs in this order. */
  queuedAt: string
  /** One line for the strip and the conflicts sheet. */
  summary: string
  /** Integer GBP pence; zero for a label job. */
  total: number
  lines: QueuedLine[]
}

export interface QueueConflict {
  entry: QueuedEntry
  /** The server's own sentence, written for staff to read. */
  message: string
  /** ISO timestamp of the refusal. */
  at: string
}

export interface QueueSnapshot {
  pending: QueuedEntry[]
  conflicts: QueueConflict[]
}

export interface ReplayReport {
  sent: number
  /** Set when replay stopped because the server refused one. */
  conflict: QueueConflict | null
  /** Set when replay stopped because nothing was getting through. */
  offline: boolean
  remaining: number
}

/** What actually sends one entry. Registered by `lib/api/offline.ts`. */
export type QueueSender = (entry: QueuedEntry) => Promise<void>

const PENDING = "p:"
const CONFLICT = "c:"

let store: KeyValueStore = openStore()
let hydrated: Promise<void> | null = null
let sender: QueueSender | null = null
let replaying: Promise<ReplayReport> | null = null

const pending = new Map<string, QueuedEntry>()
const conflicts = new Map<string, QueueConflict>()
const listeners = new Set<() => void>()

let snapshot: QueueSnapshot = { pending: [], conflicts: [] }

function byQueuedAt(a: QueuedEntry, b: QueuedEntry): number {
  return a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id)
}

/**
 * The sentence behind a refusal, or null when nothing answered.
 *
 * A `ClientResponseError` at status 0 and a `TypeError` from `fetch` are the
 * two shapes a request that reached nobody comes back as; everything else
 * that carries a sentence written for staff is the server, or demo mode,
 * saying no, and that is a conflict rather than something to retry.
 */
function refusalOf(error: unknown): string | null {
  if (error instanceof ClientResponseError) {
    return error.status === 0 ? null : refusalMessage(error)
  }
  if (error instanceof TypeError) return null
  return refusalOrFallback(error, "") || null
}

function publish() {
  snapshot = {
    pending: [...pending.values()].sort(byQueuedAt),
    conflicts: [...conflicts.values()].sort((a, b) => byQueuedAt(a.entry, b.entry)),
  }
  for (const listener of listeners) listener()
}

/** Reads what the last session left behind. Safe to call as often as you like. */
export function hydrateQueue(): Promise<void> {
  if (!hydrated) {
    hydrated = store
      .entries<QueuedEntry | QueueConflict>()
      .then((entries) => {
        for (const [key, value] of entries) {
          if (key.startsWith(PENDING)) {
            pending.set(key.slice(PENDING.length), value as QueuedEntry)
          } else if (key.startsWith(CONFLICT)) {
            conflicts.set(key.slice(CONFLICT.length), value as QueueConflict)
          }
        }
        publish()
      })
      .catch(() => {
        // A queue that cannot be read is an empty queue, not a broken counter.
        publish()
      })
  }
  return hydrated
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A stable object for `useSyncExternalStore`. */
export function queueSnapshot(): QueueSnapshot {
  return snapshot
}

export function registerSender(next: QueueSender | null) {
  sender = next
}

/** A client id: the time it was taken, so ids sort the way the queue replays. */
export function newClientId(): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${random}`
}

export interface EnqueueInput {
  work: QueuedWork
  summary: string
  total?: number
  lines?: QueuedLine[]
  /** Supply one to make the call idempotent across retries. */
  id?: string
  queuedAt?: string
}

/**
 * Put one action in the queue. Enqueueing an id that is already held, waiting
 * or refused, changes nothing and hands back what is already there.
 */
export async function enqueue(input: EnqueueInput): Promise<QueuedEntry> {
  await hydrateQueue()
  const id = input.id ?? newClientId()
  const held = pending.get(id) ?? conflicts.get(id)?.entry
  if (held) return held

  const entry: QueuedEntry = {
    id,
    work: input.work,
    queuedAt: input.queuedAt ?? new Date().toISOString(),
    summary: input.summary,
    total: input.total ?? 0,
    lines: input.lines ?? [],
  }
  pending.set(id, entry)
  publish()
  await store.set(`${PENDING}${id}`, entry)
  return entry
}

async function settle(entry: QueuedEntry) {
  pending.delete(entry.id)
  publish()
  await store.remove(`${PENDING}${entry.id}`)
}

async function refuse(entry: QueuedEntry, message: string): Promise<QueueConflict> {
  const conflict: QueueConflict = { entry, message, at: new Date().toISOString() }
  pending.delete(entry.id)
  conflicts.set(entry.id, conflict)
  publish()
  await store.remove(`${PENDING}${entry.id}`)
  await store.set(`${CONFLICT}${entry.id}`, conflict)
  return conflict
}

/** Staff have dealt with a refused action and taken it off the list. */
export async function dismissConflict(id: string): Promise<void> {
  await hydrateQueue()
  conflicts.delete(id)
  publish()
  await store.remove(`${CONFLICT}${id}`)
}

/**
 * Send everything waiting, oldest first.
 *
 * One replay at a time: a second caller (the reconnect listener and the
 * retry button firing together) waits for the one already running rather
 * than sending the same entry twice.
 */
export function replayQueue(with_?: QueueSender): Promise<ReplayReport> {
  if (replaying) return replaying
  const send = with_ ?? sender
  replaying = run(send).finally(() => {
    replaying = null
  })
  return replaying
}

async function run(send: QueueSender | null): Promise<ReplayReport> {
  await hydrateQueue()
  const report: ReplayReport = {
    sent: 0,
    conflict: null,
    offline: false,
    remaining: pending.size,
  }
  if (!send) return report

  for (const entry of [...pending.values()].sort(byQueuedAt)) {
    try {
      await send(entry)
      noteNetworkSuccess()
      await settle(entry)
      report.sent += 1
    } catch (error) {
      const message = refusalOf(error)
      if (message) {
        // The server answered and said no. Everything behind it waits: what
        // staff decide about this one may change what the rest should do.
        noteNetworkSuccess()
        report.conflict = await refuse(entry, message)
      } else {
        noteNetworkFailure()
        report.offline = true
      }
      break
    }
  }

  report.remaining = pending.size
  return report
}

/** Tests only: a queue with nothing in it and no sender. */
export async function resetQueue(next?: KeyValueStore) {
  pending.clear()
  conflicts.clear()
  sender = null
  replaying = null
  store = next ?? openStore()
  hydrated = null
  await store.clear()
  publish()
}
