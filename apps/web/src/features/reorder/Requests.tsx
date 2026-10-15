/**
 * Customer requests on the supplier call (docs/api-contract-reorder.md,
 * section 4.2): the open ones, oldest first, a hairline row each, with the
 * status as a select that saves the moment it changes. A request moved to
 * Collected or Cancelled leaves the list when the report comes back.
 */
import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  isOpenRequest,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUSES,
  type RequestStatus,
  type StockRequestView,
} from "@gg/shared"

import { Button } from "@/components/ui/button"
import { SectionHeading } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatDateTime } from "@/lib/dates"
import { refusalOrFallback } from "@/lib/api/refusal"
import { reorderKeys, updateRequest } from "@/lib/api/reorder"
import { requestWho } from "@/features/reorder/rack"
import { RequestSheet } from "@/features/reorder/RequestSheet"

function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value)
}

function RequestRow({
  request,
  pending,
  onStatus,
}: {
  request: StockRequestView
  pending: boolean
  onStatus: (status: RequestStatus) => void
}) {
  const who = requestWho(request)
  const asked = [
    `Quantity ${request.qty}.`,
    `Asked ${formatDateTime(request.created)}${request.createdByName ? ` by ${request.createdByName}` : ""}.`,
  ].join(" ")

  return (
    <li
      data-testid="request-row"
      data-request={request.title}
      className="grid gap-x-10 gap-y-3 border-b border-hairline-soft py-4 first:border-t min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_200px] min-[900px]:items-start"
    >
      <div className="min-w-0">
        <p className="text-[15px] leading-[1.5] text-foreground">{request.title}</p>
        <p className="tnum mt-1 text-[13px] leading-[1.45] text-muted-foreground-2">{asked}</p>
        {request.notes ? (
          <p className="mt-1 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">{request.notes}</p>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="text-[15px] leading-[1.5] text-foreground">{who.name}</p>
        {who.code ? (
          <p className="tnum font-mono text-[13px] text-muted-foreground-2">{who.code}</p>
        ) : null}
        {request.contactPhone ? (
          <p className="tnum text-[13px] leading-[1.45] text-muted-foreground-2">{request.contactPhone}</p>
        ) : null}
      </div>
      <div className="min-[900px]:pt-0.5">
        <Select
          value={request.status}
          disabled={pending}
          onValueChange={(next) => {
            if (isRequestStatus(next) && next !== request.status) onStatus(next)
          }}
        >
          <SelectTrigger aria-label={`Status of ${request.title}`} data-testid="request-status">
            <SelectValue>
              {(value: string) => (isRequestStatus(value) ? REQUEST_STATUS_LABELS[value] : "Waiting")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {REQUEST_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {REQUEST_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </li>
  )
}

export function RequestsSection({
  supplier,
  requests,
}: {
  supplier: { id: string; name: string }
  requests: StockRequestView[]
}) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = React.useState(false)
  const [note, setNote] = React.useState<{ tone: "info" | "error"; text: string } | null>(null)

  const change = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RequestStatus }) => updateRequest(id, { status }),
    onSuccess: (saved) => {
      const label = REQUEST_STATUS_LABELS[saved.status]
      setNote({
        tone: "info",
        text: isOpenRequest(saved.status)
          ? `${saved.title} is ${label} now.`
          : `${saved.title} is ${label} now, so it leaves the open requests.`,
      })
      void queryClient.invalidateQueries({ queryKey: reorderKeys.all })
    },
    onError: (error) =>
      setNote({
        tone: "error",
        text: refusalOrFallback(error, "That status did not save. Check the connection and try again."),
      }),
  })

  return (
    <section className="mt-24" aria-labelledby="requests-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <SectionHeading id="requests-heading" className="mt-0">
          Customer requests
        </SectionHeading>
        <Button
          variant="text"
          onClick={() => {
            setNote(null)
            setAdding(true)
          }}
        >
          Add a request
        </Button>
      </div>

      {requests.length === 0 ? (
        <p data-testid="requests-empty" className="mt-2 max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
          No open requests. When a customer asks for something {supplier.name} can get, add it here
          so it is asked for on the call.
        </p>
      ) : (
        <ul data-testid="request-list" className="mt-2">
          {requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              pending={change.isPending && change.variables?.id === request.id}
              onStatus={(status) => change.mutate({ id: request.id, status })}
            />
          ))}
        </ul>
      )}

      {note ? (
        <p
          data-testid="requests-note"
          aria-live="polite"
          className={
            note.tone === "error"
              ? "mt-4 text-[13px] leading-[1.45] text-destructive"
              : "mt-4 text-[13px] leading-[1.45] text-muted-foreground"
          }
        >
          {note.text}
        </p>
      ) : null}

      <RequestSheet
        open={adding}
        onOpenChange={setAdding}
        supplier={supplier}
        onAdded={(title) => setNote({ tone: "info", text: `${title} is on the list, waiting to be asked for.` })}
      />
    </section>
  )
}
