import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { cn } from "cn"

import { useTheme } from "@/components/theme-provider"

/**
 * The customer theme controls, with the same behaviour as the Counter's
 * toggle: light, dark or follow the system, persisted, applied before first
 * paint by index.html. Customers start in the dark (see __root.tsx).
 */

function systemDark(): boolean {
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
}

/** The header icon: one tap swaps dark and light. */
export function ThemeToggleButton({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark" || (theme === "system" && systemDark())
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light" : "Switch to dark"}
      className={cn(
        "flex size-12 items-center justify-center rounded-full text-foreground transition-colors duration-150 ease-gg hover:bg-secondary sm:size-10",
        className
      )}
    >
      {dark ? (
        <SunIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
      ) : (
        <MoonIcon aria-hidden="true" className="size-5 stroke-[1.25]" />
      )}
    </button>
  )
}

const CHOICES = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
] as const

/** The full three-way choice, for the Me screen. */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme()
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex gap-0.5 rounded-full bg-secondary p-1"
    >
      {CHOICES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors duration-150 ease-gg",
            theme === value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Icon aria-hidden="true" className="size-4 stroke-[1.25]" />
          {label}
        </button>
      ))}
    </div>
  )
}
