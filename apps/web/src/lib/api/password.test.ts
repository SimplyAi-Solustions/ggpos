import { afterEach, describe, expect, it, vi } from "vitest"
import { ClientResponseError } from "pocketbase"

import { changeOwnPassword } from "@/lib/api"
import { setDataMode } from "@/lib/api/mode"
import { pb } from "@/lib/pb"

/**
 * The one thing that is easy to get wrong about a password change: when
 * the auth store moves.
 *
 * The change goes through `POST /api/vault/staff/me/password`, which
 * works for every role and rotates the account's token key, so the token
 * it was made with is dead the moment it succeeds. If the store were
 * re-saved at that point the counter's gate would see an unlocked staff
 * member on a dead token and swap the whole counter in around a
 * half-finished form. So the store has to change exactly once, at the
 * re-authentication, and with the new token.
 */

/**
 * A token the SDK will call valid: `isValid` only checks that the payload
 * decodes to a non-empty object with no `exp` in the past, never a real
 * signature, so any base64url-encoded JSON does.
 */
function fakeToken(payload: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.signature`
}

const EMAIL = "first-admin@ggentertainment.co.uk"
const OLD_TOKEN = fakeToken({ id: "staff_1", v: "before" })
const NEW_TOKEN = fakeToken({ id: "staff_1", v: "after" })

const LOCKED = {
  id: "staff_1",
  collectionId: "staff",
  collectionName: "staff",
  email: EMAIL,
  name: "First Admin",
  role: "admin",
  active: true,
  must_change_password: true,
}
const UNLOCKED = { ...LOCKED, must_change_password: false }

afterEach(() => {
  pb.authStore.clear()
  vi.restoreAllMocks()
})

describe("changeOwnPassword", () => {
  it("moves the auth store once, at the re-auth, and never on the dead token", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, LOCKED)

    const tokensSeen: string[] = []
    const stop = pb.authStore.onChange((token) => tokensSeen.push(token))

    // What the change is sent as, and what the store held while it ran.
    let tokenDuringUpdate = ""
    const send = vi.spyOn(pb, "send").mockImplementation(async () => {
      tokenDuringUpdate = pb.authStore.token
      return {}
    })
    const update = vi.spyOn(pb.collection("staff"), "update")
    const authWithPassword = vi
      .spyOn(pb.collection("staff"), "authWithPassword")
      .mockImplementation((async () => {
        pb.authStore.save(NEW_TOKEN, UNLOCKED)
        return { token: NEW_TOKEN, record: UNLOCKED }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any)

    const record = await changeOwnPassword(EMAIL, "the-temporary-one", "a-brand-new-password")
    stop()

    expect(tokensSeen).toEqual([NEW_TOKEN])
    expect(tokenDuringUpdate).toBe(OLD_TOKEN)
    expect(record.must_change_password).toBe(false)

    // The route, not the SDK's record update: that one is admin-only by
    // the collection rule, and re-saves the auth store with the dead token
    // as a side effect.
    expect(update).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe("/api/vault/staff/me/password")
    expect(send.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      body: {
        old_password: "the-temporary-one",
        password: "a-brand-new-password",
      },
    })
    expect(authWithPassword).toHaveBeenCalledWith(EMAIL, "a-brand-new-password")
  })

  it("leaves the store where it was when the change itself is refused", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, LOCKED)

    const tokensSeen: string[] = []
    const stop = pb.authStore.onChange((token) => tokensSeen.push(token))

    vi.spyOn(pb, "send").mockRejectedValue(new Error("refused"))
    const authWithPassword = vi.spyOn(pb.collection("staff"), "authWithPassword")

    await expect(
      changeOwnPassword(EMAIL, "the-wrong-one", "a-brand-new-password")
    ).rejects.toThrow()
    stop()

    expect(tokensSeen).toEqual([])
    expect(authWithPassword).not.toHaveBeenCalled()
    expect(pb.authStore.token).toBe(OLD_TOKEN)
  })

  it("shows the route's own sentence for a wrong current password", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, LOCKED)

    vi.spyOn(pb, "send").mockRejectedValue(
      new ClientResponseError({
        status: 400,
        response: { code: 400, message: "That is not your current password.", data: {} },
      })
    )

    await expect(
      changeOwnPassword(EMAIL, "the-wrong-one", "a-brand-new-password")
    ).rejects.toThrow("That is not your current password.")
  })

  it("works for an ordinary member of staff, not only an admin", async () => {
    setDataMode(false)
    pb.authStore.save(OLD_TOKEN, { ...LOCKED, role: "staff" })

    const send = vi.spyOn(pb, "send").mockResolvedValue({})
    vi.spyOn(pb.collection("staff"), "authWithPassword").mockImplementation((async () => {
      pb.authStore.save(NEW_TOKEN, { ...UNLOCKED, role: "staff" })
      return { token: NEW_TOKEN, record: { ...UNLOCKED, role: "staff" } }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)

    const record = await changeOwnPassword(EMAIL, "the-temporary-one", "a-brand-new-password")
    expect(record.role).toBe("staff")
    expect(send.mock.calls[0]![0]).toBe("/api/vault/staff/me/password")
  })
})
