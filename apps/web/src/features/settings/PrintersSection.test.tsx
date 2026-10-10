import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { setDataMode } from "@/lib/api/mode"
import { demoPrintJobs, resetDemoPrinting } from "@/lib/api/demo/printing"

/**
 * Settings, Printers, against the demo printer: the list, adding one with the
 * URL shown once, rotating, test print and removing. Demo mode answers from
 * memory with the same sentences the server uses, so what is under test is
 * the screen and not a mock of it. The painter is stood in for because a
 * test environment has no canvas.
 */

const staff = vi.hoisted(() => ({ role: "admin" as "admin" | "staff" }))
vi.mock("@/lib/auth", () => ({
  useStaff: () => ({ id: "staff_demo", email: "d@g.uk", name: "Demo", role: staff.role }),
}))

const painter = vi.hoisted(() => ({
  renderTestImage: vi.fn(),
}))
vi.mock("@/features/printing/receipt/render", () => painter)

const { PrintersSection } = await import("@/features/settings/PrintersSection")

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PrintersSection />
    </QueryClientProvider>
  )
}

/** The sheet's own fields, labelled the way a person reads them. */
async function fillAddForm(user: ReturnType<typeof userEvent.setup>, name: string, mac: string) {
  await user.type(screen.getByLabelText("Name"), name)
  await user.type(screen.getByLabelText(/MAC address/), mac)
}

beforeEach(() => {
  setDataMode(true)
  resetDemoPrinting()
  staff.role = "admin"
  painter.renderTestImage.mockReset()
  painter.renderTestImage.mockResolvedValue(new Blob(["png"], { type: "image/png" }))
})

afterEach(cleanup)

describe("the printers list", () => {
  it("shows each printer as a row: name, model, register, paper, MAC and whether it is online", async () => {
    show()
    const row = await screen.findByTestId("printer-row")
    expect(within(row).getByText("Counter printer")).toBeTruthy()
    expect(within(row).getByText("Star TSP143IV, Counter, 80 mm paper")).toBeTruthy()
    expect(within(row).getByText("00:11:e5:06:04:ff")).toBeTruthy()
    expect(within(screen.getByTestId("printer-status")).getByText("Online")).toBeTruthy()
  })

  it("says Not seen yet for a printer that has never polled", async () => {
    const { createPrinter } = await import("@/lib/api/demo/printing")
    createPrinter({ name: "Back printer", mac: "00:11:e5:06:04:aa", register: "register_demo", paper_width: 58 })
    show()
    await screen.findAllByTestId("printer-row")
    expect(screen.getByText("Not seen yet")).toBeTruthy()
    expect(screen.getByText("Counter, 58 mm paper")).toBeTruthy()
  })

  it("says what happens with no printer, in a sentence that tells staff what to do", async () => {
    const { removePrinter } = await import("@/lib/api/demo/printing")
    removePrinter("printer_demo")
    show()
    const empty = await screen.findByTestId("printers-empty")
    expect(empty.textContent).toBe(
      "No printer is set up yet. Until one is, receipts print in the browser and the drawer opens with its key."
    )
  })

  it("is for admins: anybody else is told so and gets no controls", async () => {
    staff.role = "staff"
    show()
    expect(screen.getByText(/Only an admin can set up the receipt printers/)).toBeTruthy()
    expect(screen.queryByTestId("add-printer")).toBeNull()
    expect(screen.queryByTestId("printer-row")).toBeNull()
  })
})

describe("adding a printer", () => {
  it("asks for what is missing, in words, under the field", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByTestId("add-printer"))
    await user.click(await screen.findByTestId("save-printer"))
    expect(await screen.findByText("Give the printer a name, for example Counter printer.")).toBeTruthy()
    expect(screen.getByText("Type the printer's MAC address, for example 00:11:e5:06:04:ff.")).toBeTruthy()
    // Nothing was added.
    expect(screen.queryByTestId("printer-url")).toBeNull()
  })

  it("adds it, shows the URL once with where it goes on the printer, and copies it", async () => {
    const user = userEvent.setup()
    const written: string[] = []
    // user-event installs its own clipboard stub; swap in one that records.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text)
        },
      },
    })
    show()
    await user.click(await screen.findByTestId("add-printer"))
    await fillAddForm(user, "Back printer", "00-11-E5-06-04-AA")
    await user.click(screen.getByTestId("save-printer"))

    const url = await screen.findByTestId("printer-url")
    expect(url.textContent).toMatch(/\/api\/vault\/cloudprnt\/[A-Za-z0-9]{32}$/)
    expect(screen.getByTestId("printer-url-where").textContent).toBe(
      "Printer web settings, CloudPRNT, Server URL. Polling time 2 seconds."
    )
    expect(screen.getByText(/It is shown once/)).toBeTruthy()

    await user.click(screen.getByTestId("copy-printer-url"))
    await waitFor(() => expect(written).toEqual([url.textContent]))
    expect(await screen.findByText("Copied")).toBeTruthy()

    // Done closes the sheet, and the URL is gone for good.
    await user.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByTestId("printer-url")).toBeNull())
    expect(screen.queryByText(url.textContent ?? "never")).toBeNull()

    // The new printer is in the list, not seen yet, with its MAC normalised.
    expect(await screen.findByText("Back printer")).toBeTruthy()
    expect(screen.getByText("00:11:e5:06:04:aa")).toBeTruthy()
    expect(screen.getByText("Not seen yet")).toBeTruthy()
  })

  it("says so when the browser will not copy, and leaves the URL to select", async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied")
        },
      },
    })
    show()
    await user.click(await screen.findByTestId("add-printer"))
    await fillAddForm(user, "Back printer", "00:11:e5:06:04:aa")
    await user.click(screen.getByTestId("save-printer"))
    await screen.findByTestId("printer-url")
    await user.click(screen.getByTestId("copy-printer-url"))
    expect(await screen.findByText(/would not copy it\. Select the URL and copy it by hand\./)).toBeTruthy()
  })

  it("passes on the server's sentence when the MAC address is already in use", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByTestId("add-printer"))
    await fillAddForm(user, "Another", "00:11:E5:06:04:FF")
    await user.click(screen.getByTestId("save-printer"))
    expect(
      await screen.findByText(
        "A printer with that MAC address is already set up. Edit that one, or remove it first."
      )
    ).toBeTruthy()
    expect(screen.queryByTestId("printer-url")).toBeNull()
  })
})

describe("rotating the URL", () => {
  it("asks first, then shows the new URL once", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByTestId("printer-row")
    await user.click(screen.getByRole("button", { name: /Rotate the URL for Counter printer/ }))
    const confirm = await screen.findByTestId("printer-confirm")
    expect(confirm.textContent).toContain("It prints nothing until the new URL is typed into it.")

    await user.click(within(confirm).getByRole("button", { name: "Change URL" }))
    const url = await screen.findByTestId("printer-url")
    expect(url.textContent).toMatch(/\/api\/vault\/cloudprnt\/[A-Za-z0-9]{32}$/)
    expect(screen.getByText("New printer URL")).toBeTruthy()
    expect(screen.getByText(/The old URL for Counter printer has stopped working/)).toBeTruthy()
  })

  it("can be thought better of", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByTestId("printer-row")
    await user.click(screen.getByRole("button", { name: /Rotate the URL for Counter printer/ }))
    await user.click(await screen.findByRole("button", { name: "Keep it" }))
    expect(screen.queryByTestId("printer-confirm")).toBeNull()
    expect(screen.queryByTestId("printer-url")).toBeNull()
  })
})

describe("test print", () => {
  it("draws the test image at the printer's width and queues it as a test job", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByTestId("printer-row")
    await user.click(screen.getByRole("button", { name: /Test print on Counter printer/ }))
    expect((await screen.findByTestId("printers-note")).textContent).toBe(
      "Test print sent to Counter printer. It prints within a few seconds."
    )
    expect(painter.renderTestImage).toHaveBeenCalledWith({ width: 576, printerName: "Counter printer" })
    const jobs = demoPrintJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: "test", printer: "printer_demo" })
  })

  it("says what to do when the test print does not get through", async () => {
    const user = userEvent.setup()
    painter.renderTestImage.mockRejectedValue(new TypeError("canvas"))
    show()
    await screen.findByTestId("printer-row")
    await user.click(screen.getByRole("button", { name: /Test print on Counter printer/ }))
    expect(
      await screen.findByText(
        "The test print did not reach the printer. Check the URL on the printer, then try again."
      )
    ).toBeTruthy()
  })
})

describe("removing a printer", () => {
  it("asks first, then takes it off the list", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByTestId("printer-row")
    await user.click(screen.getByRole("button", { name: "Remove Counter printer" }))
    const confirm = await screen.findByTestId("printer-confirm")
    expect(confirm.textContent).toContain("Remove Counter printer? Its queue goes with it.")

    await user.click(within(confirm).getByRole("button", { name: "Remove printer" }))
    expect((await screen.findByTestId("printers-note")).textContent).toBe(
      "Counter printer has been removed."
    )
    await waitFor(() => expect(screen.queryByTestId("printer-row")).toBeNull())
    expect(screen.getByTestId("printers-empty")).toBeTruthy()
  })
})
