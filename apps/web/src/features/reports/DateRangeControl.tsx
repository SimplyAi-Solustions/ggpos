/**
 * The date range every report runs on: seven preset chips, two underline
 * date fields when the preset is Custom, and the grouping and breakdown
 * beside them.
 *
 * Nothing here decides anything: it reports what was picked and the screen
 * owns the range, so a saved view can set the same controls without a second
 * code path.
 */
import * as React from "react"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Field } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ReportGroup } from "@/lib/api/types"
import {
  PRESETS,
  presetFor,
  resolvePreset,
  type DateRange,
  type PresetKey,
} from "@/features/reports/range"

const GROUPS: { key: ReportGroup; label: string }[] = [
  { key: "day", label: "By day" },
  { key: "week", label: "By week" },
  { key: "month", label: "By month" },
]

export interface DateRangeControlProps {
  range: DateRange
  onRangeChange: (range: DateRange) => void
  today: string
  group: ReportGroup
  onGroupChange: (group: ReportGroup) => void
  /** Empty when the report takes no breakdown of its own. */
  dimensions: { key: string; label: string }[]
  by: string
  onByChange: (by: string) => void
  /** Said under the fields when the range is one the routes will refuse. */
  error?: string | null
}

export function DateRangeControl({
  range,
  onRangeChange,
  today,
  group,
  onGroupChange,
  dimensions,
  by,
  onByChange,
  error,
}: DateRangeControlProps) {
  const matched = presetFor(range, today)
  // Custom stays chosen while the dates are edited, even when what is typed
  // happens to match a preset: the chips should not jump about underneath.
  const [custom, setCustom] = React.useState(matched === "custom")
  const preset: PresetKey = custom ? "custom" : matched

  function choose(next: PresetKey) {
    if (next === "custom") {
      setCustom(true)
      return
    }
    setCustom(false)
    onRangeChange(resolvePreset(next, today))
  }

  return (
    <div className="mt-10">
      <ChipGroup
        aria-label="Date range"
        value={[preset]}
        onValueChange={(next: string[]) => {
          const chosen = next[0] as PresetKey | undefined
          if (chosen) choose(chosen)
        }}
      >
        {PRESETS.map((entry) => (
          <Chip key={entry.key} value={entry.key} data-testid={`preset-${entry.key}`}>
            {entry.label}
          </Chip>
        ))}
      </ChipGroup>

      {preset === "custom" ? (
        <div className="mt-8 flex flex-col gap-8 min-[560px]:flex-row min-[560px]:gap-10">
          <Field label="From" htmlFor="range-from" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="range-from"
              type="date"
              value={range.from}
              max={today}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => onRangeChange({ ...range, from: event.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="range-to" layout="stacked" className="min-[560px]:w-52">
            <Input
              id="range-to"
              type="date"
              value={range.to}
              max={today}
              aria-invalid={Boolean(error) || undefined}
              onChange={(event) => onRangeChange({ ...range, to: event.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-8 flex flex-col gap-8 min-[560px]:flex-row min-[560px]:gap-10">
        <Field label="Group" htmlFor="range-group" layout="stacked" className="min-[560px]:w-52">
          <Select
            value={group}
            onValueChange={(next) => onGroupChange((next as ReportGroup) ?? "day")}
          >
            <SelectTrigger id="range-group">
              <SelectValue>
                {(value: string) =>
                  GROUPS.find((entry) => entry.key === value)?.label ?? "By day"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {dimensions.length > 1 ? (
          <Field label="Break down by" htmlFor="range-by" layout="stacked" className="min-[560px]:w-52">
            <Select value={by} onValueChange={(next) => onByChange(next ?? "")}>
              <SelectTrigger id="range-by">
                <SelectValue>
                  {(value: string) =>
                    dimensions.find((entry) => entry.key === value)?.label ??
                    dimensions[0]?.label ??
                    ""
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {dimensions.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>
    </div>
  )
}
