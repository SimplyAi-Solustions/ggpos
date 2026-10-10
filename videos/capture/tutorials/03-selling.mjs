/**
 * Tutorial 3: selling at the till. Opens the till, scans an item and taps a
 * tile, attaches a Guild member, changes a line with a discount and a note,
 * takes a split payment (cash then the Tide card), offers the receipt, parks
 * and recalls a ticket, and takes a return from a receipt.
 */
import { session } from "../lib.mjs"

// Codes from the demo shop's stock and customers.
const CHARIZARD = "GGS-7F3K2B" // Charizard ex, £324.99
const MABEL = "GGS-T4M9PT" // Mabel, Heir to Cragflame, £12.49
const JASMINE = "GGC-4K7M2S" // Jasmine Okafor, a Guild member

export default async function capture({ baseURL }) {
  const t = await session(
    {
      slug: "selling",
      number: 3,
      title: "Selling at the till",
      subtitle: "Scan, change a line, take payment, receipts, parking and returns.",
      outline: [
        "Open the till and put items on the ticket",
        "Attach a Guild member for their points",
        "Change a line: a discount and a note",
        "Take payment, split between cash and card",
        "Receipts, parking a ticket and returns",
      ],
      next: "Trade-ins with the ID check",
    },
    { baseURL }
  )
  const { page, step, show } = t
  await t.signIn()

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

  // --- Open the till -------------------------------------------------------
  await step("Every shift starts on the home screen. Open the till from the top bar.", page.getByRole("link", { name: "Till", exact: true }).first(), {
    section: "Open the till",
    then: () => page.getByTestId("till").waitFor(),
  })
  await show(
    "The till: the shop's products and categories on the left, the ticket on the right.",
    page.getByTestId("till"),
    { hold: 5 }
  )

  // --- Items on the ticket -----------------------------------------------
  await scan(CHARIZARD, "Scan the label with the scanner. Typing the code and pressing Enter does the same.", {
    section: "Put items on the ticket",
  })
  await step("No label? Tap a tile instead. Here, an hour of table time.", page.getByTestId("till-tile").filter({ hasText: "Table time" }).first(), {
    zoom: true,
  })
  await show("Both lines are on the ticket, with the running total underneath.", page.getByTestId("ticket-line").first().locator("xpath=.."), {
    zoom: true,
  })

  // --- Customer ------------------------------------------------------------
  await scan(JASMINE, "Scan the customer's Guild card to attach them. Their points are worked out as you go.", {
    section: "Attach a Guild member",
  })
  await show("Jasmine is attached. Her tier and the points this sale earns show on the ticket.", page.getByTestId("ticket-customer"), {
    zoom: true,
  })

  // --- Change a line --------------------------------------------------------
  await step("Tap a line to change it. The Charizard has a dinged corner, so it gets a discount.", page.getByRole("button", { name: "Change Charizard ex" }), {
    section: "Change a line",
    zoom: true,
    then: () => page.getByTestId("line-sheet").waitFor(),
  })
  const sheet = () => page.getByTestId("line-sheet")
  await step("Choose Percent for a percentage off, or Amount for money off.", sheet().getByRole("button", { name: "Percent" }), { zoom: true })
  await step("Type the percentage.", sheet().getByLabel("Percent off"), { action: "type", value: "10", zoom: true })
  await step("Add a note to say why. It prints on the receipt and stays on the sale.", sheet().getByLabel("Note"), {
    action: "type",
    value: "Corner ding",
    zoom: true,
  })
  await step("Save the change.", sheet().getByTestId("line-sheet-save"), {
    then: () => sheet().waitFor({ state: "hidden" }),
  })
  await show("The line shows the discount, the note and the new price.", page.getByTestId("ticket-line").filter({ hasText: "Charizard ex" }), {
    zoom: true,
  })

  // --- Payment -------------------------------------------------------------
  await step("When the customer is ready, press Pay.", page.getByTestId("till-pay").filter({ visible: true }), {
    section: "Take payment",
    then: () => page.getByTestId("till-to-pay").waitFor(),
  })
  await show("The amount to pay is at the top. Payments can be split across as many ways as needed.", page.getByTestId("till-to-pay"), {
    zoom: true,
  })
  await step("This customer pays £50.00 in cash first. Choose Cash.", page.getByRole("button", { name: "Cash", exact: true }), { zoom: true })
  await step(
    "Key the amount handed over on the money pad, or with the keyboard: 5, 0, 0, 0 for £50.00.",
    page.getByTestId("till-cash-amount"),
    {
      action: async () => {
        await page.keyboard.type("5000")
      },
      zoom: true,
    }
  )
  await step("Take the cash. The rest stays to pay.", page.getByTestId("till-take-cash"), { zoom: true })
  await show("£50.00 in cash is taken. The rest goes on the card.", page.getByTestId("till-to-pay"), { zoom: true })
  await step("Choose Card. The till tells you the amount to key on the Tide reader.", page.getByRole("button", { name: "Card", exact: true }), {
    zoom: true,
    then: () => page.getByTestId("till-card-step").waitFor(),
  })
  await show("Key exactly this amount on the Tide card reader and let the customer tap or insert their card.", page.getByTestId("till-card-step"), {
    zoom: true,
    hold: 5.5,
  })
  await step("When the reader says approved, press Approved.", page.getByTestId("till-card-approved"), { zoom: true })
  await step("Type the last four digits of the card from the reader's slip, for matching up at the end of the day.", page.getByLabel("Last four digits"), {
    action: "type",
    value: "4242",
    zoom: true,
  })
  await step("Press Approved again to finish.", page.getByTestId("till-card-approved"), {
    then: () => page.getByTestId("till-done").waitFor(),
  })

  // --- Receipt -------------------------------------------------------------
  await show("Paid. The sale has its number, and the stock and the customer's points are updated.", page.getByTestId("till-done"), {
    section: "Receipts",
    zoom: true,
    hold: 5,
  })
  await show("Print a receipt, email it, or choose No receipt. Any of them starts the next sale.", page.getByTestId("till-done").getByRole("button", { name: "No receipt" }).locator("xpath=.."), {
    zoom: true,
  })
  await step("This customer doesn't want one.", page.getByTestId("till-done").getByRole("button", { name: "No receipt" }), {
    then: () => page.getByTestId("till-done").waitFor({ state: "hidden" }),
  })

  // --- Park and recall -------------------------------------------------------
  await scan(MABEL, "Someone wants to keep browsing? Put their item on a ticket and park it.", { section: "Park a ticket" })
  await step("Press Park.", page.getByRole("button", { name: "Park", exact: true }), {
    then: () => page.getByRole("dialog").filter({ hasText: "Park ticket" }).waitFor(),
  })
  const park = () => page.getByRole("dialog").filter({ hasText: "Park ticket" })
  await step("Give it a name you will recognise.", park().getByLabel("Name"), { action: "type", value: "Blue hoodie", zoom: true })
  await step("Park it. The till is clear for the next customer.", park().getByTestId("park-sheet-park"), {
    then: () => park().waitFor({ state: "hidden" }),
  })
  await step("Parked tickets wait here. Tap to bring one back when they're ready to pay.", page.getByTestId("till-parked"), {
    zoom: true,
    then: () => page.getByTestId("recall-sheet").waitFor(),
  })
  await step("Choose the ticket. It comes back exactly as it was.", page.getByTestId("recall-sheet").getByTestId("parked-ticket").filter({ hasText: "Blue hoodie" }), {
    zoom: true,
    then: () => page.getByTestId("recall-sheet").waitFor({ state: "hidden" }),
  })
  await step("Clear the ticket to start again.", page.getByRole("button", { name: "Clear ticket" }), {
    then: () => page.getByTestId("till-clear-confirm").waitFor(),
  })
  await step("Confirm.", page.getByTestId("till-clear-confirm"), {
    then: () => page.getByTestId("ticket-empty").waitFor(),
  })

  // --- Returns -------------------------------------------------------------
  await scan("GGS000456", "For a return, scan the barcode on the receipt.", { section: "Take a return" })
  const returns = () => page.getByTestId("returns-sheet")
  await show("The sale opens with what was bought. Tick what is coming back.", returns().getByTestId("returns-lines"), { zoom: true })
  await step("Say why it is coming back.", returns().getByLabel("Reason"), { action: "type", value: "Wrong card", zoom: true })
  await show("The money goes back the way it was paid, here cash. You can choose another way.", returns().getByRole("button", { name: "Cash", exact: true }).locator("xpath=.."), {
    zoom: true,
  })
  await step("Refund it.", returns().getByTestId("returns-refund"), {
    then: () => returns().getByTestId("returns-done").waitFor(),
  })
  // Zoom to the refund line and its number, not the whole (mostly empty) panel.
  await show("Done: the refund has its own number, the card is back in stock and the drawer is updated.", returns().getByTestId("returns-done").locator(".font-mono"), {
    zoom: true,
    hold: 5,
  })

  await t.finish()
}
