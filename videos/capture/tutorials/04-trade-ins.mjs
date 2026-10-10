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

export default async function capture({ baseURL }) {
  const t = await session(
    {
      slug: "trade-ins",
      number: 4,
      title: "Trade-ins with the ID check",
      subtitle: "Buy items from a customer, check their ID, and take a trade-in against a sale.",
      outline: [
        "Start a buy-in and find or card the customer",
        "Add the items with their condition and see the offers",
        "Cash or store credit, the terms and the signature",
        "The ID check a cash buy-in needs, and why",
        "Complete it, then trade in against a sale at the till",
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
  await step("Not who you wanted? Type a different name. This customer is new, so Priya Sandhu finds no card.", find(), {
    action: "type",
    value: "Priya Sandhu",
    zoom: true,
    then: () => page.getByRole("list", { name: "Matching customers" }).waitFor({ state: "hidden" }),
  })
  await step("No match, so make a card. Press New customer.", page.getByRole("button", { name: "New customer" }), {
    zoom: true,
    then: () => page.getByRole("button", { name: "Save and carry on" }).waitFor(),
  })
  await step("Phone and email are optional, but a phone number makes them easy to find next time.", page.getByLabel("Phone"), {
    action: "type",
    value: "07700 900321",
    zoom: true,
  })
  await step("An email address lets you send them the receipt afterwards.", page.getByLabel("Email"), {
    action: "type",
    value: "priya@example.co.uk",
    zoom: true,
  })
  await step("Save the card and carry on.", page.getByRole("button", { name: "Save and carry on" }), {
    zoom: true,
    then: () => page.getByText("ID Not on file").waitFor(),
  })
  await show("The customer is chosen. Their ID shows as Not on file, so a cash buy-in will need the full ID check.", page.getByText("ID Not on file"), {
    zoom: true,
  })
  await step("Press Add items.", primary("Add items"), {
    then: () => page.getByText("What they are selling").waitFor(),
  })

  // --- The items -----------------------------------------------------------------
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
  await step("Choose the card from the list.", page.getByRole("option", { name: /Charizard ex/ }), {
    zoom: true,
    then: () => page.getByTestId("trade-line").first().waitFor(),
  })
  const cardLine = () => page.getByTestId("trade-line").first()
  await show("The card is on the buy-in with its market value, and the cash and store credit offers beside it.", cardLine(), {
    zoom: true,
    hold: 5,
  })
  await step("Set its condition. This one is Lightly Played, so choose LP.", cardLine().getByRole("button", { name: "LP", exact: true }), {
    zoom: true,
  })
  await show("The offers are worked out again for the new condition.", cardLine(), { zoom: true })

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
    then: () => page.getByTestId("tile-cash").waitFor(),
  })

  // --- The offer --------------------------------------------------------------------
  await show("Show the customer both offers. Cash needs photo ID. Store credit does not.", page.getByTestId("tile-cash").locator("xpath=.."), {
    section: "Cash or credit",
    zoom: true,
  })
  await step("This customer wants cash. Choose Cash.", page.getByTestId("tile-cash"), { zoom: true })
  await show("Read the terms to the customer. They confirm the items are theirs to sell.", page.getByRole("switch", { name: "The customer has heard the terms and agrees to them" }).locator("xpath=.."), {
    zoom: true,
  })
  await step("Tick the box once they have heard the terms and agree.", page.getByRole("switch", { name: "The customer has heard the terms and agrees to them" }), {
    zoom: true,
  })
  const pad = () => page.getByTestId("signature-pad")
  await centre(pad())
  await step("The customer signs on the screen with a finger, a stylus or the mouse.", pad(), {
    action: sign,
  })
  await step("Once they have signed, press Check ID.", primary("Check ID"), {
    then: () => page.getByText("Photo of the ID").waitFor(),
  })

  // --- The ID check -------------------------------------------------------------------
  await show("Cash needs a record of who sold the shop these items. Read this notice to the customer.", page.getByText("We photograph the ID"), {
    section: "Check their ID",
    zoom: true,
  })
  await step("The buy-in will not complete without it. Press Complete buy-in and it says what is missing.", primary("Complete buy-in"), {
    zoom: true,
    then: () => page.getByText("Photograph the ID before you continue.").waitFor(),
  })
  const photo = () => page.getByTestId("id-photo-input")
  await step("Take a photo of the customer's original ID.", photo(), {
    action: (input) => input.setInputFiles(ID_PHOTO),
    zoom: true,
    then: () => page.getByTestId("id-photo-preview").waitFor(),
  })
  await show("Check the photo is clear. It is resized when saved, so no location data is kept.", page.getByTestId("id-photo-preview"), {
    zoom: true,
  })
  await step("Choose the type of ID.", page.locator("#id-type"), {
    zoom: true,
    then: () => page.getByRole("option", { name: "Driving licence" }).waitFor(),
  })
  await step("Driving licence, in this case.", page.getByRole("option", { name: "Driving licence" }), {
    zoom: true,
    then: () => page.getByRole("option", { name: "Driving licence" }).waitFor({ state: "hidden" }),
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
    then: () => page.getByRole("heading", { name: "Bought in" }).waitFor(),
  })

  // --- Done ----------------------------------------------------------------------------
  await show("Bought in. The buy-in has its own number, and the cash to hand over is shown.", page.getByTestId("buyin-number").locator("xpath=.."), {
    section: "Finish the buy-in",
    zoom: true,
    hold: 5,
  })
  await show("The items are now in stock, each with its own code, and their labels are queued for the counter printer.", page.getByLabel("Items now in stock"), {
    zoom: true,
    hold: 5,
  })
  await step("Press Receipt for the customer's paperwork.", page.getByRole("button", { name: "Receipt", exact: true }), {
    zoom: true,
    then: () => page.getByRole("button", { name: "Print" }).waitFor(),
  })
  await show("The receipt has the buy-in number, the items and the customer's details. Print it for them.", page.getByRole("button", { name: "Print" }), {
    zoom: true,
  })

  await t.finish()
}
