import { describe, expect, it } from "vitest"

import { nativeFormats } from "@/lib/scanning/camera"

/**
 * The native BarcodeDetector is only trusted when the device says it reads
 * QR codes; otherwise zxing-wasm reads the camera (deploy/README.md,
 * "Barcode scanners").
 */
describe("nativeFormats", () => {
  it("asks for what the device reads of the shop's formats", () => {
    // Chrome on a Mac (Apple Vision) lists no separate UPC-A.
    expect(nativeFormats(["aztec", "code_128", "ean_13", "ean_8", "qr_code", "upc_e"])).toEqual([
      "qr_code",
      "ean_13",
      "ean_8",
      "upc_e",
      "code_128",
    ])
  })

  it("hands over to zxing when the device cannot read a QR code", () => {
    // An Android tablet without the Play services barcode module answers [].
    expect(nativeFormats([])).toBeNull()
    expect(nativeFormats(["ean_13", "code_128"])).toBeNull()
    expect(nativeFormats(undefined)).toBeNull()
  })
})
