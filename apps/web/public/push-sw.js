/**
 * The push half of GG Vault's service worker.
 *
 * Workbox writes the precache and the read-through caches; this file is
 * pulled into the same worker through the VitePWA config's `importScripts`,
 * so there is one registration and one worker rather than two fighting over
 * the scope.
 *
 * The server sends a small JSON payload: `{ title, body, link, tag }`. It is
 * the only thing shown, so nothing personal is ever invented here, and a
 * malformed or empty payload still shows a plain notification rather than
 * throwing inside the worker.
 */

function parsePayload(event) {
  const fallback = {
    title: "GG Vault",
    body: "Open My Vault to see what has changed.",
    link: "/account/notifications",
    tag: "gg-vault",
  }
  if (!event.data) return fallback
  try {
    const data = event.data.json()
    return {
      title: typeof data.title === "string" && data.title ? data.title : fallback.title,
      body: typeof data.body === "string" && data.body ? data.body : fallback.body,
      link: typeof data.link === "string" && data.link ? data.link : fallback.link,
      tag: typeof data.tag === "string" && data.tag ? data.tag : fallback.tag,
    }
  } catch {
    const text = event.data.text()
    return { ...fallback, body: text || fallback.body }
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePayload(event)
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { link: payload.link },
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || "/account"
  const target = new URL(link, self.location.origin).href

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        // Only a tab already on My Vault or the estimate page is reused. A
        // staff member with the counter open in another tab must not have it
        // navigated out from under them by a customer notification, and
        // neither must anything else this origin happens to be serving.
        const portal = windows.find((client) => {
          if (!client.url.startsWith(self.location.origin)) return false
          const path = new URL(client.url).pathname
          return (
            path === "/account" ||
            path.startsWith("/account/") ||
            path === "/estimate" ||
            path.startsWith("/c/")
          )
        })
        if (portal && "navigate" in portal) {
          return portal.focus().then(() => portal.navigate(target))
        }
        return self.clients.openWindow(target)
      })
  )
})
