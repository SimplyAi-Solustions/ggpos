import * as React from "react"
import { SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldRow } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Wordmark } from "@/components/ui/wordmark"

/**
 * The Nova "add new item" reference, rebuilt with the two deliberate swaps:
 * the title is Anton instead of a light sans, and the labels are Space Mono.
 * Label-left from 900px, stacked below it.
 */
export function NovaAddItemRebuild() {
  const [tracked, setTracked] = React.useState(true)
  const [note, setNote] = React.useState("")

  return (
    <div className="flex min-h-full w-full flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-7 sm:px-10">
        <Wordmark />
        <nav className="flex items-center gap-8" aria-label="Utility">
          <a
            href="#"
            className="text-[13px] text-muted-foreground-2 transition-colors duration-150 ease-gg hover:text-foreground"
          >
            Help
          </a>
          <a
            href="#"
            className="text-[13px] text-muted-foreground-2 transition-colors duration-150 ease-gg hover:text-foreground"
          >
            Account
          </a>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[860px] flex-1 px-5 pt-12 pb-16 sm:px-10 sm:pt-20">
        <PageTitle>Add new item</PageTitle>
        <Lede>Every card, cart and box in one place, priced and findable.</Lede>

        <form
          className="mt-14"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Add new item"
        >
          <FieldRow>
            <Field label="Name" htmlFor="nova-name">
              <Input id="nova-name" defaultValue="Charizard ex 199/165" />
            </Field>

            <Field label="Category" htmlFor="nova-category">
              <Select>
                <SelectTrigger id="nova-category">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Card single</SelectItem>
                  <SelectItem value="sealed">Sealed product</SelectItem>
                  <SelectItem value="retro">Retro game</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field label="Search" htmlFor="nova-search">
              <Input
                id="nova-search"
                leadingIcon={<SearchIcon />}
                placeholder="e.g. SKU, product name, or keyword"
              />
            </Field>

            <Field label="Scan" htmlFor="nova-scan">
              <Input
                id="nova-scan"
                leadingIcon={<BarcodeGlyph />}
                trailingHint="Use camera"
                placeholder="Scan barcode"
              />
            </Field>

            <Field label="Date / code" htmlFor="nova-code">
              <Input id="nova-code" placeholder="e.g. 2026-04-17 or LOT-001" />
            </Field>

            <Field label="Notes" htmlFor="nova-notes">
              <Textarea
                id="nova-notes"
                placeholder="Add a note (optional)"
                maxLength={200}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                trailingHint={`${note.length} / 200`}
              />
            </Field>

            <Field label="Track item">
              <div className="flex min-h-10 items-center gap-4 pt-1 pb-2">
                <Switch
                  checked={tracked}
                  onCheckedChange={setTracked}
                  aria-label="Keep this item in inventory"
                />
                <span className="text-[15px] text-muted-foreground">
                  Keep this item in inventory
                </span>
              </div>
            </Field>
          </FieldRow>

          <div className="mt-14 flex flex-wrap items-center gap-8 min-[900px]:pl-[calc(10rem+1.5rem)]">
            <Button type="submit">Save item</Button>
            <Button variant="text" type="button">
              Cancel
            </Button>
            <Hint className="ml-auto hidden sm:block">Game &middot; Trade &middot; Play</Hint>
          </div>
        </form>
      </main>
    </div>
  )
}
