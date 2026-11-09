// Retires the service worker the old app (apps/web) installed at this scope.
// The vault app does not use one. A browser that still has the old worker
// checks this file for updates, installs this version, which clears the old
// caches, unregisters itself and reloads open tabs onto the live build.
self.addEventListener("install", function () {
  self.skipWaiting()
})
self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      var keys = await caches.keys()
      await Promise.all(
        keys.map(function (key) {
          return caches.delete(key)
        })
      )
      await self.registration.unregister()
      var clients = await self.clients.matchAll({ type: "window" })
      clients.forEach(function (client) {
        client.navigate(client.url)
      })
    })()
  )
})
