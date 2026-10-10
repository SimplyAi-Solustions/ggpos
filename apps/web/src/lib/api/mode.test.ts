import { describe, expect, it } from "vitest"

import { decideMode } from "@/lib/api/mode"

/**
 * The base case: no flag, no query, no sticky, a live server. `switchable`
 * is true here because most of these cases are about what the switch does
 * once a build honours it; the cases that matter set it false themselves.
 */
const BASE = {
  flag: false,
  query: false,
  switchable: true,
  sticky: false,
  dev: false,
  alive: true,
}

describe("decideMode", () => {
  it("enters demo mode on the build-time flag, whatever the server is doing", () => {
    expect(decideMode({ ...BASE, flag: true, alive: false })).toEqual({
      demo: true,
      unreachable: false,
      writeSticky: false,
    })
  })

  it("enters demo mode on ?demo=1 and asks for it to stick", () => {
    expect(decideMode({ ...BASE, query: true, alive: false })).toEqual({
      demo: true,
      unreachable: false,
      writeSticky: true,
    })
  })

  it("stays in demo mode from an earlier sticky visit, without writing it again", () => {
    expect(decideMode({ ...BASE, sticky: true, alive: false })).toEqual({
      demo: true,
      unreachable: false,
      writeSticky: false,
    })
  })

  it("falls back to demo data in a dev server when PocketBase is unreachable", () => {
    expect(decideMode({ ...BASE, dev: true, alive: false })).toEqual({
      demo: true,
      unreachable: false,
      writeSticky: false,
    })
  })

  it("never falls back to demo data in a production build when PocketBase is unreachable", () => {
    expect(decideMode({ ...BASE, dev: false, alive: false })).toEqual({
      demo: false,
      unreachable: true,
      writeSticky: false,
    })
  })

  it("never writes the sticky flag from a health-check failure, dev or production", () => {
    expect(decideMode({ ...BASE, dev: true, alive: false }).writeSticky).toBe(false)
    expect(decideMode({ ...BASE, dev: false, alive: false }).writeSticky).toBe(false)
  })

  it("ignores ?demo=1 in a build that does not carry the switch", () => {
    expect(decideMode({ ...BASE, query: true, switchable: false, alive: false })).toEqual({
      demo: false,
      unreachable: true,
      writeSticky: false,
    })
  })

  it("ignores a sticky flag in a build that does not carry the switch", () => {
    expect(
      decideMode({ ...BASE, sticky: true, switchable: false, alive: false })
    ).toEqual({ demo: false, unreachable: true, writeSticky: false })
  })

  it("still honours VITE_DEMO=1 without the switch, which is a demo build", () => {
    expect(decideMode({ ...BASE, flag: true, switchable: false, alive: false })).toEqual({
      demo: true,
      unreachable: false,
      writeSticky: false,
    })
  })

  it("is live, not demo, once the server answers, even in dev", () => {
    expect(decideMode({ ...BASE, dev: true, alive: true })).toEqual({
      demo: false,
      unreachable: false,
      writeSticky: false,
    })
  })

  it("is live in a production build with a reachable server", () => {
    expect(decideMode(BASE)).toEqual({
      demo: false,
      unreachable: false,
      writeSticky: false,
    })
  })
})
