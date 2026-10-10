/**
 * Tutorial 4: trade-ins with the ID check. Starts a buy-in from the Trade
 * screen, finds the customer or makes a new card, adds a card and a sealed
 * box with their condition and the cash and store credit offers, takes the
 * customer's choice of cash, reads the terms and takes the signature, runs
 * the ID check a cash buy-in needs, completes it (items into stock, labels
 * queued), and ends with a part-exchange against a sale at the till.
 */
import { join } from "node:path"

import { REPO, session } from "../lib.mjs"

// The sample ID image the e2e suite uses. It is a made-up document.
const ID_PHOTO = join(REPO, "e2e", "fixtures", "id-sample.png")

// Codes from the demo shop's stock and customers.
const CHARIZARD = "GGS-7F3K2B" // Charizard ex, £324.99
const JASMINE = "GGC-4K7M2S" // Jasmine Okafor, a Guild member

const TERMS = "The customer has heard the terms and agrees to them"

/**
 * The browser is started with a British locale in its environment, so a date
 * field reads dd/mm/yyyy as it does on the shop's own machines, not the
 * mm/dd/yyyy of a build with no locale set. Restored once it is running.
 */
async function sessionInBritain(meta, opts) {
  const keep = { LANGUAGE: process.env.LANGUAGE, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }
  process.env.LANGUAGE = "en_GB:en"
  process.env.LC_ALL = "en_GB.UTF-8"
  process.env.LANG = "en_GB.UTF-8"
  try {
    return await session(meta, opts)
  } finally {
    for (const [key, value] of Object.entries(keep)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export default async function capture({ baseURL }) {
  const t = await sessionInBritain(
    {
      slug: "trade-ins",
      number: 4,
      title: "Trade-ins with the ID check",
      subtitle: "Buy items from a customer, do the ID check for cash, and take a trade-in at the till.",
      outline: [
        "Start a buy-in and find the customer",
        "Add items and see the offers",
        "Cash or store credit, terms and signature",
        "The ID check for a cash buy-in",
        "Finish it, then trade in against a sale",
      ],
      next: "Getting market values",
    },
    { baseURL }
  )
  const { page, step, show } = t
  await t.signIn()

  /** Below 900px the primary action is a second, docked copy of the button. */
  const primary = (name) => page.getByRole("button", { name, exact: true }).filter({ visible: true })

  /** Drags a short stroke across the pad, which is what "signed" means here. */
  async function sign(pad) {
    await pad.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(200)
    const box = await pad.boundingBox()
    if (!box) throw new Error("The signature pad has no box to sign on")
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + 20, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.35, y - box.height * 0.2, { steps: 6 })
    await page.mouse.move(box.x + box.width * 0.6, y + box.height * 0.15, { steps: 6 })
    await page.mouse.up()
    await page.getByText("Signature captured").waitFor()
  }

  const centre = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: "center" }))
  const toTop = () => page.evaluate(() => window.scrollTo(0, 0))
  /** Shrinks a full-width block to its content, so a highlight hugs what is visible. */
  const hug = (locator) => locator.evaluate((el) => (el.style.width = "fit-content"))

  const scanField = () => page.getByTestId("till-scan-field")
  const scan = (code, caption, opts = {}) =>
    step(caption, scanField(), {
      action: "type",
      value: code,
      zoom: true,
      ...opts,
      then: async () => {
        await scanField().press("Enter")
        await t.settle(700)
      },
    })

  // --- Start a buy-in --------------------------------------------------------
  await step("Buy-ins start on the Trade screen. Choose Trade in the top bar.", page.getByRole("link", { name: /^Trade/ }).first(), {
    section: "Start a buy-in",
    then: () => page.getByRole("heading", { name: "Trade" }).waitFor(),
  })
  await step("Every buy-in is listed here, newest first. When someone brings items in to sell, press New buy-in.", primary("New buy-in"), {
    zoom: true,
    then: () => page.getByRole("heading", { name: "Buy-in" }).waitFor(),
  })

  // --- The customer ------------------------------------------------------------
  const find = () => page.getByLabel("Find them")
  await step("Find the customer first. Type their name, phone number or GGC code, or scan their Guild card.", find(), {
    section: "The customer",
    action: "type",
    value: "Tom",
    zoom: true,
    then: () => page.getByRole("list", { name: "Matching customers" }).waitFor(),
  })
  await show("Anyone who matches is listed underneath. Choose a name to use their card.", page.getByRole("list", { name: "Matching customers" }), {
    zoom: true,
  })
  await step("If the customer is not listed, they have no card yet. Press New customer to make one.", page.getByRole("button", { name: "New customer" }), {
    zoom: true,
    then: () => page.getByRole("button", { name: "Save and carry on" }).waitFor(),
  })
  await step("The name you searched for is filled in. Type their full name instead.", page.getByLabel("Name", { exact: true }), {
    action: "type",
    value: "Priya Sandhu",
    zoom: true,
  })
  await step("Phone and email are optional, so a name is enough. Press Save and carry on.", page.getByRole("button", { name: "Save and carry on" }), {
    zoom: true,
    then: () => page.getByText("ID Not on file").waitFor(),
  })
  await show("The new card is made and chosen. Their ID shows as Not on file, so a cash buy-in will need the full ID check.", page.getByText("ID Not on file"), {
    zoom: true,
  })
  await step("Press Add items.", primary("Add items"), {
    then: () => page.getByText("What they are selling").waitFor(),
  })

  // --- The items -----------------------------------------------------------------
  await hug(page.getByLabel("Line type"))
  await show("Say what kind of item it is: Card, Graded, Retro, Sealed or Bulk lot. Start with a card.", page.getByLabel("Line type"), {
    section: "The items",
    zoom: true,
  })
  await step("Type the set and card number, here sv151 199. The card's name works too.", page.getByLabel("Set and number"), {
    action: "type",
    value: "sv151 199",
    zoom: true,
    then: () => page.getByRole("option", { name: /Charizard ex/ }).waitFor(),
  })
  const cardLine = () => page.getByTestId("trade-line").first()
  await step("Choose the card from the list.", page.getByRole("option", { name: /Charizard ex/ }), {
    zoom: true,
    then: async () => {
      await cardLine().waitFor()
      await t.settle(900)
      await centre(cardLine())
    },
  })
  await show("The card is on the buy-in with its market value, and the cash and store credit offers beside it.", cardLine(), {
    zoom: true,
    hold: 5,
  })
  await step("Set its condition, from NM down to DMG. This one is Lightly Played, so choose LP.", cardLine().getByRole("button", { name: "LP", exact: true }), {
    zoom: true,
    then: () => t.settle(700),
  })
  await show("The cash and store credit offers have dropped for the lower condition.", cardLine(), { zoom: true })

  await step("Now a sealed box. Choose Sealed.", page.getByRole("button", { name: "Sealed", exact: true }), {
    zoom: true,
  })
  await step("Type what it is.", page.getByLabel("Title"), {
    action: "type",
    value: "Surging Sparks Elite Trainer Box",
    zoom: true,
  })
  await step("Press Add line.", page.getByRole("button", { name: "Add line" }), {
    zoom: true,
    then: () => page.getByTestId("trade-line").nth(1).waitFor(),
  })
  await step("A sealed box has no price lookup, so type its market value yourself.", page.getByLabel("Market value for Surging Sparks Elite Trainer Box"), {
    action: "type",
    value: "40",
    zoom: true,
  })
  await show("The bar at the bottom adds it all up: market value, the cash offer and the store credit offer.", page.getByTestId("total-cash").locator("xpath=ancestor::dl"), {
    zoom: true,
  })
  await step("Press Make the offer.", primary("Make the offer"), {
    then: async () => {
      await page.getByTestId("tile-cash").waitFor()
      await toTop()
    },
  })

  // --- The offer --------------------------------------------------------------------
  await show("Show the customer both offers. Cash needs photo ID. Store credit does not.", page.getByTestId("tile-cash").locator("xpath=.."), {
    section: "The offer",
    zoom: true,
  })
  await step("This customer wants cash. Choose Cash.", page.getByTestId("tile-cash"), {
    zoom: true,
    then: () => page.getByRole("navigation", { name: "Buy-in progress" }).getByText("ID check").first().waitFor(),
  })
  await show("Choosing cash has added an ID check to the steps along the top.", page.getByRole("navigation", { name: "Buy-in progress" }), {
    zoom: true,
    settle: 1200,
  })
  await step("Read the terms to the customer. Tick the box once they have heard them and agree.", page.getByRole("switch", { name: TERMS }), {
    zoom: true,
  })
  await centre(page.getByTestId("signature-pad"))
  await step("The customer signs on the screen with a finger or a stylus.", page.getByTestId("signature-pad"), {
    action: sign,
  })
  await step("Once they have signed, press Check ID.", primary("Check ID"), {
    then: async () => {
      await page.getByText("Photo of the ID").waitFor()
      await toTop()
    },
  })

  // --- The ID check -------------------------------------------------------------------
  await show("This is the law's record of who sold the shop these items for cash. Read the notice to the customer.", page.getByText("We photograph the ID"), {
    section: "Check their ID",
    zoom: true,
    hold: 6,
  })
  const photo = () => page.getByTestId("id-photo-input")
  await hug(photo())
  await step("Take a photo of the customer's original ID with Choose file. It is resized when saved, so no location data is kept.", photo(), {
    action: (input) => input.setInputFiles(ID_PHOTO),
    zoom: true,
    then: () => page.getByTestId("id-photo-preview").waitFor(),
  })
  await step("Choose the type of ID: Passport, Driving licence or Other. Here it is a driving licence.", page.locator("#id-type"), {
    zoom: true,
    action: async (trigger) => {
      await trigger.click()
      await page.getByRole("option", { name: "Driving licence" }).click()
      await page.getByRole("option", { name: "Driving licence" }).waitFor({ state: "hidden" })
    },
  })
  await step("Enter the expiry date printed on the ID.", page.getByLabel("Expires"), {
    action: (el) => el.fill("2032-06-30"),
    zoom: true,
  })
  await step("Type the last four digits of the ID number.", page.getByLabel("Last four digits"), {
    action: "type",
    value: "4471",
    zoom: true,
  })
  await step("Enter their date of birth. Cash is only paid to customers aged 18 or over.", page.getByLabel("Date of birth"), {
    action: (el) => el.fill("1994-03-18"),
    zoom: true,
  })
  await step("Type their address. The buy-in register needs it as well as the ID.", page.getByLabel("Address"), {
    action: "type",
    value: "18 Hill Top, Bolsover, S44 6NB",
    zoom: true,
  })
  await step("Tick to confirm you have seen the original ID and it matches the person in front of you.", page.getByRole("switch", { name: "I have seen the original document and it matches" }), {
    zoom: true,
  })
  await step("Everything is in. Press Complete buy-in.", primary("Complete buy-in"), {
    then: async () => {
      await page.getByRole("heading", { name: "Bought in" }).waitFor()
      await t.settle(900)
      await toTop()
    },
  })

  // --- Done ----------------------------------------------------------------------------
  await show("Bought in. Hand the customer the amount under Cash out.", page.getByText("Cash out", { exact: true }).locator("xpath=.."), {
    section: "Finish the buy-in",
    zoom: true,
  })
  await hug(page.getByLabel("Items now in stock"))
  await show("Both items are now in stock, each with its own code.", page.getByLabel("Items now in stock"), {
    zoom: true,
  })
  await show("A label for each is queued for the counter printer.", page.getByText(/labels? queued for the counter printer/), {
    zoom: true,
  })
  await step("Press Receipt for the customer's paperwork.", page.getByRole("button", { name: "Receipt", exact: true }), {
    zoom: true,
    then: async () => {
      await page.getByText("Identity", { exact: true }).waitFor()
      await page.getByRole("button", { name: "Print" }).waitFor()
      await t.settle(700)
      await toTop()
    },
  })
  await show("The receipt records who sold the items: their name and address, and the ID they showed. Print it for the customer.", page.getByText("Identity", { exact: true }).locator("xpath=ancestor::section[1]"), {
    zoom: true,
    hold: 5,
  })


  // --- Part-exchange at the till ----------------------------------------------------
  await step("A customer can also put what they are selling towards what they are buying. Open the till.", page.getByRole("link", { name: "Till", exact: true }).first(), {
    section: "Part-exchange",
    then: () => page.getByTestId("till").waitFor(),
  })
  await scan(JASMINE, "Scan their Guild card first. A trade-in needs the customer on the ticket.")
  await scan(CHARIZARD, "Scan what they are buying.")
  await step("Press Trade in, under the ticket.", page.getByTestId("till-trade-in").filter({ visible: true }), {
    zoom: true,
    then: () => page.getByTestId("till-trade-panel").waitFor(),
  })
  const panel = () => page.getByTestId("till-trade-panel")
  await step("Add what they are selling the same way as in a buy-in. Here a card: type sv151 205.", panel().getByLabel("Set and number"), {
    action: "type",
    value: "sv151 205",
    zoom: true,
    then: () => page.getByRole("option", { name: /Mew ex/ }).waitFor(),
  })
  await step("Choose the card.", page.getByRole("option", { name: /Mew ex/ }), {
    zoom: true,
    then: async () => {
      await panel().getByTestId("trade-line").first().waitFor()
      await t.settle(900)
    },
  })
  await show("At the till a trade-in is valued at credit rates, because its value comes off the bill. The cash offer shows underneath.", panel().getByTestId("trade-line").first(), {
    zoom: true,
    hold: 5,
  })
  await show("On the ticket the trade-in has its own group, and its value comes off the total.", page.getByTestId("ticket-trade"), {
    zoom: true,
  })
  await step("Press Pay.", page.getByTestId("till-pay").filter({ visible: true }), {
    then: () => page.getByTestId("till-trade-step").waitFor(),
  })
  await step("The trade-in pays part of the bill. Read the terms to the customer, then tick the box.", page.getByRole("switch", { name: TERMS }), {
    zoom: true,
  })
  await centre(page.getByTestId("signature-pad"))
  await step("The customer signs here too.", page.getByTestId("signature-pad"), {
    action: sign,
  })
  await step("The customer pays the rest as in any sale. Choose Cash.", page.getByRole("button", { name: "Cash", exact: true }), {
    zoom: true,
  })
  await step("Press Exact if they hand over the right money.", page.getByRole("button", { name: "Exact" }), {
    zoom: true,
    then: () => page.getByTestId("till-done").waitFor(),
  })
  await show("Paid. The sale has its number, and the trade-in has its own buy-in number.", page.getByTestId("till-done-trade"), {
    zoom: true,
    hold: 5,
  })

  await t.finish()
}
