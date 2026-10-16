import { Switch } from "@/components/ui/switch"
import { PRIVACY_SENTENCE } from "@/features/customers/format"

/**
 * The buy-in terms the customer agrees to before they sign: the items are
 * theirs to sell, and how their details are kept. One switch and one
 * sentence, on the wizard's Offer step and on the till's part-exchange.
 */
export function TradeTerms({
  accepted,
  onChange,
}: {
  accepted: boolean
  onChange: (accepted: boolean) => void
}) {
  return (
    <div className="flex items-start gap-4">
      <Switch
        checked={accepted}
        onCheckedChange={onChange}
        aria-label="The customer has heard the terms and agrees to them"
      />
      <p className="max-w-[56ch] text-[15px] leading-[1.5] text-muted-foreground">
        The customer confirms the items are theirs to sell and agrees to the
        buy-in terms. {PRIVACY_SENTENCE}
      </p>
    </div>
  )
}
