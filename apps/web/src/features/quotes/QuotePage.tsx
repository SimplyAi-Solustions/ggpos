/**
 * One quote, from the photos to the draft buy-in.
 *
 * The page is the queue's whole job in order: look at what was sent, say you
 * have picked it up, put it into lines and price them, send the offer, talk
 * to the customer while they think, and turn an accepted quote into a draft
 * buy-in the moment the items are on the counter.
 *
 * The lines are the buy-in wizard's own: `ItemsStep` with the same line row,
 * the same price sources and the same override sheet, so a remote quote is
 * priced by exactly the machinery a counter buy-in is priced by. Only the
 * shape of what is sent differs, which is `offer.ts`.
 *
 * Nothing here decides a status for itself: every action posts to its route
 * and the page reads the record back, so what is on screen is what the
 * server holds even when somebody at the other till got there first.
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { formatGBP } from "@gg/shared"
import { DEFAULT_OFFER_SETTINGS } from "@gg/shared/pricing"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
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
import { useCounterDock } from "@/app/counter-dock"
import { ItemsStep } from "@/features/tradein/steps/ItemsStep"
import { totals, type TradeLine } from "@/features/tradein/machine"
import { PhotoViewer } from "@/features/quotes/PhotoViewer"
import {
  canCancel,
  canOffer,
  offerHasExpired,
  showsQuoteMessage,
} from "@/features/quotes/filters"
import {
  DROP_OFF_LABEL,
  QUOTE_STATUS_LABEL,
  QUOTE_STATUS_NOTE,
  formatDate,
  formatDateTime,
} from "@/features/quotes/format"
import { offerProblem, quoteOfferTotal, toQuoteLines } from "@/features/quotes/offer"
import { offerSettingsFrom, rulesFrom, useVaultConfig } from "@/lib/api"
// Straight from the module rather than through the barrel, which the counter
// shell imports: Phase 4 and Phase 5's own modules stay out of the entry
// chunk (see the note in lib/api/index.ts).
import {
  cancelQuote,
  getStaffQuote,
  markQuoteReceived,
  markQuoteReviewing,
  quoteQueueQuery,
  sendQuoteOffer,
  sendStaffQuoteMessage,
} from "@/lib/api/quotes"
import { usePricingSettings } from "@/lib/api/prices"
import { refusalOrFallback } from "@/lib/api/refusal"

const MAX_MESSAGE = 2000

/** One line of an offer that has already gone out. */
function OfferedLine({
  title,
  detail,
  qty,
  total,
}: {
  title: string
  detail: string
  qty: number
  total: number
}) {
  return (
    <li className="flex items-baseline justify-between gap-6 border-b border-hairline-soft py-3 first:border-t">
      <span className="min-w-0">
        <span className="block text-[15px] leading-[1.4] text-foreground">
          {title}
          {qty > 1 ? <span className="text-muted-foreground-2"> x{qty}</span> : null}
        </span>
        {detail ? (
          <span className="mt-1 block text-[13px] text-muted-foreground-2">{detail}</span>
        ) : null}
      </span>
      <span className="tnum shrink-0 text-[15px] font-medium text-foreground">
        {formatGBP(total)}
      </span>
    </li>
  )
}

export function QuotePage({ id }: { id: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const dock = useCounterDock()

  const [lines, setLines] = React.useState<TradeLine[]>([])
  const [note, setNote] = React.useState("")
  const [reply, setReply] = React.useState("")
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ["quote", id],
    queryFn: () => getStaffQuote(id),
    // Re-read every time it is opened: somebody at the other till may have
    // offered on it while this tab was elsewhere.
    staleTime: 0,
  })

  const { data: config, isSuccess: configLoaded } = useVaultConfig()
  const rules = React.useMemo(() => (config ? rulesFrom(config) : []), [config])
  const { conditionMultipliers } = usePricingSettings()
  const settings = React.useMemo(
    () =>
      config
        ? offerSettingsFrom(config)
        : { ...DEFAULT_OFFER_SETTINGS, cashCap: 800_000 },
    [config]
  )
  const sums = totals(lines, rules, settings, conditionMultipliers)

  const addLine = React.useCallback(
    (line: TradeLine) => setLines((current) => [...current, line]),
    []
  )
  const updateLine = React.useCallback(
    (key: string, patch: Partial<TradeLine>) =>
      setLines((current) =>
        current.map((line) => (line.key === key ? { ...line, ...patch } : line))
      ),
    []
  )
  const removeLine = React.useCallback(
    (key: string) => setLines((current) => current.filter((line) => line.key !== key)),
    []
  )

  const settle = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["quote", id] }),
      queryClient.invalidateQueries({ queryKey: quoteQueueQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["quotes-waiting"] }),
    ])
  }, [id, queryClient])

  const reviewing = useMutation({
    mutationFn: () => markQuoteReviewing(id),
    onSuccess: () => {
      setError(null)
      void settle()
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That did not save. Check the connection and try again.")
      ),
  })

  const offer = useMutation({
    mutationFn: () =>
      sendQuoteOffer(
        id,
        toQuoteLines(lines, rules, settings, conditionMultipliers),
        note
      ),
    onSuccess: () => {
      setError(null)
      setLines([])
      setNote("")
      void settle()
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(
          cause,
          "That offer did not send. Check the connection and press it again."
        )
      ),
  })

  const message = useMutation({
    mutationFn: () => sendStaffQuoteMessage(id, reply.trim()),
    onSuccess: () => {
      setError(null)
      setReply("")
      void settle()
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That message did not send. Try again in a moment.")
      ),
  })

  const received = useMutation({
    mutationFn: () => markQuoteReceived(id),
    onSuccess: async (result) => {
      setError(null)
      await settle()
      await navigate({ to: "/counter/trade/$id", params: { id: result.trade_in_id } })
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(
          cause,
          "That buy-in was not started. Check the connection and press it again."
        )
      ),
  })

  const cancel = useMutation({
    mutationFn: () => cancelQuote(id, reason.trim()),
    onSuccess: () => {
      setError(null)
      setCancelOpen(false)
      setReason("")
      void settle()
    },
    onError: (cause) =>
      setError(
        refusalOrFallback(cause, "That quote was not cancelled. Try again in a moment.")
      ),
  })

  if (isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <SkeletonText lines={6} />
      </section>
    )
  }

  if (!data) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>No such quote</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          That quote is not on file. It may have been sent by a customer who has
          since been erased.
        </p>
        <div className="mt-10">
          <Button render={<Link to="/counter/quotes" />} trailingArrow>
            Back to quotes
          </Button>
        </div>
      </section>
    )
  }

  const { quote, messages, photos, customer, tradeInId } = data
  const status = quote.status ?? "submitted"
  const offering = canOffer(status)
  const offerLines = quote.lines ?? []
  const expired = offerHasExpired(quote.offer_expires_at)
  const customerReply = quote.customer_reply || quote.reply || ""
  const draft = toQuoteLines(lines, rules, settings, conditionMultipliers)
  const problem = offerProblem(draft)

  /**
   * The one block button, which is whatever this quote needs next: an offer
   * while it is still ours to price, the buy-in once the items are here, and
   * the draft itself once it has one. A quote waiting on the customer needs
   * nothing from us, so it shows none.
   */
  function primary(full: boolean) {
    const className = full ? "w-full" : undefined
    if (offering) {
      return (
        <Button
          type="button"
          trailingArrow
          className={className}
          loading={offer.isPending}
          onClick={() => {
            if (problem) {
              setError(problem)
              return
            }
            setError(null)
            offer.mutate()
          }}
        >
          Send the offer
        </Button>
      )
    }
    if (status === "accepted") {
      return (
        <Button
          type="button"
          trailingArrow
          className={className}
          loading={received.isPending}
          onClick={() => received.mutate()}
        >
          Mark as received
        </Button>
      )
    }
    if (tradeInId) {
      return (
        <Button
          type="button"
          trailingArrow
          className={className}
          onClick={() =>
            void navigate({ to: "/counter/trade/$id", params: { id: tradeInId } })
          }
        >
          Open the buy-in
        </Button>
      )
    }
    return null
  }

  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Quote</PageTitle>
      <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
        {customer ? (
          <>
            {customer.code ? (
              <Link
                to="/counter/customers/$code"
                params={{ code: customer.code }}
                className="text-foreground underline-offset-4 outline-none hover:underline"
              >
                {customer.name || "This customer"}
              </Link>
            ) : (
              <span className="text-foreground">{customer.name || "This customer"}</span>
            )}
            {customer.code ? (
              <>
                {" "}
                <span className="tnum font-mono text-[13px]">{customer.code}</span>
              </>
            ) : null}
            , sent {formatDate(quote.created)}
          </>
        ) : (
          <>Sent {formatDate(quote.created)}</>
        )}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Badge variant="outline" data-testid="quote-status">
          {QUOTE_STATUS_LABEL[status]}
        </Badge>
        <span className="text-[13px] leading-[1.45] text-muted-foreground">
          {QUOTE_STATUS_NOTE[status]}
        </span>
        {quote.drop_off ? <Hint>{DROP_OFF_LABEL[quote.drop_off]}</Hint> : null}
        {status === "submitted" ? (
          <Button
            variant="text"
            type="button"
            loading={reviewing.isPending}
            onClick={() => reviewing.mutate()}
          >
            Mark as reviewing
          </Button>
        ) : null}
      </div>

      {/* ---- The photos ------------------------------------------------- */}
      <section aria-label="Photos">
        <SectionHeading className="mt-14">Photos</SectionHeading>
        <PhotoViewer photos={photos} />
      </section>

      {showsQuoteMessage(quote.message, messages) ? (
        <section aria-label="What they said">
          <SectionHeading className="mt-14">What they said</SectionHeading>
          <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
            {quote.message}
          </p>
        </section>
      ) : null}

      {/* ---- Identifying it into lines ----------------------------------- */}
      {offering ? (
        <section aria-label="Identify">
          <SectionHeading className="mt-14">Identify</SectionHeading>
          <p className="mb-8 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground-2">
            Put a line on for each thing in the photos. The offer sent is the
            cash figure; store credit is worked out again when the items are on
            the counter, and is never lower.
          </p>

          <ItemsStep
            lines={lines}
            rules={rules}
            settings={settings}
            multipliers={conditionMultipliers}
            sums={sums}
            rulesMissing={configLoaded && rules.length === 0}
            onAdd={addLine}
            onUpdate={updateLine}
            onRemove={removeLine}
            saveError={null}
          />

          <div className="mt-12">
            <Field label="With the offer" htmlFor="quote-note" layout="stacked">
              <Textarea
                id="quote-note"
                rows={2}
                maxLength={MAX_MESSAGE}
                value={note}
                placeholder="Anything the customer should know before they answer"
                trailingHint={`${note.length} / ${MAX_MESSAGE}`}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            {draft.length > 0 ? (
              <p className="mt-4 flex flex-wrap items-baseline gap-3">
                <MicroLabel>Offer to send</MicroLabel>
                <span
                  data-testid="quote-offer-draft"
                  className="tnum text-[20px] leading-none font-medium text-foreground"
                >
                  {formatGBP(quoteOfferTotal(draft))}
                </span>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-8 max-w-[56ch] text-[13px] text-destructive">
                {error}
              </p>
            ) : null}
            <div className="mt-10 hidden min-[900px]:block">{primary(false)}</div>
          </div>
        </section>
      ) : null}

      {/* ---- The offer, once it has gone out ----------------------------- */}
      {!offering && offerLines.length > 0 ? (
        <section aria-label="The offer">
          <SectionHeading className="mt-14">The offer</SectionHeading>
          <p
            data-testid="quote-offer-total"
            className="tnum font-display text-[28px] leading-none tracking-[0.01em] text-foreground"
          >
            {formatGBP(quote.offer_total ?? quoteOfferTotal(offerLines))}
          </p>
          {quote.offer_expires_at && (status === "offered" || status === "expired") ? (
            <p className="mt-3 text-[13px] leading-[1.45] text-muted-foreground">
              {expired
                ? `Ran out on ${formatDate(quote.offer_expires_at)}`
                : `Holds until ${formatDateTime(quote.offer_expires_at)}`}
            </p>
          ) : null}

          <ul className="mt-8">
            {offerLines.map((line, at) => (
              <OfferedLine
                key={`${line.title}-${at}`}
                title={line.title}
                detail={[
                  line.condition,
                  line.finish,
                  line.market_price
                    ? `market ${formatGBP(line.market_price)}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                qty={line.qty}
                total={line.offer_price * line.qty}
              />
            ))}
          </ul>

          {customerReply ? (
            <div className="mt-8">
              <MicroLabel className="mb-2">Their reply</MicroLabel>
              <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
                {customerReply}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---- The thread --------------------------------------------------- */}
      <section aria-label="Messages">
        <SectionHeading className="mt-14">Messages</SectionHeading>
        {messages.length === 0 ? (
          <p className="text-[15px] leading-[1.5] text-muted-foreground-2">
            Nothing said yet. Ask for another photo, or say when you will have
            looked at it.
          </p>
        ) : (
          <ul data-testid="quote-thread" className="flex flex-col gap-6">
            {messages.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1.5">
                <MicroLabel>
                  {entry.author === "staff" ? "The counter" : customer?.name || "Customer"}
                </MicroLabel>
                <p className="max-w-[56ch] text-[15px] leading-[1.5] text-foreground">
                  {entry.body}
                </p>
                <Hint>{formatDateTime(entry.created)}</Hint>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-10">
          <Field label="Reply" htmlFor="quote-reply" layout="stacked">
            <Textarea
              id="quote-reply"
              rows={2}
              maxLength={MAX_MESSAGE}
              value={reply}
              placeholder="The customer gets this by email"
              trailingHint={`${reply.length} / ${MAX_MESSAGE}`}
              onChange={(event) => setReply(event.target.value)}
            />
          </Field>
          <div className="mt-6">
            <Button
              variant="text"
              type="button"
              loading={message.isPending}
              disabled={reply.trim().length === 0}
              onClick={() => message.mutate()}
            >
              Send message
            </Button>
          </div>
        </div>
      </section>

      {error && !offering ? (
        <p role="alert" className="mt-10 max-w-[56ch] text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      {/* ---- The one action, and the two links ---------------------------- */}
      <div className="mt-14 hidden flex-wrap items-center gap-8 min-[900px]:flex">
        {offering ? null : primary(false)}
        <Button variant="text" render={<Link to="/counter/quotes" />}>
          Back to quotes
        </Button>
        {canCancel(status) ? (
          <Button
            variant="text-destructive"
            type="button"
            onClick={() => setCancelOpen(true)}
          >
            Cancel this quote
          </Button>
        ) : null}
      </div>

      <div className="mt-14 flex flex-wrap items-center gap-8 min-[900px]:hidden">
        <Button variant="text" render={<Link to="/counter/quotes" />}>
          Back to quotes
        </Button>
        {canCancel(status) ? (
          <Button
            variant="text-destructive"
            type="button"
            onClick={() => setCancelOpen(true)}
          >
            Cancel this quote
          </Button>
        ) : null}
      </div>

      {dock
        ? createPortal(
            primary(true) ? (
              <div className="border-t border-hairline-soft bg-background px-5 py-3">
                {primary(true)}
              </div>
            ) : null,
            dock
          )
        : null}

      <Sheet
        open={cancelOpen}
        onOpenChange={(next) => {
          if (!next) setCancelOpen(false)
        }}
      >
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>Cancel this quote</SheetTitle>
            <SheetDescription>
              The customer is told, and gets your note. They can send new photos
              any time.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <Field label="Why" htmlFor="quote-cancel-reason" layout="stacked">
              <Textarea
                id="quote-cancel-reason"
                rows={3}
                maxLength={MAX_MESSAGE}
                value={reason}
                placeholder="Not something we buy at the moment"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              trailingArrow
              loading={cancel.isPending}
              disabled={reason.trim().length === 0}
              onClick={() => cancel.mutate()}
            >
              Cancel the quote
            </Button>
            <Button variant="text" type="button" onClick={() => setCancelOpen(false)}>
              Keep it open
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  )
}
