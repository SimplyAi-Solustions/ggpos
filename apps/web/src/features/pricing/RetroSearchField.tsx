import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { SearchIcon } from "lucide-react"
import { cn } from "cn"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Input } from "@/components/ui/input"
import { ProductImage } from "@/components/product-image"
import { RETRO_PLATFORMS, searchRetro } from "@/lib/api/lookup"
import { LOOKUP_STALE_MS } from "@/lib/api/prices"
import { refusalOrFallback } from "@/lib/api/refusal"
import { useDebounced } from "@/features/pricing/use-debounced"
import type { RetroHit } from "@/lib/api/types"

export interface RetroSearchFieldProps {
  id: string
  /** A `platforms` key. The lookup only writes a title through with one. */
  platformKey: string
  onPlatformChange: (key: string) => void
  /** The text in the box, kept by the parent so a free-text line can use it. */
  value: string
  onChange: (value: string) => void
  onChoose: (title: RetroHit) => void
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * A retro title by name, narrowed by platform.
 *
 * The platform chips come first because `retro_titles.platform` is required:
 * without one the lookup is preview-only and hands back rows with no id,
 * which cannot carry a price. A title nobody recognises is still fine, the
 * line just takes the name that was typed and a market value by hand.
 */
export function RetroSearchField({
  id,
  platformKey,
  onPlatformChange,
  value,
  onChange,
  onChoose,
  placeholder = "Super Mario Kart",
  inputRef,
}: RetroSearchFieldProps) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const listId = `${id}-listbox`

  // Debounced, not deferred: an IGDB search is a paid outbound call, so it
  // waits for the typing to stop rather than following every keystroke.
  const deferred = useDebounced(value)
  const enabled = deferred.trim().length >= 2

  const { data: results = [], isError, error } = useQuery({
    queryKey: ["lookup", "retro", platformKey, deferred],
    queryFn: ({ signal }) =>
      searchRetro(deferred, platformKey || undefined, signal),
    enabled,
    staleTime: LOOKUP_STALE_MS,
    // "IGDB did not answer. Try again, or add the title manually." is worth
    // reading straight away, not after three quiet retries.
    retry: false,
  })

  // The route's own words when it has any: a missing IGDB key and an IGDB
  // that did not answer are different problems with different answers.
  const refused =
    isError && error
      ? refusalOrFallback(
          error,
          "That search did not answer. Try again, or type the title and price it by hand."
        )
      : null

  const showList = open && enabled && results.length > 0
  const clampedActive = Math.min(active, Math.max(results.length - 1, 0))

  function choose(title: RetroHit) {
    onChoose(title)
    onChange("")
    setOpen(false)
  }

  return (
    <div>
      <ChipGroup
        aria-label="Platform"
        className="mb-3"
        value={platformKey ? [platformKey] : []}
        onValueChange={(next) => onPlatformChange(next[0] ?? "")}
      >
        {RETRO_PLATFORMS.map((platform) => (
          <Chip key={platform.key} value={platform.key}>
            {platform.label}
          </Chip>
        ))}
      </ChipGroup>

      <div className="relative">
        <Input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList ? `${id}-option-${clampedActive}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          leadingIcon={<SearchIcon />}
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 0)}
          onKeyDown={(event) => {
            if (!showList) return
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setActive((index) => (index + 1) % results.length)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              setActive((index) => (index - 1 + results.length) % results.length)
            } else if (event.key === "Enter") {
              const title = results[clampedActive]
              if (!title) return
              event.preventDefault()
              choose(title)
            } else if (event.key === "Escape") {
              setOpen(false)
            }
          }}
        />

        {showList ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching titles"
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-[var(--radius)] border border-hairline bg-popover shadow-panel"
          >
            {results.map((title, index) => (
              <li
                key={`${title.id || title.name}-${index}`}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={index === clampedActive}
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(title)
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex cursor-default items-center gap-4 border-b border-hairline-soft px-3 py-2 last:border-b-0",
                  index === clampedActive && "bg-secondary"
                )}
              >
                <ProductImage
                  src={title.image}
                  alt=""
                  platform={title.platformKey}
                  height={36}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-foreground">
                    {title.name}
                  </span>
                  <span className="block truncate text-[13px] text-muted-foreground-2">
                    {[title.platformName, title.region].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {refused ? (
        <p className="mt-3 max-w-[56ch] text-[13px] leading-[1.45] text-muted-foreground">
          {refused}
        </p>
      ) : null}
    </div>
  )
}
