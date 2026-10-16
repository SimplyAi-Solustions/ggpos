import { describe, expect, it, vi } from "vitest"

import {
  MAX_EDGE,
  dataUrlToBlob,
  downscaleToJpeg,
  fitWithin,
  photoFileName,
  type DownscaleDeps,
} from "@/features/tradein/id-photo"

/**
 * jsdom has no image decoder and no canvas encoder, so both are injected.
 * The fake canvas records what it was asked to draw, which is the only thing
 * that matters here: an ID photo must leave the counter re-encoded from
 * pixels, because that is what drops the EXIF the phone wrote.
 */
function fakeDeps(size: { width: number; height: number }) {
  const drawImage = vi.fn()
  const toDataURL = vi.fn(() => "data:image/jpeg;base64,/9j/4AAQ")
  const release = vi.fn()
  const canvases: { width: number; height: number }[] = []

  const deps: DownscaleDeps = {
    decode: async () => ({
      source: {} as CanvasImageSource,
      width: size.width,
      height: size.height,
      release,
    }),
    createCanvas: (next) => {
      canvases.push(next)
      return {
        width: next.width,
        height: next.height,
        getContext: () => ({ drawImage }),
        toDataURL,
      } as unknown as HTMLCanvasElement
    },
  }

  return { deps, drawImage, toDataURL, release, canvases }
}

describe("fitWithin", () => {
  it("caps the long edge and keeps the ratio", () => {
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({
      width: 1600,
      height: 1200,
    })
  })

  it("caps a portrait photo on its height", () => {
    expect(fitWithin({ width: 3024, height: 4032 })).toEqual({
      width: 1200,
      height: 1600,
    })
  })

  it("leaves a photo already small enough exactly as it is", () => {
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
  })

  it("does not blow a small photo up to the cap", () => {
    const fitted = fitWithin({ width: 200, height: 100 })
    expect(Math.max(fitted.width, fitted.height)).toBeLessThan(MAX_EDGE)
  })

  it("never rounds an edge down to nothing", () => {
    expect(fitWithin({ width: 4000, height: 1 }).height).toBe(1)
  })

  it("answers zero for an image with no picture in it", () => {
    expect(fitWithin({ width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })
})

describe("downscaleToJpeg", () => {
  it("draws the photo at the capped size and re-encodes it as JPEG", async () => {
    const { deps, drawImage, canvases, release } = fakeDeps({
      width: 4032,
      height: 3024,
    })
    const result = await downscaleToJpeg(new Blob(["x"]), { deps })

    expect(canvases[0]).toEqual({ width: 1600, height: 1200 })
    expect(drawImage).toHaveBeenCalledWith({}, 0, 0, 1600, 1200)
    expect(result.dataUrl.startsWith("data:image/jpeg")).toBe(true)
    expect(result.blob.type).toBe("image/jpeg")
    expect(result.width).toBe(1600)
    // The decoded bitmap is released whatever happens next.
    expect(release).toHaveBeenCalled()
  })

  it("honours a smaller cap when one is asked for", async () => {
    const { deps, canvases } = fakeDeps({ width: 2000, height: 1000 })
    await downscaleToJpeg(new Blob(["x"]), { deps, maxEdge: 400 })
    expect(canvases[0]).toEqual({ width: 400, height: 200 })
  })

  it("says what to do when the photo has no picture in it", async () => {
    const { deps } = fakeDeps({ width: 0, height: 0 })
    await expect(downscaleToJpeg(new Blob(["x"]), { deps })).rejects.toThrow(
      /no picture/
    )
  })

  it("says what to do when the device has no 2D context", async () => {
    const deps: DownscaleDeps = {
      decode: async () => ({ source: {} as CanvasImageSource, width: 10, height: 10 }),
      createCanvas: () =>
        ({ getContext: () => null }) as unknown as HTMLCanvasElement,
    }
    await expect(downscaleToJpeg(new Blob(["x"]), { deps })).rejects.toThrow(
      /another device/
    )
  })
})

describe("dataUrlToBlob", () => {
  it("reads the type out of the header", () => {
    const blob = dataUrlToBlob("data:image/jpeg;base64,/9j/4AAQ")
    expect(blob.type).toBe("image/jpeg")
    expect(blob.size).toBeGreaterThan(0)
  })
})

describe("photoFileName", () => {
  it("names the file after the day it was taken", () => {
    expect(photoFileName(new Date("2026-09-20T09:00:00Z"))).toBe("id-2026-09-20.jpg")
  })
})
