import { afterEach, describe, expect, it, vi } from "vitest"

import {
  chooseUsbPrinter,
  describePrinterError,
  findUsbPrinter,
  openPrinter,
  PRINTER_MESSAGES,
  PrinterError,
  sendToPrinter,
  usbPrintingSupported,
  type UsbDeviceLike,
  type UsbLike,
} from "@/features/printing/usb"

/** A printer that records what it was sent, the way the e2e fake does. */
function fakePrinter(overrides: Partial<UsbDeviceLike> = {}) {
  const written: number[][] = []
  const device: UsbDeviceLike = {
    productName: "ORGSTA T003",
    opened: false,
    configuration: null,
    configurations: [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 3,
              endpoints: [{ endpointNumber: 2, direction: "in", type: "interrupt" }],
            },
          },
          {
            interfaceNumber: 1,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 7,
              endpoints: [
                { endpointNumber: 1, direction: "in", type: "bulk" },
                { endpointNumber: 3, direction: "out", type: "bulk" },
              ],
            },
          },
        ],
      },
    ],
    async open() {
      device.opened = true
    },
    async selectConfiguration(value: number) {
      device.configuration =
        device.configurations?.find((entry) => entry.configurationValue === value) ??
        null
    },
    async claimInterface() {},
    async transferOut(_endpoint: number, data: BufferSource) {
      written.push(Array.from(new Uint8Array(data as ArrayBufferView["buffer"])))
      return { status: "ok", bytesWritten: (data as Uint8Array).length }
    },
    ...overrides,
  }
  return { device, written }
}

function withUsb(api: Partial<UsbLike>) {
  Object.defineProperty(navigator, "usb", {
    configurable: true,
    value: api as UsbLike,
  })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "usb")
})

describe("whether this browser can print at all", () => {
  it("is false without WebUSB, which is what a phone and Safari have", () => {
    expect(usbPrintingSupported()).toBe(false)
  })

  it("is true in Chrome on the counter PC", () => {
    withUsb({})
    expect(usbPrintingSupported()).toBe(true)
  })

  it("says so in words rather than failing silently", async () => {
    await expect(chooseUsbPrinter()).rejects.toThrow(PRINTER_MESSAGES.unsupported)
  })
})

describe("opening the printer", () => {
  it("claims the interface whose class is printer, and its bulk OUT endpoint", async () => {
    const { device } = fakePrinter()
    const claimed = vi.fn(async () => {})
    device.claimInterface = claimed

    const printer = await openPrinter(device)

    expect(device.opened).toBe(true)
    expect(device.configuration?.configurationValue).toBe(1)
    expect(claimed).toHaveBeenCalledWith(1)
    expect(printer.endpointNumber).toBe(3)
    expect(printer.name).toBe("ORGSTA T003")
  })

  it("falls back to the first interface with a bulk OUT endpoint", async () => {
    const { device } = fakePrinter()
    device.configurations = [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 4,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 255,
              endpoints: [{ endpointNumber: 2, direction: "out", type: "bulk" }],
            },
          },
        ],
      },
    ]
    const printer = await openPrinter(device)
    expect(printer.interfaceNumber).toBe(4)
    expect(printer.endpointNumber).toBe(2)
  })

  it("refuses a device with nothing to print to", async () => {
    const { device } = fakePrinter()
    device.configurations = [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 3,
              endpoints: [{ endpointNumber: 1, direction: "in", type: "interrupt" }],
            },
          },
        ],
      },
    ]
    await expect(openPrinter(device)).rejects.toThrow(PRINTER_MESSAGES.no_endpoint)
  })

  it("names Zadig when Windows has not bound WinUSB to the printer", async () => {
    const { device } = fakePrinter()
    device.open = async () => {
      const error = new Error("Access denied.")
      error.name = "SecurityError"
      throw error
    }
    await expect(openPrinter(device)).rejects.toThrow(PRINTER_MESSAGES.not_bound)
    await expect(openPrinter(device)).rejects.toMatchObject({ fault: "not_bound" })
  })

  it("says the same when another program is holding the interface", async () => {
    const { device } = fakePrinter()
    device.claimInterface = async () => {
      const error = new Error("Unable to claim interface.")
      error.name = "NetworkError"
      throw error
    }
    await expect(openPrinter(device)).rejects.toThrow(PRINTER_MESSAGES.not_bound)
  })
})

describe("the picker", () => {
  it("asks with no filter, because the T003 publishes no ids", async () => {
    const { device } = fakePrinter()
    const requestDevice = vi.fn(async () => device)
    withUsb({ requestDevice })

    const printer = await chooseUsbPrinter()

    expect(requestDevice).toHaveBeenCalledWith({ filters: [] })
    expect(printer.name).toBe("ORGSTA T003")
  })

  it("treats a closed picker as a change of mind, not a fault", async () => {
    withUsb({
      requestDevice: async () => {
        const error = new Error("No device selected.")
        error.name = "NotFoundError"
        throw error
      },
    })
    await expect(chooseUsbPrinter()).rejects.toThrow(PRINTER_MESSAGES.cancelled)
  })

  it("finds a printer the browser already remembers, with nothing to press", async () => {
    const { device } = fakePrinter()
    withUsb({ getDevices: async () => [device] })
    const printer = await findUsbPrinter()
    expect(printer?.name).toBe("ORGSTA T003")
  })

  it("passes over a remembered device that is not a printer", async () => {
    const { device: scanner } = fakePrinter()
    scanner.configurations = [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 3,
              endpoints: [{ endpointNumber: 1, direction: "in", type: "interrupt" }],
            },
          },
        ],
      },
    ]
    withUsb({ getDevices: async () => [scanner] })
    expect(await findUsbPrinter()).toBeNull()
  })

  it("is null, not an error, where there is no WebUSB at all", async () => {
    expect(await findUsbPrinter()).toBeNull()
  })
})

describe("sending a label", () => {
  it("writes the bytes to the bulk OUT endpoint", async () => {
    const { device, written } = fakePrinter()
    const printer = await openPrinter(device)
    await sendToPrinter(printer, new Uint8Array([0x53, 0x49, 0x5a, 0x45]))
    expect(written).toEqual([[0x53, 0x49, 0x5a, 0x45]])
  })

  it("says the printer was unplugged when it stops answering", async () => {
    const { device } = fakePrinter()
    const printer = await openPrinter(device)
    device.transferOut = async () => {
      const error = new Error("The device was disconnected.")
      error.name = "NetworkError"
      throw error
    }
    await expect(
      sendToPrinter(printer, new Uint8Array([1, 2, 3]))
    ).rejects.toThrow(PRINTER_MESSAGES.disconnected)
  })

  it("treats a stalled transfer as a job that did not print", async () => {
    const { device } = fakePrinter()
    const printer = await openPrinter(device)
    device.transferOut = async () => ({ status: "stall", bytesWritten: 0 })
    await expect(sendToPrinter(printer, new Uint8Array([1]))).rejects.toThrow(
      PRINTER_MESSAGES.failed
    )
  })
})

describe("describing a fault", () => {
  it("keeps a message that has already been put into words", () => {
    const error = new PrinterError("not_bound")
    expect(describePrinterError(error, "send")).toBe(error)
  })

  it("falls back to what to check, rather than to the browser's own wording", () => {
    expect(describePrinterError(new Error("boom"), "send").message).toBe(
      PRINTER_MESSAGES.failed
    )
  })
})
