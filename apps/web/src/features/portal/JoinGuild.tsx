/**
 * Joining the GG Guild from My Vault (docs/api-contract-launch.md, section
 * 2: "asks for the Guild's terms and joins on acceptance").
 *
 * A customer who signed in but has not joined reads the terms the shop
 * wrote, agrees to them with one switch, says whether they want offers and
 * news with another, and joins with the screen's one block button. The
 * terms are the shop's own words, shown as text and never as markup.
 */

import { SectionHeading } from "@/components/ui/micro-label"
import { Switch } from "@/components/ui/switch"
import { Note } from "@/features/portal/Note"

export interface JoinGuildBlockProps {
  terms: string
  welcomeBonus: number
  agreed: boolean
  onAgreed: (agreed: boolean) => void
  offers: boolean
  onOffers: (offers: boolean) => void
  error: string | null
}

export function JoinGuildBlock({
  terms,
  welcomeBonus,
  agreed,
  onAgreed,
  offers,
  onOffers,
  error,
}: JoinGuildBlockProps) {
  return (
    <div data-testid="join-guild" className="mt-12">
      <SectionHeading className="mt-0">Join the Guild</SectionHeading>
      <p className="max-w-[48ch] text-base leading-[1.5] text-foreground">
        {welcomeBonus > 0
          ? `Join to earn points on everything you buy and sell us. You start with ${welcomeBonus.toLocaleString("en-GB")} points.`
          : "Join to earn points on everything you buy and sell us."}
      </p>
      {terms.trim() ? (
        <div className="mt-6 max-h-60 overflow-y-auto border-y border-hairline-soft py-4">
          <p
            data-testid="guild-terms"
            className="max-w-[52ch] text-[15px] leading-[1.5] whitespace-pre-line text-muted-foreground"
          >
            {terms}
          </p>
        </div>
      ) : null}
      <div className="mt-6 flex flex-col gap-5">
        <div className="flex items-start gap-4">
          <Switch
            checked={agreed}
            onCheckedChange={(next: boolean) => onAgreed(next)}
            aria-label="I agree to the Guild terms"
          />
          <p className="text-[15px] leading-[1.5] text-foreground">I agree to the Guild terms.</p>
        </div>
        <div className="flex items-start gap-4">
          <Switch
            checked={offers}
            onCheckedChange={(next: boolean) => onOffers(next)}
            aria-label="Send me offers and news"
          />
          <p className="text-[15px] leading-[1.5] text-muted-foreground">
            Send me offers and news. You can change this in Me at any time.
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-4 max-w-[48ch] text-[13px] leading-[1.45] text-destructive">
          {error}
        </p>
      ) : (
        <Note className="mt-4">{agreed ? "" : "Agree to the terms to join."}</Note>
      )}
    </div>
  )
}
