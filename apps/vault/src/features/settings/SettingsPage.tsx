import { Settings } from "lucide-react"

import { FeaturePlaceholder } from "@/shell/FeaturePlaceholder"

export function SettingsPage() {
  return (
    <FeaturePlaceholder
      eyebrow="Admin"
      title="Settings"
      lede="Buy rates, pricing rules and shop details."
      icon={<Settings aria-hidden />}
      plans={["Default cash and credit buy rates", "Condition multipliers", "Cash cap and ID rules"]}
    />
  )
}
