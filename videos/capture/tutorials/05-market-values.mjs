/**
 * Tutorial 5: getting market values. Price check on the Scan screen, reading
 * where the value comes from and the shop's offer, how condition changes it,
 * adding a UK sold price with its eBay link, Search eBay sold, Ask an agent
 * (Gandalf), and a retro game looked up on the Buy-in screen.
 */
import { session } from "../lib.mjs"

// A code from the demo shop's customers: Jasmine Okafor, a Guild member.
const JASMINE = "GGC-4K7M2S"

export default async function capture({ baseURL }) {
  const t = await session(
    {
      slug: "market-values",
      number: 5,
      title: "Getting market values",
      subtitle: "How to find out what a card or a retro game is worth, and what the shop would offer for it.",
      outline: [
        "Price check a card without adding it to stock",
        "Read the value, where it came from and the offer",
        "See how condition changes the value",
        "Add a UK sold price, search eBay or ask an agent",
        "Look up a retro game",
      ],
      next: null,
    },
    { baseURL }
  )
  const { page, step, show } = t
  await t.signIn()

  const source = (key) => page.locator(`[data-testid="price-source"][data-source="${key}"]`)
  const finishChips = () => page.locator('[data-slot="chip-group"][aria-label="Finish"]')
  const sheet = () => page.getByRole("dialog")
  const line = () => page.getByTestId("trade-line")

  // --- Price check ----------------------------------------------------------
  await step("A customer asks what a card is worth. From the home screen, open Scan.", page.getByRole("link", { name: "Scan", exact: true }).filter({ visible: true }).first(), {
    section: "Price check",
    zoom: true,
    then: () => page.getByRole("heading", { name: "Scan" }).waitFor(),
  })
  await step("Scan is for item codes and cards. Choose Price check to look a card up without adding anything to stock.", page.getByRole("button", { name: "Price check", exact: true }), {
    zoom: true,
    then: () => page.getByText("Nothing is added to stock.").waitFor(),
  })
  await step("Type the set and number, like sv151 199, or the card's name, then press Enter.", page.getByTestId("scan-field"), {
    action: "type",
    value: "sv151 199",
    zoom: true,
    then: async () => {
      await page.getByTestId("scan-field").press("Enter")
      await page.getByTestId("price-check-hit").first().waitFor()
    },
  })
  await step("Pick the right card from the matches.", page.getByTestId("price-check-hit").first(), {
    zoom: true,
    then: () => page.getByTestId("price-check-market").waitFor(),
  })

  // --- Where the value comes from -------------------------------------------
  await show(
    "Here is the card and its market value in pounds. The shop's offer is worked out from this figure.",
    page.getByTestId("price-check-name").locator("xpath=.."),
    { section: "Where it comes from", zoom: true }
  )
  await show(
    "The value is for one finish at a time. Normal is chosen here, so choose holo if the customer's card is holo.",
    finishChips(),
    { zoom: true }
  )
  await show(
    "Under Sources, the shop tries four places in order. First is a UK sold price that staff have entered, and this card has none.",
    source("uk_sold_manual"),
    { zoom: true }
  )
  await show(
    "Second is eBay UK asking prices, with 15% taken off. It is marked Stale, which means it is too old to use.",
    source("ebay_uk_asking"),
    { zoom: true }
  )
  await show(
    "Third is Cardmarket. It is the first fresh figure, so it is marked Chosen. It is priced in euros, so the pounds come first, with the euro price and the rate underneath.",
    source("cardmarket"),
    { zoom: true, hold: 9 }
  )
  await show(
    "Last is TCGplayer, priced in dollars and converted to pounds the same way. It is only used when the sources above have nothing fresh.",
    source("tcgplayer"),
    { zoom: true }
  )
  await show(
    "Check how old a figure is. Each line ends with a date, Stale marks one that is too old, and a note warns when the exchange rate is old. Press Refresh for newer prices.",
    page.getByTestId("price-sources"),
    { hold: 9 }
  )

  // --- The offer and condition ---------------------------------------------
  await show(
    "What we would offer is the shop's price for this card. Cash is what you would pay out, and Credit is what you would give as store credit.",
    page.getByTestId("price-check").locator("table"),
    { section: "The offer", hold: 7 }
  )
  await show(
    "A near-mint card, NM, is worth the full market value of £253.02. The shop would offer £152.00 in cash or £190.00 in credit.",
    page.getByTestId("offer-NM"),
    { zoom: true }
  )
  await show(
    "Each row down is a worse condition, and the value and both offers fall with it. A damaged card, DMG, is worth £75.91, so the offer is £45.50 cash or £57.00 credit.",
    page.getByTestId("price-check").locator("table"),
    { hold: 9 }
  )
  await show(
    "In stock shows whether the shop already holds this card. Here there is one holo copy at £324.99.",
    page.getByTestId("price-check-stock"),
    { zoom: true }
  )

  // --- Add a UK sold price ---------------------------------------------------
  await step("If you have checked what it really sold for in the UK, press Add UK comp. It then leads the other sources.", page.getByRole("button", { name: "Add UK comp" }), {
    section: "Add a UK sold price",
    zoom: true,
    then: () => sheet().waitFor(),
  })
  await step("Type what a near-mint copy sold for on ebay.co.uk. It leads every other source for 30 days.", sheet().getByLabel("Sold for"), {
    action: "type",
    value: "265.00",
    zoom: true,
  })
  await step("Paste the link to the eBay listing, so anyone can check the sale. It must be an ebay.co.uk item link.", sheet().getByLabel("Listing"), {
    action: "type",
    value: "https://www.ebay.co.uk/itm/226119440823",
    zoom: true,
  })
  await show("The sale date starts as today. Change it if the card sold earlier.", sheet().getByLabel("Sold on"), { zoom: true })
  await step("Save the comp.", sheet().getByRole("button", { name: "Save comp" }), {
    then: async () => {
      await sheet().waitFor({ state: "hidden" })
      await page.locator('[data-testid="price-source"][data-source="uk_sold_manual"][data-chosen="true"]').waitFor()
    },
  })
  await show(
    "UK sold comp is now first and marked Chosen, so the market value and every offer use £265.00. The Listing link opens the sale.",
    source("uk_sold_manual"),
    { zoom: true }
  )

  // --- Search eBay sold and Ask an agent ------------------------------------
  await step("The holo version has its own prices and no UK sold price yet. Choose holo to price it.", finishChips().getByRole("button", { name: /^holo$/i }), {
    section: "Check recent sales",
    zoom: true,
    then: () => page.getByText("from Cardmarket €368.30").waitFor(),
  })
  await show(
    "Search eBay sold opens eBay UK's sold and completed listings for this card in a new tab. When you find a sale you trust, copy its link into Add UK comp.",
    page.getByTestId("ebay-sold"),
    { zoom: true, hold: 9 }
  )
  await step("No time to look? Press Ask an agent and Gandalf researches recent UK sales for you.", page.getByRole("button", { name: "Ask an agent" }), {
    zoom: true,
    then: () => page.getByTestId("research-result").waitFor(),
  })
  await show(
    "The request is sent. The status moves from Waiting for an agent to Gandalf is looking, then shows what it found.",
    page.getByTestId("research-result"),
    {
      zoom: true,
      then: () => page.getByTestId("research-status").filter({ hasText: "found 3 sold" }).waitFor({ timeout: 15_000 }),
    }
  )
  await show(
    "Gandalf found three UK sales. Each row has the date, the listing title and the price, with a Listing link so you can check it yourself.",
    page.getByTestId("research-result"),
    { hold: 8 }
  )
  await show(
    "These sales are saved as UK sold comps, so UK sold comp now leads the sources for the holo version.",
    source("uk_sold_manual"),
    { zoom: true }
  )

  // --- A retro game -----------------------------------------------------------
  await step("Retro games are priced on the Buy-in screen. Open Trade.", page.getByRole("link", { name: /^Trade/ }).first(), {
    section: "Retro games",
    zoom: true,
    then: () => page.getByRole("heading", { name: "Trade" }).waitFor(),
  })
  await step("Press New buy-in. Nothing is paid out until you finish the buy-in.", page.getByRole("button", { name: "New buy-in" }).filter({ visible: true }).first(), {
    zoom: true,
    then: () => page.getByLabel("Find them").waitFor(),
  })
  await step("Say who is selling. Scan their Guild card, or type their code and press Enter.", page.getByLabel("Find them"), {
    action: "type",
    value: JASMINE,
    zoom: true,
    then: async () => {
      await page.getByLabel("Find them").press("Enter")
      await page.getByRole("button", { name: "Add items", exact: true }).filter({ visible: true }).waitFor()
    },
  })
  await step("Press Add items.", page.getByRole("button", { name: "Add items", exact: true }).filter({ visible: true }), {
    zoom: true,
    then: () => page.getByRole("button", { name: "Retro", exact: true }).waitFor(),
  })
  await step("Choose Retro.", page.getByRole("button", { name: "Retro", exact: true }), {
    zoom: true,
    then: () => page.getByRole("button", { name: "SNES PAL box", exact: true }).waitFor(),
  })
  await step("Choose the console first, here SNES PAL box. Without it the game cannot be priced.", page.getByRole("button", { name: "SNES PAL box", exact: true }), {
    zoom: true,
  })
  await step("Type the game's name.", page.getByLabel("Title"), {
    action: "type",
    value: "mario",
    zoom: true,
    then: () => page.getByRole("option", { name: /Super Mario Kart/ }).waitFor(),
  })
  await step("Choose the game from the list.", page.getByRole("option", { name: /Super Mario Kart/ }), {
    zoom: true,
    then: async () => {
      await line().waitFor()
      await page.getByTestId("market-source").filter({ hasText: "PriceCharting PAL" }).waitFor()
    },
  })
  await show(
    "The market value fills in by itself, with where it came from and how old it is. The cash and credit offers sit beside it.",
    line().locator("div.items-end.flex-wrap").first(),
    { hold: 8 }
  )
  await step("Press the line under the market value to see every source.", page.getByTestId("market-source"), {
    zoom: true,
    then: () => line().getByTestId("price-sources").waitFor(),
  })
  await show(
    "For retro games the order is UK sold comp, PriceCharting PAL, eBay UK asking, then PriceCharting NTSC. Search eBay sold and Ask an agent are here too.",
    line().getByTestId("price-sources"),
    { hold: 9 }
  )
  await step("How complete the game is changes its value. Choose Loose for the cartridge on its own.", line().getByRole("button", { name: "Loose", exact: true }), {
    zoom: true,
    then: () => page.getByText("from PriceCharting PAL $24.00").waitFor(),
  })
  await show(
    "Loose is worth £18.00, against £70.50 complete in box. The offers fall to £8.00 in cash or £11.00 in credit.",
    line().locator("div.items-end.flex-wrap").first(),
    { hold: 7 }
  )

  await t.finish()
}
