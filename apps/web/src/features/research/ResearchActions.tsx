/**
 * "Search eBay sold" and "Ask an agent", beside the price sources on a
 * trade-in line, in price check and on the item page
 * (docs/api-contract-launch.md, section 5).
 *
 * Search eBay sold opens ebay.co.uk's sold and completed listings from UK
 * sellers for the card's name, set and number in a new tab. Ask an agent
 * makes a research request about this line, item or card, which wakes the
 * shop's agent through the webhook; the request's progress and the comps it
 * found show here, read again every few seconds until it is done. When it
 * is, the comps are UK sold comps on the card or retro title, so the price
 * sources above are read again and lead with them.
 */
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ebaySoldUrl, researchWords, type ResearchSubject } from "@gg/shared"
import { cn } from "cn"

import { Button, buttonVariants } from "@/components/ui/button"
import { ResearchResult } from "@/features/research/ResearchResult"
import { priceKeys } from "@/lib/api/prices"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  cancelResearch,
  createResearch,
  getResearch,
  isLive,
  listResearch,
  researchKeys,
  researchPollMs,
  type ResearchFilters,
  type ResearchRequest,
} from "@/lib/api/research"

export interface ResearchTarget {
  /** What the words are made of: name, set, number, finish, condition. */
  subject: ResearchSubject
  card?: string
  retroTitle?: string
  item?: string
  /** The saved `trade_in_lines` id, once the draft has been written. */
  tradeInLine?: string
  /** A card's finish, or a retro title's completeness. */
  finish?: string
  /** NM to DMG, for a card. */
  condition?: string
}

/** Which requests count as this one's: the line, else the item, else the card or title. */
function filtersFor(target: ResearchTarget): ResearchFilters | null {
  if (target.tradeInLine) return { trade_in_line: target.tradeInLine }
  if (target.item) return { item: target.item }
  if (target.card) return { card: target.card }
  if (target.retroTitle) return { retro_title: target.retroTitle }
  return null
}

function poll(request: ResearchRequest | null | undefined): number | false {
  return isLive(request) ? researchPollMs() : false
}

export function ResearchActions({ target, className }: { target: ResearchTarget; className?: string }) {
  const queryClient = useQueryClient()
  const [createdId, setCreatedId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const words = researchWords(target.subject)
  const filters = filtersFor(target)

  const latest = useQuery({
    queryKey: researchKeys.list(filters ?? {}),
    queryFn: () => listResearch(filters ?? {}),
    enabled: filters !== null,
    staleTime: 15_000,
    select: (rows) =>
      rows.find(
        (row) =>
          row.status !== "cancelled" &&
          // A card or a title asked about in another finish is another question.
          (filters?.trade_in_line || filters?.item || !target.finish || row.finish === target.finish)
      ) ?? null,
    refetchInterval: (query) => {
      const rows = query.state.data ?? []
      return rows.some((row) => isLive(row)) ? researchPollMs() : false
    },
  })
  const created = useQuery({
    queryKey: researchKeys.one(createdId ?? ""),
    queryFn: () => getResearch(createdId as string),
    enabled: createdId !== null,
    refetchInterval: (query) => poll(query.state.data),
  })
  const shown = (createdId ? created.data : null) ?? latest.data ?? null

  // Once it is done, the comps are UK sold comps: read the sources again.
  const doneKey = shown?.status === "done" ? shown.id : null
  React.useEffect(() => {
    if (!doneKey) return
    if (target.card) void queryClient.invalidateQueries({ queryKey: priceKeys.cardAll(target.card) })
    if (target.retroTitle) void queryClient.invalidateQueries({ queryKey: priceKeys.retroAll(target.retroTitle) })
  }, [doneKey, queryClient, target.card, target.retroTitle])

  const ask = useMutation({
    mutationFn: () =>
      createResearch({
        query: words,
        title: [target.subject.name, target.subject.setName, target.subject.number].filter(Boolean).join(" · "),
        card: target.card,
        retro_title: target.card ? undefined : target.retroTitle,
        item: target.item,
        trade_in_line: target.tradeInLine,
        finish: target.finish,
        condition: target.card ? target.condition : undefined,
      }),
    onMutate: () => setError(null),
    onSuccess: ({ request }) => {
      setCreatedId(request.id)
      queryClient.setQueryData(researchKeys.one(request.id), request)
      void queryClient.invalidateQueries({ queryKey: researchKeys.all })
    },
    onError: (cause) => setError(refusalOrFallback(cause, "The request did not go through. Try again.")),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => cancelResearch(id),
    onMutate: () => setError(null),
    onSuccess: (request) => {
      queryClient.setQueryData(researchKeys.one(request.id), request)
      void queryClient.invalidateQueries({ queryKey: researchKeys.all })
    },
    onError: (cause) => setError(refusalOrFallback(cause, "The request was not cancelled. Try again.")),
  })

  return (
    <div data-testid="research" className={cn("w-full", className)}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <a
          href={ebaySoldUrl(words)}
          target="_blank"
          rel="noreferrer"
          data-testid="ebay-sold"
          className={buttonVariants({ variant: "text" })}
        >
          Search eBay sold
        </a>
        <Button
          variant="text"
          type="button"
          loading={ask.isPending}
          disabled={!words || isLive(shown)}
          onClick={() => ask.mutate()}
        >
          Ask an agent
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] leading-[1.45] text-destructive">
          {error}
        </p>
      ) : null}
      {shown ? (
        <ResearchResult
          className="mt-5"
          request={shown}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate(shown.id)}
        />
      ) : null}
    </div>
  )
}
