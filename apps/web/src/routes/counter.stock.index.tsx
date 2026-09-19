import { createFileRoute, Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { StickerCards } from "@/components/ui/sticker"

/**
 * The saved views, filters and bulk actions arrive with the stock screens.
 * Until then the list is the empty state, which is the screen staff will see
 * on the first morning anyway.
 */
function StockList() {
  return (
    <section className="pt-16 sm:pt-24">
      <PageTitle>Stock</PageTitle>
      <Lede>Every card, cart and box we hold, priced and findable.</Lede>

      <div className="mt-24 flex flex-col items-start gap-6">
        <StickerCards />
        <p className="max-w-[44ch] text-base leading-[1.5] text-muted-foreground">
          Nothing is in stock yet. Add the first item and it will show up here with
          its code, its price and where it sits.
        </p>
        <Button render={<Link to="/counter/stock/new" />} trailingArrow>
          Add stock
        </Button>
      </div>
    </section>
  )
}

export const Route = createFileRoute("/counter/stock/")({
  component: StockList,
})
