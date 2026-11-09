import { describe, expect, it, vi } from "vitest"

import { readPreference, resolveDark, setPreference, THEME_KEY } from "@/lib/theme"

function mockSystemDark(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches: dark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  )
}

describe("theme", () => {
  it("defaults to system", () => {
    expect(readPreference()).toBe("system")
  })

  it("follows the system when set to system", () => {
    mockSystemDark(true)
    expect(resolveDark("system")).toBe(true)
    mockSystemDark(false)
    expect(resolveDark("system")).toBe(false)
  })

  it("saves a manual choice and applies the class", () => {
    mockSystemDark(false)
    setPreference("dark")
    expect(localStorage.getItem(THEME_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    setPreference("system")
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })
})
