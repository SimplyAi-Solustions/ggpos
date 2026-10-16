import * as React from "react"
import { createPortal } from "react-dom"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import { MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { SkeletonText } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { answerQuote, getQuote, sendQuoteMessage } from "@/lib/api/quotes"
import { refusalOrFallback } from "@/lib/api/refusal"
import { usePortalDock } from "@/features/portal/dock"
import { DROP_OFF_LABEL } from "@/features/portal/format"
import { LoadFailed } from "@/features/portal/LoadFailed"
import { formatDate, formatDateTime } from "@/features/portal/format"
import { needsAnswer, quoteTimeline } from "@/features/portal/timeline"
import { Note } from "@/features/portal/Note"
import { SHEET_COLUMN } from "@/features/portal/sheet"
import { Timeline } from "@/features/portal/Timeline"
import type { QuoteDropOff } from "@/lib/api/types"

const MAX_REPLY = 2000

/**
 * One quote: where it has got to, what we offered, the photos that were
 * sent, and the thread.
 *
 * Accept and decline both go through a sheet, because both are decisions the
 * shop then acts on and neither should happen on a mis-tap in a pocket.
 */
export function QuoteDetailScreen({ id }: { id: string }) {
  const dock = usePortalDock()
  const queryClient = useQueryClient()
  const [answering, setAnswering] = React.useState<"accept" | "decline" | null>(null)
  const [reply, setReply] = React.useState("")
  const [dropOff, setDropOff] = React.useState<QuoteDropOff>("in_store")
  const [note, setNote] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  /** The sheet's own refusal, shown inside it rather than behind it. */
  const [sheetError, setSheetError] = React.useState<string | null>(null)

  const { data, isPending, isError, error: readError, refetch } = useQuery({
    queryKey: ["portal", "quote", id],
    queryFn: () => getQuote(id),
  })

  function closeAnswer() {
    setAnswering(null)
    setSheetError(null)
    setReply("")
  }

  /** One way in, so the reply, the drop-off and the refusal all start clean. */
  function openAnswer(choice: "accept" | "decline") {
    setReply("")
    setSheetError(null)
    setDropOff(data?.quote.drop_off ?? "in_store")
    setAnswering(choice)
  }

  const answer = useMutation({
    mutationFn: (choice: "accept" | "decline") =>
      answerQuote(id, choice, {
        reply: reply.trim() || undefined,
        // Only on an accept: declining a quote says nothing about how the
        // items would have reached us.
        dropOff: choice === "accept" ? dropOff : undefined,
      }),
    onSuccess: async () => {
      setAnswering(null)
      setReply("")
      setSheetError(null)
      await queryClient.invalidateQueries({ queryKey: ["portal"] })
    },
    onError: (cause) =>
      // Inside the sheet, which still owns the screen: an expired offer's
      // refusal is exactly what the person pressing the button needs to read.
      setSheetError(
        refusalOrFallback(cause, "That did not go through. Try again in a moment.")
      ),
  })

  const message = useMutation({
    mutationFn: () => sendQuoteMessage(id, note.trim()),
    onSuccess: async () => {
      setNote("")
      await queryClient.invalidateQueries({ queryKey: ["portal", "quote", id] })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That message did not send. Try again in a moment.")
      ),
  })

  if (isError) {
    return (
      <LoadFailed
        title="Quote"
        error={readError}
        fallback="We could not read that quote just now. Check your connection and try again."
        onRetry={() => void refetch()}
      />
    )
  }

  if (isPending) {
    return (
      <section className="pt-12 sm:pt-20">
        <SkeletonText lines={6} />
      </section>
    )
  }

  if (!data) {
    return (
      <section className="pt-12 sm:pt-20">
        <PageTitle>Quote</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          That quote is not on your record. Go back to your quotes and pick one
          from the list.
        </p>
        <div className="mt-10">
          <Button variant="text" render={<Link to="/account/quotes" />}>
            Back to quotes
          </Button>
        </div>
      </section>
    )
  }

  const { quote, messages, photos } = data
  const steps = quoteTimeline(quote, { formatDate })
  const open = needsAnswer(quote)

  const accept = (
    <Button type="button" trailingArrow onClick={() => openAnswer("accept")}>
      Accept the offer
    </Button>
  )

  return (
    <section className="pt-12 sm:pt-20">
      <PageTitle>Quote</PageTitle>
      {/* A quote carries no number, so the day it was sent names it. */}
      <p className="mt-3 text-base leading-[1.5] text-muted-foreground">
        Sent {formatDate(quote.created)}
      </p>

      <div className="mt-12">
        <Timeline steps={steps} />
      </div>

      {quote.offer_total ? (
        <>
          <SectionHeading className="mt-14">Our offer</SectionHeading>
          <p
            data-testid="quote-offer-total"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(quote.offer_total)}
          </p>
          {quote.offer_expires_at ? (
            <Note className="mt-3">
              {`Stands until ${formatDateTime(quote.offer_expires_at)}`}
            </Note>
          ) : null}

          {(quote.lines ?? []).length > 0 ? (
            <ul className="mt-8 flex flex-col">
              {(quote.lines ?? []).map((line, index) => (
                <li
                  key={`${line.title}-${index}`}
                  className="flex items-baseline justify-between gap-5 border-b border-hairline-soft py-3"
                >
                  <span className="min-w-0 text-[15px] leading-[1.4]">
                    {line.title}
                    {line.qty > 1 ? (
                      <span className="text-muted-foreground-2"> x{line.qty}</span>
                    ) : null}
                    {line.condition ? (
                      <span className="block text-[13px] text-muted-foreground-2">
                        {line.condition}
                        {line.finish ? `, ${line.finish}` : ""}
                      </span>
                    ) : null}
                  </span>
                  <span className="tnum shrink-0 text-[15px] font-medium">
                    {formatGBP(line.offer_price * line.qty)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {open ? (
            <div className="mt-10 flex flex-wrap items-center gap-8">
              <div className="hidden min-[900px]:block">{accept}</div>
              <Button
                type="button"
                variant="text-destructive"
                onClick={() => openAnswer("decline")}
              >
                Decline
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {photos.length > 0 ? (
        <>
          <SectionHeading className="mt-14">Your photos</SectionHeading>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {photos.map((photo, index) => (
              <li key={photo.name}>
                <img
                  src={photo.url}
                  alt={`Photo ${index + 1} you sent`}
                  loading="lazy"
                  className="aspect-square w-full border border-hairline-soft bg-background object-contain"
                />
              </li>
            ))}
          </ul>
          <Note className="mt-3">Deleted 90 days after this quote closes.</Note>
        </>
      ) : null}

      <SectionHeading className="mt-14">Messages</SectionHeading>
      {messages.length === 0 ? (
        <p className="text-[15px] leading-[1.5] text-muted-foreground-2">
          Nothing said yet. Ask us anything about this quote.
        </p>
      ) : (
        <ul className="flex flex-col gap-6">
          {messages.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1.5">
              <MicroLabel>
                {entry.author === "staff" ? "GG Entertainment" : "You"}
              </MicroLabel>
              <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
                {entry.body}
              </p>
              <Note>{formatDateTime(entry.created)}</Note>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10">
        <Field layout="stacked" label="Reply" htmlFor="quote-note">
          <Textarea
            id="quote-note"
            value={note}
            rows={2}
            maxLength={MAX_REPLY}
            placeholder="Ask a question, or tell us when you are coming"
            trailingHint={`${note.length} / ${MAX_REPLY}`}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <div className="mt-6">
          <Button
            type="button"
            variant="text"
            loading={message.isPending}
            disabled={note.trim().length === 0}
            onClick={() => message.mutate()}
          >
            Send message
          </Button>
        </div>
      </div>

      {error ? <FieldError className="mt-8">{error}</FieldError> : null}

      <div className="mt-14">
        <Button variant="text" render={<Link to="/account/quotes" />}>
          Back to quotes
        </Button>
      </div>

      {open && dock
        ? createPortal(
            <div className="border-t border-hairline-soft bg-background px-5 py-3 min-[900px]:hidden">
              {accept}
            </div>,
            dock
          )
        : null}

      <Sheet
        open={answering !== null}
        onOpenChange={(next) => {
          if (!next) closeAnswer()
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className={SHEET_COLUMN}>
            <SheetTitle>
              {answering === "decline" ? "Decline this offer" : "Accept this offer"}
            </SheetTitle>
            <SheetDescription>
              {answering === "decline"
                ? "We will close the quote. You can send new photos any time."
                : dropOff === "post"
                  ? `We will hold ${quote.offer_total ? formatGBP(quote.offer_total) : "the offer"} for you and send you the address to post to. Send it tracked, at your own risk.`
                  : `We will hold ${quote.offer_total ? formatGBP(quote.offer_total) : "the offer"} for you. Bring the items to the shop in Bolsover and we will check them over.`}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className={SHEET_COLUMN}>
            {answering === "accept" ? (
              <div className="mb-10">
                <MicroLabel className="mb-3">Drop off</MicroLabel>
                <ChipGroup
                  aria-label="How the items will reach us"
                  value={[dropOff]}
                  onValueChange={(next) => {
                    if (next[0]) setDropOff(next[0] as QuoteDropOff)
                  }}
                >
                  {(Object.keys(DROP_OFF_LABEL) as QuoteDropOff[]).map((option) => (
                    <Chip key={option} value={option}>
                      {DROP_OFF_LABEL[option]}
                    </Chip>
                  ))}
                </ChipGroup>
              </div>
            ) : null}

            <Field layout="stacked" label="Anything to add" htmlFor="quote-reply">
              <Textarea
                id="quote-reply"
                value={reply}
                rows={2}
                maxLength={MAX_REPLY}
                placeholder="Optional"
                onChange={(event) => setReply(event.target.value)}
              />
            </Field>

            {sheetError ? <FieldError className="mt-8">{sheetError}</FieldError> : null}
          </SheetBody>
          <SheetFooter className={SHEET_COLUMN}>
            <Button
              type="button"
              trailingArrow
              loading={answer.isPending}
              onClick={() => answering && answer.mutate(answering)}
            >
              {answering === "decline" ? "Decline" : "Accept"}
            </Button>
            {/* Through the sheet's own close, so the reply and any refusal
                reset with it rather than surviving into the next answer. */}
            <Button type="button" variant="text" onClick={() => closeAnswer()}>
              Cancel
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
