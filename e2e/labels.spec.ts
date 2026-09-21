import { expect, test, type Page } from "@playwright/test"

/**
 * The label queue at both widths: the cross-device print queue driven by a
 * fake WebUSB printer, and bulk reprint.
 *
 * The fake printer is injected before the app loads and records every byte
 * it is handed, so this asserts the real TSPL2 the T003 would receive rather
 * than that a button was pressed. It holds the first transfer until the test
 * lets go, which is what makes the `printing` state on the queue something
 * that can be looked at rather than raced.
 */

const DEMO_EMAIL = "demo@ggentertainment.co.uk"
const DEMO_PASSWORD = "ggvault-demo"

/** The first demo buy-in, the one the shelf stock came in on. */
const BUY_IN = "GG-BI-000001"

interface FakePrinterWindow extends Window {
  __labelBytes?: string[]
  __holdPrint?: boolean
}

/** A T003 that never disagrees with itself, and remembers what it was sent. */
async function fakePrinter(page: Page) {
  await page.addInitScript(() => {
    const scope = window as FakePrinterWindow
    const written: string[] = []
    scope.__labelBytes = written
    scope.__holdPrint = true

    const device = {
      productName: "ORGSTA T003",
      opened: false,
      configuration: null as unknown,
      configurations: [
        {
          configurationValue: 1,
          interfaces: [
            {
              interfaceNumber: 0,
              alternate: {
                alternateSetting: 0,
                interfaceClass: 7,
                endpoints: [
                  { endpointNumber: 1, direction: "out", type: "bulk" },
                  { endpointNumber: 2, direction: "in", type: "bulk" },
                ],
              },
            },
          ],
        },
      ],
      async open() {
        device.opened = true
      },
      async selectConfiguration() {
        device.configuration = device.configurations[0]
      },
      async claimInterface() {},
      async transferOut(_endpoint: number, data: ArrayBufferView) {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        let text = ""
        for (const byte of bytes) text += String.fromCharCode(byte)
        written.push(text)
        // Held open so the queue can be read while the label is printing.
        while (scope.__holdPrint) {
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        return { status: "ok", bytesWritten: data.byteLength }
      },
    }

    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => device,
        getDevices: async () => [device],
      },
    })
  })
}

/** A phone: WebUSB is not there at all. */
async function noUsb(page: Page) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "usb")
    Reflect.deleteProperty(navigator, "usb")
  })
}

async function signIn(page: Page) {
  await page.goto("/login?demo=1")
  await page.getByLabel("Email").fill(DEMO_EMAIL)
  await page.getByLabel("Password").fill(DEMO_PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible()
}

/** The palette is the one way between screens that works at both widths. */
async function go(page: Page, action: string) {
  await page.keyboard.press("ControlOrMeta+k")
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()
  await palette.getByText(action, { exact: true }).click()
  await expect(palette).toBeHidden()
}

test.describe("the print queue", () => {
  test("prints the queue over USB and says which device has each label", async ({
    page,
  }) => {
    await fakePrinter(page)
    await signIn(page)
    await go(page, "Label queue")

    await expect(page.getByRole("heading", { name: "Labels" })).toBeVisible()
    // The two labels the demo counter starts the morning with.
    await expect(page.getByTestId("label-row")).toHaveCount(2)

    await page.getByTestId("connect-printer").click()
    await expect(page.getByTestId("printer-name")).toHaveText("ORGSTA T003")

    await page.getByRole("switch", { name: "Auto-print" }).click()
    await expect(page.getByTestId("auto-print")).toHaveText("Auto-print on")
    // One printer, one roll: this device takes the 40 x 20 labels and
    // leaves any other size for whoever has that roll on.
    await expect(
      page.getByText("Labels print here as Counter PC on the 40 x 20 mm roll", {
        exact: false,
      })
    ).toBeVisible()

    // Claimed by this device, and the queue says so while it prints.
    await expect(page.getByTestId("label-row").first()).toContainText(
      "Printing on Counter PC"
    )

    // The bytes are TSPL2 for the 40 x 20 top loader, not a picture of one.
    await expect
      .poll(() =>
        page.evaluate(() => (window as FakePrinterWindow).__labelBytes?.length ?? 0)
      )
      .toBeGreaterThan(0)
    const first = await page.evaluate(
      () => (window as FakePrinterWindow).__labelBytes?.[0] ?? ""
    )
    expect(first.startsWith("SIZE 40 mm,20 mm\r\n")).toBe(true)
    expect(first).toContain("GAP 2 mm,0 mm")
    expect(first).toContain("CODEPAGE 850")
    expect(first).toContain("QRCODE")
    expect(first).toContain("PRINT 1,1")

    // Let the printer finish, and both labels come out.
    await page.evaluate(() => {
      ;(window as FakePrinterWindow).__holdPrint = false
    })

    await expect(page.getByTestId("label-row")).toHaveCount(0)
    await expect(
      page.getByText("Nothing is waiting to print.", { exact: false })
    ).toBeVisible()

    await page.getByRole("button", { name: "Printed", exact: true }).click()
    await expect(page.getByTestId("label-row")).toHaveCount(2)

    const all = await page.evaluate(
      () => (window as FakePrinterWindow).__labelBytes ?? []
    )
    expect(all).toHaveLength(2)
  })

  test("tells a phone that the counter printer has it", async ({ page }) => {
    await noUsb(page)
    await signIn(page)
    await go(page, "Label queue")

    await expect(
      page.getByText("Queued for the counter printer.", { exact: false })
    ).toBeVisible()
    await expect(page.getByTestId("connect-printer")).toBeHidden()
    // Path 1 is untouched: the browser print is still one press away.
    await expect(page.getByTestId("print-all")).toBeVisible()
  })
})

test.describe("bulk reprint", () => {
  test("queues a whole buy-in and counts what was already waiting", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Label queue")

    await page.getByTestId("bulk-reprint").click()
    const sheet = page.getByTestId("bulk-reprint-sheet")
    await expect(sheet).toBeVisible()

    await sheet.getByLabel("Buy-in").fill(BUY_IN)
    await sheet.getByRole("button", { name: "Queue labels" }).click()

    // Three items came in on that buy-in and two already have a label
    // waiting, so only the third is queued.
    await expect(page.getByTestId("bulk-outcome")).toHaveText(
      "1 label queued. 2 labels were already waiting."
    )

    // Esc closes any sheet, which is the line the shortcut overlay carries.
    await page.keyboard.press("Escape")
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId("label-row")).toHaveCount(3)
  })

  test("says what a buy-in number looks like when given something else", async ({
    page,
  }) => {
    await signIn(page)
    await go(page, "Label queue")

    await page.getByTestId("bulk-reprint").click()
    const sheet = page.getByTestId("bulk-reprint-sheet")
    await sheet.getByLabel("Buy-in").fill("GGS-7F3K2Q")
    await sheet.getByRole("button", { name: "Queue labels" }).click()

    await expect(
      sheet.getByText("GGS-7F3K2Q is not a buy-in number. They look like GG-BI-000123.")
    ).toBeVisible()
  })

  test("queues a drawer with no dates at all", async ({ page }) => {
    await signIn(page)
    await go(page, "Label queue")

    await page.getByTestId("bulk-reprint").click()
    const sheet = page.getByTestId("bulk-reprint-sheet")
    await sheet.getByRole("button", { name: "Dates", exact: true }).click()

    // The route takes a location on its own, which is how a whole drawer
    // is reprinted after a spill.
    await sheet.getByLabel("Location").click()
    await page.getByRole("option", { name: "Binder A" }).click()
    await sheet.getByRole("switch").click()
    await sheet.getByRole("button", { name: "Queue labels" }).click()

    await expect(page.getByTestId("bulk-outcome")).toHaveText("1 label queued.")
  })

  test("queues by the dates stock came in", async ({ page }) => {
    await signIn(page)
    await go(page, "Label queue")

    await page.getByTestId("bulk-reprint").click()
    const sheet = page.getByTestId("bulk-reprint-sheet")
    await sheet.getByRole("button", { name: "Dates", exact: true }).click()

    const today = new Date().toISOString().slice(0, 10)
    await sheet.getByLabel("From", { exact: true }).fill(today)
    await sheet.getByLabel("To", { exact: true }).fill(today)
    // A label for something that already has one waiting, this time.
    await sheet.getByRole("switch").click()
    await sheet.getByRole("button", { name: "Queue labels" }).click()

    await expect(page.getByTestId("bulk-outcome")).toHaveText("2 labels queued.")
  })
})
