import { describe, expect, it, vi } from "vitest"

import {
  shareActionLabel,
  shareOrCopy,
  shareResultSentence,
  type ShareTarget,
} from "@/features/portal/share"

const PAYLOAD = {
  title: "GG Guild",
  text: "Join GG Guild with my code GGC-4K7M2.",
  copy: "GGC-4K7M2",
}

function abort(): Error {
  const error = new Error("The user cancelled the share")
  error.name = "AbortError"
  return error
}

describe("shareOrCopy", () => {
  it("opens the share sheet when there is one", async () => {
    const share = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    const target: ShareTarget = { share, writeText }

    await expect(shareOrCopy(PAYLOAD, target)).resolves.toBe("shared")
    expect(share).toHaveBeenCalledWith({
      title: "GG Guild",
      text: "Join GG Guild with my code GGC-4K7M2.",
      url: undefined,
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it("does not quietly copy when the sheet is cancelled", async () => {
    const writeText = vi.fn(async () => {})
    const target: ShareTarget = {
      share: vi.fn(async () => {
        throw abort()
      }),
      writeText,
    }

    await expect(shareOrCopy(PAYLOAD, target)).resolves.toBe("cancelled")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("falls back to the clipboard when the share itself fails", async () => {
    // An insecure origin or a missing user gesture: nothing has happened
    // yet, so the copy is still worth trying.
    const writeText = vi.fn(async () => {})
    const target: ShareTarget = {
      share: vi.fn(async () => {
        throw new Error("Permission denied")
      }),
      writeText,
    }

    await expect(shareOrCopy(PAYLOAD, target)).resolves.toBe("copied")
    expect(writeText).toHaveBeenCalledWith("GGC-4K7M2")
  })

  it("copies the code alone on a browser with no share sheet", async () => {
    const writeText = vi.fn(async () => {})

    await expect(shareOrCopy(PAYLOAD, { writeText })).resolves.toBe("copied")
    expect(writeText).toHaveBeenCalledWith("GGC-4K7M2")
  })

  it("says so when the clipboard refuses", async () => {
    const target: ShareTarget = {
      writeText: vi.fn(async () => {
        throw new Error("Not allowed")
      }),
    }
    await expect(shareOrCopy(PAYLOAD, target)).resolves.toBe("failed")
  })

  it("says so when the browser can do neither", async () => {
    await expect(shareOrCopy(PAYLOAD, {})).resolves.toBe("failed")
  })
})

describe("what the button says", () => {
  it("names the thing it will actually do", () => {
    expect(shareActionLabel({ share: async () => {} })).toBe("Share my code")
    expect(shareActionLabel({ writeText: async () => {} })).toBe("Copy my code")
    expect(shareActionLabel({})).toBe("Copy my code")
  })

  it("says what happened afterwards, and nothing after a cancel", () => {
    expect(shareResultSentence("shared", "GGC-4K7M2")).toBe("Code shared.")
    expect(shareResultSentence("copied", "GGC-4K7M2")).toBe("Code copied.")
    expect(shareResultSentence("cancelled", "GGC-4K7M2")).toBeNull()
    expect(shareResultSentence("failed", "GGC-4K7M2")).toBe(
      "Your browser would not copy it. The code is GGC-4K7M2."
    )
  })
})
