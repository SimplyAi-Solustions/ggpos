import { describe, expect, it, vi } from "vitest"

import {
  centredCrop,
  cropToFrame,
  GUIDE_SCALE,
  guideBox,
  itemPhotoName,
  outputSize,
} from "@/features/photos/crop"
import type { DownscaleDeps } from "@/features/tradein/id-photo"

/**
 * An item photo keeps the item's frame (the platform ratio), centred, is
 * written at 1600px on the long edge at most and leaves as a re-encoded
 * JPEG, so the EXIF the device wrote never reaches the server.
 */

const CARD = [63, 88] as const
const N64_BOX = [195, 135] as const

function fakeDeps(size: { width: number; height: number }) {
  const drawImage = vi.fn()
  const toDataURL = vi.fn(() => "data:image/jpeg;base64,/9j/4AAQ")
  const release = vi.fn()
  const canvases: { width: number; height: number }[] = []
  const deps: DownscaleDeps = {
    decode: async () => ({ source: {} as CanvasImageSource, width: size.width, height: size.height, release }),
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

describe("the centred crop", () => {
  it("cuts a portrait card out of a landscape photo on its height", () => {
    // 4032 x 3024 phone photo, 63:88 card: the full height, 2165 wide.
    expect(centredCrop({ width: 4032, height: 3024 }, CARD)).toEqual({
      x: 934,
      y: 0,
      width: 2165,
      height: 3024,
    })
  })

  it("cuts a landscape box out of a portrait photo on its width", () => {
    const crop = centredCrop({ width: 3024, height: 4032 }, N64_BOX)
    expect(crop.width).toBe(3024)
    expect(crop.height).toBe(2094)
    expect(crop.x).toBe(0)
    expect(crop.y).toBe(969)
  })

  it("keeps the ratio to within a pixel", () => {
    const crop = centredCrop({ width: 1280, height: 720 }, CARD)
    expect(Math.abs(crop.width / crop.height - 63 / 88)).toBeLessThan(1 / crop.height)
  })

  it("scales about the centre for the webcam's guide", () => {
    const full = centredCrop({ width: 1280, height: 720 }, CARD)
    const guide = centredCrop({ width: 1280, height: 720 }, CARD, GUIDE_SCALE)
    expect(guide.height).toBe(Math.round(720 * GUIDE_SCALE))
    // Centred to within the one pixel whole-pixel rounding can move it.
    expect(Math.abs(guide.x + guide.width / 2 - (full.x + full.width / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(guide.y + guide.height / 2 - 360)).toBeLessThanOrEqual(1)
  })

  it("never leaves the picture, and never goes below a pixel", () => {
    const crop = centredCrop({ width: 3, height: 2 }, CARD, 0.01)
    expect(crop.width).toBeGreaterThanOrEqual(1)
    expect(crop.height).toBeGreaterThanOrEqual(1)
    expect(crop.x + crop.width).toBeLessThanOrEqual(3)
    expect(crop.y + crop.height).toBeLessThanOrEqual(2)
  })

  it("keeps the whole picture when the frame is broken", () => {
    expect(centredCrop({ width: 800, height: 600 }, [0, 0])).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })
})

describe("the guide over the live picture", () => {
  it("is the webcam crop as fractions of the picture", () => {
    const box = guideBox({ width: 1280, height: 720 }, CARD)
    const crop = centredCrop({ width: 1280, height: 720 }, CARD, GUIDE_SCALE)
    expect(box.x).toBeCloseTo(crop.x / 1280, 6)
    expect(box.height).toBeCloseTo(crop.height / 720, 6)
    expect(box.x * 2 + box.width).toBeCloseTo(1, 2)
  })

  it("covers everything before the camera has a size", () => {
    expect(guideBox({ width: 0, height: 0 }, CARD)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe("the size it is written at", () => {
  it("is 1600px on the long edge at most", () => {
    expect(outputSize({ width: 2165, height: 3024 })).toEqual({ width: 1146, height: 1600 })
  })

  it("is never blown up", () => {
    expect(outputSize({ width: 630, height: 880 })).toEqual({ width: 630, height: 880 })
  })
})

describe("cropToFrame", () => {
  it("draws only the kept part at the capped size and re-encodes it as JPEG", async () => {
    const { deps, drawImage, canvases, release, toDataURL } = fakeDeps({ width: 4032, height: 3024 })
    const result = await cropToFrame(new Blob(["x"]), { ratio: CARD, deps })

    expect(canvases).toEqual([{ width: 1146, height: 1600 }])
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 934, 0, 2165, 3024, 0, 0, 1146, 1600)
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", expect.any(Number))
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.width).toBe(1146)
    expect(result.height).toBe(1600)
    expect(result.blob.type).toBe("image/jpeg")
  })

  it("takes a webcam frame already decoded, inside the guide", async () => {
    const { deps, drawImage, canvases } = fakeDeps({ width: 1, height: 1 })
    await cropToFrame({ source: {} as CanvasImageSource, width: 1280, height: 720 }, { ratio: CARD, scale: GUIDE_SCALE, deps })
    const crop = centredCrop({ width: 1280, height: 720 }, CARD, GUIDE_SCALE)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
    expect(canvases[0]).toEqual({ width: crop.width, height: crop.height })
  })

  it("refuses a picture with nothing in it", async () => {
    const { deps } = fakeDeps({ width: 0, height: 0 })
    await expect(cropToFrame(new Blob(["x"]), { ratio: CARD, deps })).rejects.toThrow(
      "That photo has no picture in it. Take it again."
    )
  })
})

describe("the file name", () => {
  it("says which item and when", () => {
    expect(itemPhotoName("GGS7F3K2Q", new Date("2026-10-09T12:00:00Z"))).toBe("ggs7f3k2q-2026-10-09.jpg")
  })
})
