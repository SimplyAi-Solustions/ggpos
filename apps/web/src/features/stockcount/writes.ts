/**
 * One line at a time, per item.
 *
 * Two scans of the same card a moment apart both start from the same line:
 * if they were sent at once, the first would create the row and the second
 * would create a second one, or the later answer would land first and lose
 * a count. Each item therefore gets a chain, and the next write for that
 * item waits for the one before it and takes the id it came back with.
 *
 * The close waits for every chain, so a count is never closed on a variance
 * that is one scan out of date.
 */
import type { StockCountLine } from "@/lib/api/types"

export type LineWriter = (line: StockCountLine) => Promise<StockCountLine>

export interface WriteQueue {
  /** Sends this line once everything already queued for its item is done. */
  push(line: StockCountLine): Promise<StockCountLine>
  /** Resolves when nothing is in flight. */
  drain(): Promise<void>
  /** True while any write is in flight. */
  busy(): boolean
}

export function createWriteQueue(write: LineWriter): WriteQueue {
  const chains = new Map<string, Promise<StockCountLine>>()
  let inFlight = 0

  return {
    push(line) {
      const previous = chains.get(line.itemId)
      const next = (previous ?? Promise.resolve(line)).then(
        (settled) =>
          // The row may have been created by the write before this one, so
          // the id it came back with wins over the draft id in hand.
          write(settled.itemId === line.itemId ? { ...line, id: settled.id } : line),
        // The one before failed. This scan still deserves its attempt, from
        // the line as the screen has it.
        () => write(line)
      )
      inFlight += 1
      chains.set(
        line.itemId,
        next.finally(() => {
          inFlight -= 1
        })
      )
      return next
    },
    async drain() {
      // A chain can grow while we wait, so keep taking what is there until
      // nothing is left.
      while (chains.size > 0) {
        const waiting = [...chains.values()]
        await Promise.allSettled(waiting)
        for (const [item, chain] of [...chains.entries()]) {
          if (waiting.includes(chain)) chains.delete(item)
        }
      }
    },
    busy() {
      return inFlight > 0
    },
  }
}
