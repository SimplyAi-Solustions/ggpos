import { AtlasScanRebuild } from "@/kit/AtlasScanRebuild"
import { KitPage } from "@/kit/KitPage"
import { NovaAddItemRebuild } from "@/kit/NovaAddItemRebuild"

/**
 * The router arrives with the counter screens; for now the kit is the app.
 * `?screen=atlas` and `?screen=nova` render a reference rebuild on its own,
 * at real size, so it can be screenshotted beside the reference PNG.
 */
export function App() {
  const screen = new URLSearchParams(window.location.search).get("screen")
  if (screen === "atlas") return <AtlasScanRebuild />
  if (screen === "nova") return <NovaAddItemRebuild />
  return <KitPage />
}

export default App
