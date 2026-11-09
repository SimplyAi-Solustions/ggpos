import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { makeItem } from "../lib/fixtures"
import { toPages } from "../lib/item-view"
import { QuickViewSheet } from "./QuickViewSheet"

describe("QuickViewSheet", () => {
  const item = makeItem({
    title: "Charizard ex",
    sku: "GGSY1YP8E",
    set_code: "sv3pt5",
    number: "199",
    finish: "holofoil",
    condition: "LP",
    price: 34999,
    cost: 21000,
    market: 32050,
    qty: 2,
    location_name: "Cabinet A",
    image: "/c.png",
  })

  it("shows the card art and the key figures", () => {
    render(<QuickViewSheet item={item} open onClose={() => {}} onOpenItem={() => {}} />)
    const dialog = screen.getByRole("dialog", { name: "Charizard ex" })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Charizard ex 199" })).toHaveAttribute("data-finish", "holo")
    expect(screen.getByText("£349.99")).toBeInTheDocument()
    expect(screen.getByText("£320.50")).toBeInTheDocument()
    expect(screen.getByText("£210.00")).toBeInTheDocument()
    expect(screen.getByText("40%")).toBeInTheDocument()
    expect(screen.getByText("Market, LP")).toBeInTheDocument()
    expect(screen.getByText("Holo")).toBeInTheDocument()
    expect(screen.getByText("Qty 2")).toBeInTheDocument()
    expect(screen.getByText("Cabinet A")).toBeInTheDocument()
  })

  it("opens the full item page", async () => {
    const onOpenItem = vi.fn()
    render(<QuickViewSheet item={item} open onClose={() => {}} onOpenItem={onOpenItem} />)
    await userEvent.click(screen.getByRole("button", { name: "Open item" }))
    expect(onOpenItem).toHaveBeenCalledWith(item)
  })

  it("says so when there is no sticker or market price", () => {
    render(
      <QuickViewSheet item={makeItem({ title: "Loose cart", kind: "retro", price: 0, market: null, location_name: "" })} open onClose={() => {}} onOpenItem={() => {}} />
    )
    expect(screen.getByText("No price")).toBeInTheDocument()
    expect(screen.getByText("None on file")).toBeInTheDocument()
    expect(screen.getByText("Not shelved")).toBeInTheDocument()
  })

  it("renders nothing while closed", () => {
    render(<QuickViewSheet item={item} open={false} onClose={() => {}} onOpenItem={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("toPages", () => {
  it("splits stock into binder pages of nine", () => {
    const pages = toPages(Array.from({ length: 20 }, (_, i) => i))
    expect(pages.map((p) => p.length)).toEqual([9, 9, 2])
    expect(toPages([])).toEqual([])
  })
})
