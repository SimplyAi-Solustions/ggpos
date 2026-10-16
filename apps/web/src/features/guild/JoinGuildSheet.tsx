/**
 * Joining the GG Guild at the counter (docs/api-contract-launch.md, section
 * 2): one sheet for the till and the customer page.
 *
 * For somebody on file it is the consent and one tap: they agree to the
 * Guild terms, say whether they want offers and news, and "Join the Guild"
 * does the rest. For somebody new it is the same with a name and an email or
 * a phone number above it, and the card is made and joined in one step. The
 * route's refusals land under the form in its own words; the one with more
 * in it, an email or phone already on another customer, offers that
 * customer instead of a second card.
 */
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { refusalOrFallback } from "@/lib/api/refusal"
import {
  clashCustomer,
  joinGuild,
  type GuildJoinCustomer,
  type GuildJoinResult,
} from "@/lib/api/guild-join"
import { joinIntro, seedFromQuery } from "@/features/guild/words"

export interface JoinGuildSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Somebody on file who has not joined, or null to make a new customer. */
  customer: { id: string; name: string; marketingConsent?: boolean } | null
  /** What was typed into the customer search, as a new customer's name. */
  initialName?: string
  /** The programme's welcome bonus, for the sentence at the top. */
  welcomeBonus: number
  onJoined: (result: GuildJoinResult) => void
  /**
   * The customer who already holds the email or phone typed, from the
   * route's 409. The till attaches them; the customer page opens them.
   */
  onUseExisting?: (customer: GuildJoinCustomer) => void
  /** The words for that action, for example "Attach Jo Bloggs instead". */
  existingLabel?: (customer: GuildJoinCustomer) => string
}

function JoinForm({
  customer,
  initialName,
  welcomeBonus,
  onJoined,
  onUseExisting,
  existingLabel,
  onCancel,
}: Omit<JoinGuildSheetProps, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const [seed] = React.useState(() => seedFromQuery(initialName ?? ""))
  const [name, setName] = React.useState(seed.name)
  const [email, setEmail] = React.useState(seed.email)
  const [phone, setPhone] = React.useState(seed.phone)
  const [agreed, setAgreed] = React.useState(false)
  const [offers, setOffers] = React.useState(customer?.marketingConsent === true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [existing, setExisting] = React.useState<GuildJoinCustomer | null>(null)

  async function submit(event?: React.FormEvent) {
    event?.preventDefault()
    if (!agreed || busy) return
    setBusy(true)
    setError(null)
    setExisting(null)
    try {
      const result = await joinGuild(
        customer
          ? { customer: customer.id, marketing_consent: offers }
          : {
              name: name.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
              marketing_consent: offers,
            }
      )
      onJoined(result)
    } catch (cause) {
      setError(refusalOrFallback(cause, "They did not join. Check the connection and try again."))
      setExisting(clashCustomer(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="Join the Guild" className="contents">
      <SheetBody>
        <div className="flex flex-col gap-8">
          {customer ? null : (
            <>
              <Field label="Name" htmlFor="join-name" layout="stacked">
                <Input
                  id="join-name"
                  autoComplete="off"
                  placeholder="First and last name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field label="Email" htmlFor="join-email" layout="stacked" hint="Or a phone">
                <Input
                  id="join-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="name@example.co.uk"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>
              <Field label="Phone" htmlFor="join-phone" layout="stacked" hint="Or an email">
                <Input
                  id="join-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="07700 900123"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </Field>
            </>
          )}

          <div className="flex items-start gap-4">
            <Switch
              checked={agreed}
              onCheckedChange={(next: boolean) => setAgreed(next)}
              aria-label="They agree to the Guild terms"
            />
            <p className="max-w-[48ch] text-[15px] leading-[1.5] text-foreground">
              They have heard the Guild terms and agree to them.
            </p>
          </div>
          <div className="flex items-start gap-4">
            <Switch
              checked={offers}
              onCheckedChange={(next: boolean) => setOffers(next)}
              aria-label="Send them offers and news"
            />
            <p className="max-w-[48ch] text-[15px] leading-[1.5] text-muted-foreground">
              Send offers and news. Leave it off unless they asked.
            </p>
          </div>

          {error ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="max-w-[48ch] text-[13px] leading-[1.45] text-destructive">{error}</p>
              {existing && onUseExisting ? (
                <Button variant="text" type="button" onClick={() => onUseExisting(existing)}>
                  {existingLabel ? existingLabel(existing) : `Open ${existing.name}`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          type="submit"
          trailingArrow
          loading={busy}
          disabled={!agreed}
          data-testid="join-guild-submit"
        >
          Join the Guild
        </Button>
        <Button variant="text" type="button" onClick={onCancel}>
          Cancel
        </Button>
        {!agreed ? (
          <p className="text-[13px] leading-[1.45] text-muted-foreground-2">
            {welcomeBonus > 0
              ? `Tick the terms to join. ${joinIntro(welcomeBonus)}`
              : "Tick the terms to join."}
          </p>
        ) : null}
      </SheetFooter>
    </form>
  )
}

export function JoinGuildSheet({ open, onOpenChange, ...props }: JoinGuildSheetProps) {
  const { customer } = props
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader>
          <SheetTitle>Join the Guild</SheetTitle>
          <SheetDescription>
            {customer
              ? `${customer.name} joins the GG Guild. Their card and code stay the same.`
              : "A new customer joins the GG Guild. A name and an email or a phone number are enough."}
          </SheetDescription>
        </SheetHeader>
        {open ? <JoinForm {...props} onCancel={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}
