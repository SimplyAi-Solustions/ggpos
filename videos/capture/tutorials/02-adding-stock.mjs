/**
 * Tutorial 2: adding stock. Opens Add stock, adds a Pokemon single by set and
 * number with its condition and finish, reads the market value and the
 * suggested price, files it in the category tree, saves it and queues its
 * label; adds sealed product from a scanned barcode with a quantity; takes an
 * item photo with the capture guide; walks the item page (price, branch, the
 * Website switch); and finds the stock again in Stock.
 *
 * The demo keeps its stock in memory for the tab, so after signing in nothing
 * here loads an address: every move between screens is a click.
 */
import { session } from "../lib.mjs"

// A barcode already on the demo shelf (Prismatic Evolutions Booster Pack).
const BOOSTER_EAN = "0820650859007"

/**
 * A fake webcam for the capture guide: a plain mat with a card on it, drawn
 * on a canvas and handed to the page as the camera stream. Chromium's own
 * fake device needs launch flags the harness does not pass, so this stands
 * in for it at the page's getUserMedia.
 */
async function addFakeCamera(context) {
  await context.addInitScript(() => {
    const WIDTH = 1280
    const HEIGHT = 720

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }

    function paint(ctx) {
      // A plain mat.
      ctx.fillStyle = "#e9e7e0"
      ctx.fillRect(0, 0, WIDTH, HEIGHT)
      // A card, 63:88, a little smaller than the guide.
      const h = 540
      const w = Math.round((h * 63) / 88)
      const x = Math.round((WIDTH - w) / 2)
      const y = Math.round((HEIGHT - h) / 2)
      ctx.fillStyle = "#0b0b0b"
      roundRect(ctx, x, y, w, h, 22)
      ctx.fill()
      ctx.fillStyle = "#f4b63f"
      roundRect(ctx, x + 14, y + 14, w - 28, h - 28, 14)
      ctx.fill()
      // The name band.
      ctx.fillStyle = "#fbe7a8"
      roundRect(ctx, x + 28, y + 28, w - 56, 52, 8)
      ctx.fill()
      ctx.fillStyle = "#0b0b0b"
      ctx.font = "bold 30px sans-serif"
      ctx.textBaseline = "middle"
      ctx.fillText("Charizard ex", x + 42, y + 55)
      // The art.
      const art = ctx.createLinearGradient(0, y + 96, 0, y + 330)
      art.addColorStop(0, "#e4572e")
      art.addColorStop(1, "#7a1f12")
      ctx.fillStyle = art
      roundRect(ctx, x + 28, y + 96, w - 56, 230, 8)
      ctx.fill()
      // The text box.
      ctx.fillStyle = "#fbe7a8"
      roundRect(ctx, x + 28, y + 344, w - 56, h - 344 - 28, 8)
      ctx.fill()
      ctx.fillStyle = "#0b0b0b"
      ctx.fillRect(x + 48, y + 380, w - 150, 8)
      ctx.fillRect(x + 48, y + 410, w - 110, 8)
      ctx.fillRect(x + 48, y + 440, w - 190, 8)
    }

    function makeStream() {
      const canvas = document.createElement("canvas")
      canvas.width = WIDTH
      canvas.height = HEIGHT
      const ctx = canvas.getContext("2d")
      paint(ctx)
      const stream = canvas.captureStream(10)
      // A new frame every so often, so the video always has a picture to read.
      window.setInterval(() => paint(ctx), 100)
      return stream
    }

    const devices = navigator.mediaDevices ?? {}
    devices.getUserMedia = async () => makeStream()
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true })
    }
  })
}

export default async function capture({ baseURL }) {
  const t = await session(
    {
      slug: "adding-stock",
      number: 2,
      title: "Adding stock",
      subtitle: "Put a card or a box on the shelf, price it, label it, photograph it and find it again.",
      outline: [
        "Add a card single, priced from the market",
        "File it in the category tree and print its label",
        "Add sealed product from its barcode",
        "Take a photo for the website",
        "Find your stock again in Stock",
      ],
      next: "Selling at the till",
    },
    { baseURL }
  )
  const { page, step, show } = t
  await addFakeCamera(page.context())
  await t.signIn()

  const heading = (name) => page.getByRole("heading", { name, exact: true })
  const saveButton = () => page.getByRole("button", { name: "Save item", exact: true }).filter({ visible: true })
  const picker = () => page.getByTestId("category-picker")
  const pickRow = (name) =>
    picker()
      .getByTestId("category-picker-rows")
      .getByRole("button")
      .filter({ has: page.getByText(name, { exact: true }) })
  /** Brings a control to the middle of the screen, so it is not on the edge of the picture. */
  const centre = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: "center" }))
  /** The box of the text itself, for a block element that would otherwise draw a full-width box. */
  const tight = (locator) => ({
    waitFor: (options) => locator.waitFor(options),
    scrollIntoViewIfNeeded: () => locator.scrollIntoViewIfNeeded(),
    click: (options) => locator.click(options),
    boundingBox: () =>
      locator.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const b = range.getBoundingClientRect()
        return { x: b.x, y: b.y, width: b.width, height: b.height }
      }),
  })
  const logo = () => page.locator('header a[href="/counter"]')
  const mainNav = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true })
  const scanField = () => page.getByTestId("scan-field")

  // --- Open Add stock ------------------------------------------------------
  await step("Add stock is on the home screen. Press it whenever something new is going on the shelf.", page.getByRole("link", { name: "Add stock", exact: true }), {
    section: "Open Add stock",
    then: () => heading("Add stock").waitFor(),
  })
  await show("One page holds everything about the item. You fill it in, then save it once at the bottom.", null, { hold: 4.5 })

  // --- Add a single --------------------------------------------------------
  await step("Choose the game, here Pokemon. The search is quicker when it knows which game to look in.", page.getByRole("button", { name: "Pokemon", exact: true }), {
    section: "Add a single",
    zoom: true,
  })
  await step("Type the set and the card number. A card's name works too.", page.getByLabel("Set and number"), {
    action: "type",
    value: "sv151 199",
    zoom: true,
    then: () => page.getByRole("option", { name: /Charizard ex/ }).waitFor(),
  })
  await step("Choose the card from the list.", page.getByRole("option", { name: /Charizard ex/ }), {
    zoom: true,
    then: () => page.getByTestId("card-preview").getByText("Scarlet & Violet 151").waitFor(),
  })
  await show("The card's picture, name and set appear here. Check it is the right printing.", page.getByTestId("card-preview"), { zoom: true })
  await centre(page.getByRole("button", { name: "Holo", exact: true }))
  await step("Choose the finish. This printing is Holo.", page.getByRole("button", { name: "Holo", exact: true }), { zoom: true })
  await step("Choose the condition. NM is near mint. The price below is worked out for the condition you pick.", page.getByRole("button", { name: "NM", exact: true }), {
    zoom: true,
  })
  await step("Type what the card cost you. Cost is needed so the reports can work out your margin.", page.getByLabel("Cost"), {
    action: "type",
    value: "180",
    zoom: true,
  })

  // --- Price it ------------------------------------------------------------
  await show("The Price box is already filled in with the suggested price, which is shown beside its label.", page.getByLabel("Price"), {
    section: "Price it",
    zoom: true,
  })
  await centre(page.getByRole("region", { name: "Market" }))
  await show("Market shows what each price source says this card is worth, in pounds.", page.getByRole("region", { name: "Market" }), { hold: 5 })
  await show(
    "Suggested is the price worked out from the market value. It fills the Price box until you type your own, and Use suggested puts it back.",
    page.getByTestId("suggested-price").locator("xpath=.."),
    { zoom: true, hold: 6 }
  )

  // --- File it in the tree ---------------------------------------------------
  await step("Now say where it lives in the category tree. Press Choose a branch.", page.getByRole("button", { name: "Choose a branch" }), {
    section: "File it in the tree",
    zoom: true,
    then: () => picker().waitFor(),
  })
  await step("Go down the tree one level at a time. Start with Trading cards.", pickRow("Trading cards"), { zoom: true })
  await step("Then Pokémon.", pickRow("Pokémon"), { zoom: true })
  await step("Then Singles.", pickRow("Singles"), { zoom: true })
  await step("The path along the bottom says where the card will be filed. Press Choose this branch.", picker().getByRole("button", { name: "Choose this branch" }), {
    zoom: true,
    then: () => picker().waitFor({ state: "hidden" }),
  })
  await show("The branch is filled in, and the kind, game and VAT follow it. You can still change any of them.", page.getByTestId("stock-branch-field"), {
    zoom: true,
    hold: 5,
  })

  // --- Save and label ----------------------------------------------------------
  let charizardCode = ""
  await step("Check the details, then press Save item.", saveButton(), {
    section: "Save and print the label",
    then: async () => {
      await heading("Saved").waitFor()
      charizardCode = (await page.getByTestId("saved-sku").innerText()).trim()
    },
  })
  await show("Saved. The card has its own code. It is the one on the label.", tight(page.getByTestId("saved-sku")), { zoom: true })
  await step("Press Print label.", page.getByRole("button", { name: "Print label", exact: true }), {
    zoom: true,
    then: () => page.getByText("Label queued").waitFor(),
  })
  await show("The label is in the queue for the label printer.", page.getByText("Label queued"), { zoom: true })

  // --- Sealed product ----------------------------------------------------------
  await step("Now a box of sealed product, added from its barcode. Go back to the home screen with the GG Vault logo.", logo(), {
    section: "Add sealed product",
    then: () => heading("Today").waitFor(),
  })
  await step("Press Scan.", page.getByRole("link", { name: "Scan", exact: true }), {
    then: () => scanField().waitFor(),
  })
  await step("Scan the barcode on the pack with the scanner. Typing the number and pressing Enter does the same.", scanField(), {
    action: "type",
    value: BOOSTER_EAN,
    zoom: true,
    then: async () => {
      await scanField().press("Enter")
      await heading("Add stock").waitFor()
      await t.settle(700)
    },
  })
  await step("Add stock opens and keeps the barcode. Say what the product is by pressing Choose a branch.", page.getByRole("button", { name: "Choose a branch" }), {
    zoom: true,
    then: () => picker().waitFor(),
  })
  await step("Quicker than going down the tree: search every branch. Type booster.", picker().getByLabel("Search every branch"), {
    action: "type",
    value: "booster",
    zoom: true,
    then: () => picker().getByTestId("category-picker-results").waitFor(),
  })
  await step("Choose Pokémon, Sealed, Booster packs.", picker().getByTestId("category-picker-results").getByRole("button").filter({ hasText: "Pokémon" }).first(), {
    zoom: true,
  })
  await step("Press Choose this branch.", picker().getByRole("button", { name: "Choose this branch" }), {
    zoom: true,
    then: () => picker().waitFor({ state: "hidden" }),
  })
  await show("The branch has filled in the kind, the game and the VAT. The barcode is in the EAN box.", page.getByLabel("EAN"), {
    zoom: true,
    hold: 5,
  })
  await step("Type a title, so it can be found on the shelf.", page.getByLabel("Title"), {
    action: "type",
    value: "Prismatic Evolutions Booster Pack",
    zoom: true,
  })
  await step("Type how many you have. Sealed product is one line with a quantity, not one row each.", page.getByLabel("Quantity"), {
    action: "type",
    value: "6",
    zoom: true,
  })
  await step("Type the cost of one pack.", page.getByLabel("Cost"), { action: "type", value: "3.60", zoom: true })
  await step("Type the price of one pack. Sealed product has no market figure, so you set this yourself.", page.getByLabel("Price"), {
    action: "type",
    value: "5.49",
    zoom: true,
  })
  await step("Press Save item.", saveButton(), {
    then: () => heading("Saved").waitFor(),
  })

  // --- Take a photo ------------------------------------------------------------
  await step("Back to the card for its photo. Go to the home screen with the logo.", logo(), {
    section: "Take a photo",
    then: () => heading("Today").waitFor(),
  })
  await step("Press Scan.", page.getByRole("link", { name: "Scan", exact: true }), {
    then: () => scanField().waitFor(),
  })
  await step("Scan the label you printed. It opens the item.", scanField(), {
    action: "type",
    value: charizardCode,
    zoom: true,
    then: async () => {
      await scanField().press("Enter")
      await page.getByTestId("item-sku").waitFor()
      await t.settle(700)
    },
  })
  await centre(page.getByTestId("item-photos"))
  await step("Under Photos, press Take photo. The same button is on the Saved screen after you add something.", page.getByTestId("item-photos").getByRole("button", { name: "Take photo" }), {
    then: () => page.getByTestId("photo-sheet").getByTestId("photo-guide").waitFor(),
  })
  const sheet = () => page.getByTestId("photo-sheet")
  await show("The camera shows a frame. Lay the card flat on a plain background and fill the frame with it.", sheet().getByLabel("Camera viewfinder"), {
    zoom: true,
    hold: 5,
  })
  await step("Press Take photo.", sheet().getByRole("button", { name: "Take photo" }), {
    then: () => sheet().getByTestId("photo-review").waitFor(),
  })
  await show("This is the photo, cropped to the frame. If it is not right, press Take it again.", sheet().getByTestId("photo-review"), {
    zoom: true,
    hold: 5,
  })
  await step("Press Save photo.", sheet().getByRole("button", { name: "Save photo" }), {
    then: () => sheet().waitFor({ state: "hidden" }),
  })
  await show("The photo is on the item. The first photo is the one the website shows.", page.getByTestId("item-photo").first(), {
    zoom: true,
  })

  // --- The item page ------------------------------------------------------------
  await page.evaluate(() => window.scrollTo(0, 0))
  await show("At the top of the item page is the price. Press Edit to change it.", page.getByTestId("item-price").locator("xpath=.."), {
    section: "The item page",
    zoom: true,
  })
  await centre(page.getByTestId("item-branch"))
  await show("Branch says where it is filed in the tree. Press Change to move it somewhere else.", page.getByTestId("item-branch").locator("xpath=../.."), {
    zoom: true,
  })
  await step("The Website switch decides whether the item is listed on the shop's website. Switch it on.", page.getByRole("switch", { name: "Show on the website" }), {
    zoom: true,
    then: () => page.getByTestId("item-website-note").getByText("On the website now.").waitFor(),
  })
  await show("It now says Shown online, and the line underneath says it is on the website. Switch it off again to take it down.", page.getByTestId("item-website"), {
    zoom: true,
    hold: 5,
  })

  // --- Find it again ---------------------------------------------------------------
  await step("To find stock again, open Stock.", mainNav("Stock"), {
    section: "Find it again",
    then: () => page.getByTestId("stock-row").first().waitFor(),
  })
  await step("Narrow the list by branch. Press Choose a branch.", page.getByRole("button", { name: "Choose a branch" }), {
    then: () => picker().waitFor(),
  })
  await step("Start with Trading cards.", pickRow("Trading cards"), { zoom: true })
  await step("Then Pokémon.", pickRow("Pokémon"), { zoom: true })
  await step("Press Choose this branch. The list keeps everything in Pokémon, and everything beneath it.", picker().getByRole("button", { name: "Choose this branch" }), {
    zoom: true,
    then: () => picker().waitFor({ state: "hidden" }),
  })
  await step("Now narrow it further in the search box. It takes a title, a code, a set or a barcode.", page.getByLabel("Search stock"), {
    action: "type",
    value: "charizard",
    zoom: true,
    then: async () => {
      await page.getByTestId("stock-row").filter({ hasText: "Charizard ex" }).first().waitFor()
      await t.settle(600)
    },
  })
  await show("Each row shows the item, its code, category, condition, price and status. Press a row to open it.", page.getByTestId("stock-row").first(), {
    zoom: true,
    hold: 5,
  })

  await t.finish()
}
