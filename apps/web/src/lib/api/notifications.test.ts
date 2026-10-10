import { describe, expect, it } from "vitest"

import { toNotificationPage } from "@/lib/api/notifications"
import type { NotificationRow } from "@/lib/api/types"

function row(id: string, read = false): NotificationRow {
  return {
    id,
    type: "quote_offer",
    title: `Notification ${id}`,
    body: "Something happened.",
    created: "2026-09-19T10:00:00Z",
    ...(read ? { read_at: "2026-09-19T11:00:00Z" } : {}),
  }
}

describe("toNotificationPage", () => {
  it("reads the shipped { items, unread } shape", () => {
    const page = toNotificationPage({ items: [row("a"), row("b", true)], unread: 1 })
    expect(page.items).toHaveLength(2)
    expect(page.unread).toBe(1)
  })

  it("reads the earlier { notifications } draft", () => {
    const page = toNotificationPage({ notifications: [row("a"), row("b")] })
    expect(page.items.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(page.unread).toBe(2)
  })

  it("reads a bare array, which a plain collection read gives", () => {
    const page = toNotificationPage([row("a", true)])
    expect(page.items).toHaveLength(1)
    expect(page.unread).toBe(0)
  })

  it("counts the unread rows itself when the server sends no count", () => {
    const page = toNotificationPage({ items: [row("a"), row("b", true), row("c")] })
    expect(page.unread).toBe(2)
  })

  it("trusts the server's own count when it sends one", () => {
    // The route caps the list at 50, so its count is the truth and the rows
    // on screen may be fewer than the badge says.
    const page = toNotificationPage({ items: [row("a")], unread: 7 })
    expect(page.unread).toBe(7)
  })

  it("answers an empty page rather than throwing on a shape it cannot read", () => {
    expect(toNotificationPage(null)).toEqual({ items: [], unread: 0 })
    expect(toNotificationPage({ nothing: true })).toEqual({ items: [], unread: 0 })
  })
})
