import { Monitor, Moon, Sun } from "lucide-react"

import { useThemePreference, type ThemePreference } from "@/lib/theme"
import { Segmented } from "@/ui"

const OPTIONS = [
  { value: "light", label: "Light", icon: <Sun aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor aria-hidden /> },
] as const

export function ThemeToggle({ block }: { block?: boolean }) {
  const [pref, setPref] = useThemePreference()
  return (
    <Segmented<ThemePreference>
      label="Theme"
      options={OPTIONS}
      value={pref}
      onChange={setPref}
      block={block}
    />
  )
}
