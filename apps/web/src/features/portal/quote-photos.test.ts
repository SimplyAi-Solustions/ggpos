import { describe, expect, it, vi } from "vitest"

import type { DownscaleDeps } from "@/features/tradein/id-photo"
import {
  MAX_PHOTOS,
  preparePhotos,
  roomLeft,
} from "@/features/portal/quote-photos"

/**
 * jsdom has no image decoder and no canvas encoder, so both are injected.
 * The fake canvas records the size it was asked to draw at, which is the
 * thing that matters: a quote photo must leave the phone re-encoded from
 * pixels, because that is what drops the EXIF the camera wrote.
 */
function fakeDeps(size = { width: 4032, height: 3024 }) {
  const drawImage = vi.fn()
  const canvases: { width: number; height: number }[] = []

  const deps: DownscaleDeps = {
    decode: async () => ({
      source: {} as CanvasImageSource,
      width: size.width,
      height: size.height,
    }),
    createCanvas: (next) => {
      canvases.push(next)
      return {
        width: next.width,
        height: next.height,
        getContext: () => ({ drawImage }),
        toDataURL: () => "data:image/jpeg;base64,/9j/4AAQ",
      } as unknown as HTMLCanvasElement
    },
  }

  return { deps, drawImage, canvases }
}

function photo(name: string, type = "image/jpeg", size = 2_000_000): File {
  const file = new File([new Uint8Array(8)], name, { type })
  // jsdom computes `size` from the parts, so it is pinned here instead.
  Object.defineProperty(file, "size", { value: size })
  return file
}

describe("preparePhotos", () => {
  it("re-encodes every photo as a capped JPEG", async () => {
    const { deps, canvases, drawImage } = fakeDeps()
    const result = await preparePhotos([photo("a.jpg"), photo("b.jpg")], 0, { deps })

    expect(result.photos).toHaveLength(2)
    expect(result.rejected).toEqual([])
    expect(canvases[0]).toEqual({ width: 1600, height: 1200 })
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(result.photos[0]!.blob.type).toBe("image/jpeg")
    expect(result.photos[0]!.preview.startsWith("data:image/jpeg")).toBe(true)
  })

  it("gives each photo an id of its own, so one can be removed", async () => {
    const { deps } = fakeDeps()
    const result = await preparePhotos([photo("a.jpg"), photo("b.jpg")], 0, { deps })
    expect(result.photos[0]!.id).not.toBe(result.photos[1]!.id)
  })

  it("refuses a file that is not a photo, and says what to send", async () => {
    const { deps } = fakeDeps()
    const result = await preparePhotos([photo("notes.pdf", "application/pdf")], 0, {
      deps,
    })
    expect(result.photos).toHaveLength(0)
    expect(result.rejected[0]).toContain("is not a photo")
    expect(result.rejected[0]).toContain("JPEG")
  })

  it("refuses a photo over 10 MB", async () => {
    const { deps } = fakeDeps()
    const result = await preparePhotos(
      [photo("huge.jpg", "image/jpeg", 11 * 1024 * 1024)],
      0,
      { deps }
    )
    expect(result.photos).toHaveLength(0)
    expect(result.rejected[0]).toContain("under 10 MB")
  })

  it("counts photos already on the form against the cap", async () => {
    const { deps } = fakeDeps()
    const result = await preparePhotos([photo("a.jpg"), photo("b.jpg")], MAX_PHOTOS - 1, {
      deps,
    })
    expect(result.photos).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]).toContain(`${MAX_PHOTOS} photos`)
  })

  it("says what to do when a photo will not open, and keeps the others", async () => {
    let call = 0
    const deps: DownscaleDeps = {
      decode: async () => {
        call += 1
        if (call === 1) throw new Error("broken")
        return { source: {} as CanvasImageSource, width: 800, height: 600 }
      },
      createCanvas: (next) =>
        ({
          ...next,
          getContext: () => ({ drawImage: vi.fn() }),
          toDataURL: () => "data:image/jpeg;base64,/9j/4AAQ",
        }) as unknown as HTMLCanvasElement,
    }

    const result = await preparePhotos([photo("bad.jpg"), photo("good.jpg")], 0, {
      deps,
    })
    expect(result.photos).toHaveLength(1)
    expect(result.rejected[0]).toContain("could not be opened")
  })
})

describe("roomLeft", () => {
  it("counts down to the cap and never below zero", () => {
    expect(roomLeft(0)).toBe(MAX_PHOTOS)
    expect(roomLeft(MAX_PHOTOS)).toBe(0)
    expect(roomLeft(MAX_PHOTOS + 5)).toBe(0)
  })
})
