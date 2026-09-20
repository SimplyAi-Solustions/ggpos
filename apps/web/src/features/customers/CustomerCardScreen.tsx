import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { displayCode } from "@gg/shared"

import { Button } from "@/components/ui/button"
import { Chip, ChipGroup } from "@/components/ui/chip"
import { MicroLabel } from "@/components/ui/micro-label"
import { PageTitle } from "@/components/ui/page-title"
import { SkeletonText } from "@/components/ui/skeleton"
import { PrintControls, PrintSheet } from "@/components/print/print-sheet"
import { printPage } from "@/components/print/print"
import {
  GuildCardBack,
  GuildCardFront,
  type GuildCardSize,
} from "@/features/customers/GuildCard"
import { portalLink } from "@/features/customers/format"
import { getCustomer } from "@/lib/api"

const SIZE_LABEL: Record<GuildCardSize, string> = {
  label: "80 x 50 mm label",
  wallet: "Wallet card",
}

/**
 * The card as it comes out of the printer.
 *
 * Two pages: the front with the QR, and the pinstripe back for anyone
 * printing on double-sided stock. `@page` is set from the chosen size, so the
 * counter PC's kiosk printing sends it straight to the T003 with no dialog
 * and nothing else on the sheet.
 */
export function CustomerCardScreen({ code }: { code: string }) {
  const navigate = useNavigate()
  const [size, setSize] = React.useState<GuildCardSize>("label")

  const { data: profile, isPending } = useQuery({
    queryKey: ["customer", code],
    queryFn: () => getCustomer(code),
  })

  if (isPending) {
    return (
      <section className="pt-16 sm:pt-24">
        <SkeletonText lines={4} />
      </section>
    )
  }

  if (!profile) {
    return (
      <section className="pt-16 sm:pt-24">
        <PageTitle>No such customer</PageTitle>
        <p className="mt-4 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          {displayCode(code)} does not match a card. Check the code, or search
          by name.
        </p>
      </section>
    )
  }

  const { customer } = profile
  const tier = profile.private?.tier || "Member"

  return (
    <section className="pt-16 sm:pt-24">
      <div data-print-hide="">
        <PageTitle>Guild card</PageTitle>
        <p className="mt-3 max-w-[56ch] text-base leading-[1.5] text-muted-foreground">
          {customer.name}, {displayCode(customer.code)}. The QR opens their
          portal.
        </p>

        <div className="mt-10">
          <MicroLabel className="mb-3">Size</MicroLabel>
          <ChipGroup
            aria-label="Card size"
            value={[size]}
            onValueChange={(next) => {
              if (next[0]) setSize(next[0] as GuildCardSize)
            }}
          >
            {(Object.keys(SIZE_LABEL) as GuildCardSize[]).map((option) => (
              <Chip key={option} value={option}>
                {SIZE_LABEL[option]}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      </div>

      <PrintSheet size={size === "label" ? "card80x50" : "wallet"} className="mt-12">
        <div className="flex flex-wrap items-start gap-10 print:block">
          <GuildCardFront
            name={customer.name}
            code={customer.code}
            qrToken={customer.qr_token}
            tier={tier}
            size={size}
          />
          {/* The second printed page: the pinstripe back. */}
          <GuildCardBack size={size} className="break-before-page" />
        </div>
      </PrintSheet>

      <PrintControls className="mt-14">
        <Button type="button" trailingArrow onClick={printPage}>
          Print
        </Button>
        <Button
          variant="text"
          type="button"
          onClick={() =>
            void navigate({
              to: "/counter/customers/$code",
              params: { code: customer.code },
            })
          }
        >
          Back to profile
        </Button>
        {/* Lower case on purpose: a link is not a label, and a tracked
            uppercase run this long is unreadable. */}
        <span className="font-mono text-[13px] leading-[1.4] break-all text-muted-foreground-2">
          {portalLink(customer.qr_token)}
        </span>
      </PrintControls>
    </section>
  )
}
