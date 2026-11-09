// Runs before first paint so the page never flashes the wrong theme.
// Keep in step with src/lib/theme.ts (same storage key and class names).
;(function () {
  var pref = "system"
  try {
    pref = localStorage.getItem("gg-vault-theme") || "system"
  } catch (e) {
    // Private browsing: follow the system.
  }
  var dark =
    pref === "dark" ||
    (pref !== "light" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  var root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
})()
