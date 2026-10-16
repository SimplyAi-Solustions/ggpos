import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/ui/page-title"
import { refusalOrFallback } from "@/lib/api/refusal"

/**
 * A read that did not come back.
 *
 * The one thing a portal screen must never do is answer a failed read with
 * its own empty state: "Nothing on your list" and "£0.00" are statements
 * about the shop's records, and a customer who reads either after a dropped
 * connection has been told something untrue about their own money. So every
 * list and every balance branches here first, and this says what happened
 * and what to do about it, in the server's own words when it wrote any.
 */
export function LoadFailed({
  title,
  error,
  fallback,
  onRetry,
}: {
  /** The screen's own Anton line, so the page still has one. */
  title: string
  error: unknown
  /** What to say when the failure had no words of its own. */
  fallback: string
  onRetry?: () => void
}) {
  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>{title}</PageTitle>
      <p
        role="alert"
        className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground"
      >
        {refusalOrFallback(error, fallback)}
      </p>
      {onRetry ? (
        <div className="mt-10">
          <Button type="button" variant="text" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  )
}
