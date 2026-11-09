import * as React from "react"

import { Button, Chip, Input, MoneyInput, Segmented, Sheet } from "@/ui"

import { CUSTOM_CATEGORIES, GAMES, type CustomCategory } from "../types"

export interface CustomItemSheetProps {
  open: boolean
  onClose: () => void
  onAdd: (item: { name: string; category: CustomCategory; marketPence: number; qty: number; game?: string }) => void
}

/** A line the catalogue does not know: a retro game, a comic, sealed product. */
export function CustomItemSheet({ open, onClose, onAdd }: CustomItemSheetProps) {
  const [name, setName] = React.useState("")
  const [category, setCategory] = React.useState<CustomCategory>("retro")
  const [market, setMarket] = React.useState<number | null>(null)
  const [game, setGame] = React.useState<string>("pokemon")
  const [tried, setTried] = React.useState(false)

  const nameError = tried && !name.trim() ? "Give the item a name." : null
  const marketError = tried && market === null ? "Enter its market value, for example 24.99." : null

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (!name.trim() || market === null) return
    onAdd({ name, category, marketPence: market, qty: 1, game: category === "sealed" ? game : undefined })
    setName("")
    setMarket(null)
    setTried(false)
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Custom item"
      description="For anything the card search does not cover."
      footer={
        <Button type="submit" form="deal-custom-item" block>
          Add to deal
        </Button>
      }
    >
      <form id="deal-custom-item" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Segmented<CustomCategory>
          label="Kind of item"
          size="sm"
          block
          value={category}
          onChange={setCategory}
          options={CUSTOM_CATEGORIES}
        />
        {category === "sealed" && (
          <div className="flex flex-col gap-1.5">
            <span className="label-mono text-fg-2">Stock under</span>
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
              {[...GAMES, { key: "other", label: "Other" }].map((g) => (
                <Chip key={g.key} selected={g.key === game} onClick={() => setGame(g.key)}>
                  {g.label}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <Input
          label="Name"
          placeholder="Pokemon Yellow, boxed, PAL"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          autoComplete="off"
        />
        <MoneyInput label="Market value each" value={market} onChange={setMarket} error={marketError} />
      </form>
    </Sheet>
  )
}
