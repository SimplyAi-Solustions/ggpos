/**
 * One hairline line under the nav, and only when there is something to say.
 *
 * It answers three questions without anybody going looking: is the counter
 * offline, is anything still waiting to reach the server, and did the server
 * refuse any of it. The third opens the conflicts sheet, which shows the
 * server's own sentence and the basket behind it so staff can put it right.
 */
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  loadOfflineQueue,
  replayOfflineQueue,
  resolveQueuedLines,
} from "@/lib/api/offline"
import { netSnapshot, subscribeNet } from "@/lib/offline/net"
import {
  dismissConflict,
  queueSnapshot,
  subscribeQueue,
  type QueueConflict,
} from "@/lib/offline/queue"

function useQueue() {
  return React.useSyncExternalStore(subscribeQueue, queueSnapshot)
}

function useNet() {
  return React.useSyncExternalStore(subscribeNet, netSnapshot)
}

/** "2 sales", "1 label job", or the two of them joined. */
function waitingPhrase(sales: number, labels: number): string {
  const parts: string[] = []
  if (sales > 0) parts.push(`${sales} ${sales === 1 ? "sale" : "sales"}`)
  if (labels > 0) parts.push(`${labels} label ${labels === 1 ? "job" : "jobs"}`)
  return parts.join(" and ")
}

function ConflictLines({ conflict }: { conflict: QueueConflict }) {
  const { data: lines } = useQuery({
    queryKey: ["queued-lines", conflict.entry.id],
    queryFn: () => resolveQueuedLines(conflict.entry.lines),
    staleTime: 60_000,
  })

  if (conflict.entry.lines.length === 0) return null

  return (
    <ul className="mt-4 flex flex-col gap-2">
      {(lines ?? conflict.entry.lines.map((line) => ({ ...line, title: "Item", sku: "" }))).map(
        (line, index) => (
          <li
            key={`${conflict.entry.id}-${line.itemId}-${index}`}
            className="flex items-baseline justify-between gap-6 text-[15px] text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              {line.qty > 1 ? `${line.qty} × ` : ""}
              {line.title}
            </span>
            <span className="tnum shrink-0 text-[15px] text-muted-foreground">
              {formatGBP(line.unitPrice * line.qty)}
            </span>
          </li>
        )
      )}
    </ul>
  )
}

function ConflictsSheet({
  open,
  onOpenChange,
  conflicts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conflicts: QueueConflict[]
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="offline-conflicts"
        className="pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>Refused by the server</SheetTitle>
          <SheetDescription>
            These went in while the counter was offline and the server would not
            take them. Put each one right, then take it off the list.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {conflicts.length === 0 ? (
            <p className="text-[15px] text-muted-foreground-2">
              Nothing is waiting to be sorted out.
            </p>
          ) : (
            <ul className="flex flex-col">
              {conflicts.map((conflict) => (
                <li
                  key={conflict.entry.id}
                  data-testid="offline-conflict"
                  className="border-b border-hairline-soft py-5 first:pt-0"
                >
                  <MicroLabel>{conflict.entry.summary}</MicroLabel>
                  <p className="mt-2 text-[15px] leading-[1.5] text-destructive">
                    {conflict.message}
                  </p>
                  <ConflictLines conflict={conflict} />
                  <div className="mt-4">
                    <Button
                      variant="text"
                      onClick={() => void dismissConflict(conflict.entry.id)}
                    >
                      Take it off the list
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

export function OfflineStrip() {
  const net = useNet()
  const queue = useQueue()
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [retrying, setRetrying] = React.useState(false)

  React.useEffect(() => {
    void loadOfflineQueue()
  }, [])

  const pendingCount = queue.pending.length
  const conflictCount = queue.conflicts.length

  // Back online with work waiting: send it. A refusal stops the line, and
  // nothing goes automatically again until staff have cleared it, because
  // what they decide about one basket may change the ones behind it.
  React.useEffect(() => {
    if (net.offline || pendingCount === 0 || conflictCount > 0) return
    void replayOfflineQueue()
  }, [net.offline, pendingCount, conflictCount])

  const sales = queue.pending.filter((entry) => entry.work.kind === "mark_sold").length
  const labels = pendingCount - sales

  // The line goes as soon as there is nothing to say, but never while the
  // sheet is open: clearing the last conflict must not close the panel that
  // somebody is still reading.
  const speaking = net.offline || pendingCount > 0 || conflictCount > 0
  if (!speaking && !sheetOpen) return null

  const retry = async () => {
    setRetrying(true)
    try {
      await replayOfflineQueue()
    } finally {
      setRetrying(false)
    }
  }

  let message: string
  if (net.offline && pendingCount > 0) {
    message = `Offline, ${waitingPhrase(sales, labels)} waiting.`
  } else if (net.offline) {
    message = "Offline. Sales are held here and sent when the connection is back."
  } else if (pendingCount > 0) {
    message = `${waitingPhrase(sales, labels)} waiting to send.`
  } else {
    message = `${conflictCount} ${conflictCount === 1 ? "action was" : "actions were"} refused by the server.`
  }

  return (
    <>
      {speaking ? (
      <div className="border-b border-hairline-soft bg-background">
        <div
          data-testid="offline-strip"
          role="status"
          aria-live="polite"
          className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-x-8 gap-y-1 px-5 py-3 sm:px-10"
        >
          <span className="text-[13px] leading-[1.45] text-foreground">{message}</span>
          <span className="flex items-center gap-8">
            {conflictCount > 0 ? (
              <Button variant="text" onClick={() => setSheetOpen(true)}>
                Review {conflictCount}
              </Button>
            ) : null}
            {pendingCount > 0 && !net.offline ? (
              <Button variant="text" loading={retrying} onClick={() => void retry()}>
                Retry
              </Button>
            ) : null}
          </span>
        </div>
      </div>
      ) : null}
      <ConflictsSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        conflicts={queue.conflicts}
      />
    </>
  )
}
