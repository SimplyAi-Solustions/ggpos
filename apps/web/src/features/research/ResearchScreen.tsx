/**
 * Research: the requests for UK sold comps, newest first
 * (docs/api-contract-launch.md, section 5). Staff ask from a trade-in line,
 * price check or an item page; an agent claims each and completes it with
 * the comps it found, which land as UK sold comps on the card. This list is
 * where staff see what is waiting, who is on what, and what was found.
 *
 * Open, claimed and done, with a chip each to narrow it; cancelled requests
 * are left out. Read again every few seconds while anything is still being
 * looked at.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { buttonVariants } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { Skeleton } from "@/components/ui/skeleton"
import { ResearchResult } from "@/features/research/ResearchResult"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  cancelResearch,
  isLive,
  listResearch,
  researchKeys,
  researchPollMs,
  type ResearchRequest,
} from "@/lib/api/research"
import { formatDateTime } from "@/lib/dates"

const FILTERS = [
  { value: "open,claimed,done", label: "All" },
  { value: "open", label: "Open" },
  { value: "claimed", label: "Claimed" },
  { value: "done", label: "Done" },
] as const

function Row({
  request,
  onCancel,
  cancelling,
}: {
  request: ResearchRequest
  onCancel: () => void
  cancelling: boolean
}) {
  const asked = [
    request.requested_by ? `Asked by ${request.requested_by.name}` : "Asked",
    formatDateTime(request.created),
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <li data-testid="research-row" data-status={request.status} className="border-b border-hairline-soft py-6 first:border-t">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-[16px] leading-[1.4] text-foreground">{request.title}</span>
          <span className="text-[13px] leading-[1.45] text-muted-foreground-2">
            {asked}. Searched for &ldquo;{request.query}&rdquo;.
          </span>
        </span>
        <a
          href={request.ebay_url}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "text" })}
        >
          Search eBay sold
        </a>
      </div>
      <ResearchResult
        className="mt-4"
        label={false}
        request={request}
        onCancel={onCancel}
        cancelling={cancelling}
      />
    </li>
  )
}

export function ResearchScreen() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = React.useState<string>(FILTERS[0].value)
  const [error, setError] = React.useState<string | null>(null)

  const list = useQuery({
    queryKey: researchKeys.list({ status: filter }),
    queryFn: () => listResearch({ status: filter }),
    staleTime: 10_000,
    refetchInterval: (query) => ((query.state.data ?? []).some((row) => isLive(row)) ? researchPollMs() : false),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => cancelResearch(id),
    onMutate: () => setError(null),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: researchKeys.all }),
    onError: (cause) => setError(refusalOrFallback(cause, "The request was not cancelled. Try again.")),
  })

  const rows = list.data ?? []

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Research</PageTitle>
      <Lede>
        UK sold comps an agent is finding. Ask from a trade-in line, price check or an item page;
        what it finds leads that card&rsquo;s price.
      </Lede>

      <ChipGroup
        aria-label="Show"
        className="mt-10"
        value={[filter]}
        onValueChange={(next: string[]) => {
          if (next[0]) setFilter(next[0])
        }}
      >
        {FILTERS.map((option) => (
          <Chip key={option.value} value={option.value}>
            {option.label}
          </Chip>
        ))}
      </ChipGroup>

      {error ? (
        <p role="alert" className="mt-6 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-10">
        {list.isPending ? (
          <div className="flex flex-col gap-4" aria-hidden="true">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        ) : list.error ? (
          <p role="alert" className="text-[15px] text-destructive">
            {refusalOrFallback(list.error, "The research list would not load. Check the connection and try again.")}
          </p>
        ) : rows.length === 0 ? (
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground-2">
            Nothing here yet. Press Ask an agent beside the price sources on a trade-in line, in price
            check or on an item page.
          </p>
        ) : (
          <ul data-testid="research-list">
            {rows.map((request) => (
              <Row
                key={request.id}
                request={request}
                cancelling={cancel.isPending && cancel.variables === request.id}
                onCancel={() => cancel.mutate(request.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
