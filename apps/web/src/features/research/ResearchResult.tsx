/**
 * One research request as staff read it: where it has got to in words, the
 * agent's own sentence, and the comps it found, each a hairline row with the
 * date it sold, the listing's title, the price and a link to the listing.
 * Shared by the line's own block (ResearchActions) and the Research list.
 */
import { formatGBP, researchStatusWords, type ResearchRequest } from "@gg/shared"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { MicroLabel } from "@/components/ui/micro-label"
import { isLive } from "@/lib/api/research"
import { formatDate, formatDateTime } from "@/lib/dates"

export function ResearchResult({
  request,
  onCancel,
  cancelling = false,
  label = true,
  className,
}: {
  request: ResearchRequest
  onCancel?: () => void
  cancelling?: boolean
  /** The RESEARCH label, which the Research list itself does not need. */
  label?: boolean
  className?: string
}) {
  const when =
    request.status === "done"
      ? request.done_at
      : request.status === "claimed"
        ? request.claimed_at
        : request.created

  return (
    <div data-testid="research-result" data-status={request.status} className={cn("w-full", className)}>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {label ? (
          <MicroLabel tone="ink" className="inline">
            Research
          </MicroLabel>
        ) : null}
        <span data-testid="research-status" className="text-[15px] leading-[1.4] text-foreground">
          {researchStatusWords(request)}
        </span>
        {when ? (
          <span className="tnum font-mono text-[13px] text-muted-foreground-2">{formatDateTime(when)}</span>
        ) : null}
      </p>

      {request.result ? (
        <p className="mt-2 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">{request.result}</p>
      ) : null}

      {request.comps.length ? (
        <ul aria-label="Sold on eBay UK" data-testid="research-comps" className="mt-3">
          {request.comps.map((comp, index) => (
            <li
              key={`${comp.url}-${index}`}
              data-testid="research-comp"
              className="flex min-h-11 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hairline-soft py-2 first:border-t"
            >
              <span className="tnum w-24 shrink-0 font-mono text-[13px] text-muted-foreground-2">
                {formatDate(comp.sold_at)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.45] text-muted-foreground">
                {comp.title || "Sold listing"}
                {comp.condition ? `, ${comp.condition}` : ""}
              </span>
              <span className="tnum shrink-0 text-[15px] text-foreground">{formatGBP(comp.price)}</span>
              <a
                href={comp.url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[13px] text-muted-foreground underline underline-offset-4"
              >
                Listing
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {onCancel && isLive(request) ? (
        <div className="mt-3">
          <Button variant="text-destructive" type="button" loading={cancelling} onClick={onCancel}>
            Cancel request
          </Button>
        </div>
      ) : null}
    </div>
  )
}
