import * as React from "react"
import { Handshake } from "lucide-react"
import { applyPercent } from "@gg/shared/money"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"
import { Money, MoneyInput, Panel, PercentStepper, Segmented } from "@/ui"

type Payout = "cash" | "credit"

/** A placeholder that already shows the kit pieces a deal is built from. */
export function NewDealPage() {
  const [payout, setPayout] = React.useState<Payout>("credit")
  const [market, setMarket] = React.useState<number | null>(1000)
  const [cashRate, setCashRate] = React.useState(50)
  const [creditRate, setCreditRate] = React.useState(65)
  const rate = payout === "cash" ? cashRate : creditRate
  const offer = applyPercent(market ?? 0, rate)

  return (
    <FeaturePlaceholder
      eyebrow="Buy-in"
      title="New deal"
      lede="Build an offer line by line, then pay in cash or trade credit."
      icon={<Handshake aria-hidden />}
      plans={[
        "Add cards from Scan or Cards",
        "Per-line condition and buy rate",
        "Cash needs ID on file first",
      ]}
    >
      <Panel className="flex flex-col gap-4">
        <Segmented<Payout>
          label="Pay out as"
          block
          tone={payout === "credit" ? "pop" : "volt"}
          value={payout}
          onChange={setPayout}
          options={[
            { value: "credit", label: "Trade credit" },
            { value: "cash", label: "Cash" },
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyInput label="Market value" value={market} onChange={setMarket} />
          {payout === "cash" ? (
            <PercentStepper label="Cash rate" value={cashRate} onChange={setCashRate} />
          ) : (
            <PercentStepper label="Credit rate" tone="pop" value={creditRate} onChange={setCreditRate} />
          )}
        </div>
        <div className="flex items-baseline justify-between border-t border-line pt-4">
          <span className="label-mono text-fg-2">Offer</span>
          <Money pence={offer} tween size="xl" tone={payout === "credit" ? "pop" : "volt"} />
        </div>
      </Panel>
    </FeaturePlaceholder>
  )
}
