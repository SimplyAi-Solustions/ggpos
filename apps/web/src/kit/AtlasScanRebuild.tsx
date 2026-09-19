import { FileTextIcon, HashIcon, MapPinIcon, TagIcon, UserIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/ui/field"
import { BarcodeGlyph, Input } from "@/components/ui/input"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Wordmark } from "@/components/ui/wordmark"

const NAV = ["Stock", "Trade", "Customers", "Reports"]

/**
 * The Atlas "scan item" reference, rebuilt in GG's system: same weight, same
 * whitespace, Space Mono labels instead of a tracked sans, GG's wordmark and
 * the volt focus line. This is the Phase 1 gate for the counter screens.
 */
export function AtlasScanRebuild() {
  return (
    <div className="flex min-h-full w-full flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-7 sm:px-10">
        <Wordmark />
        <nav className="flex items-center gap-8" aria-label="Main">
          <ul className="hidden items-center gap-8 sm:flex">
            {NAV.map((item, index) => (
              <li key={item}>
                <a
                  href="#"
                  aria-current={index === 0 ? "page" : undefined}
                  className="relative pb-1 text-[13px] text-muted-foreground-2 transition-colors duration-150 ease-gg hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:bg-volt"
                >
                  {item}
                </a>
              </li>
            ))}
          </ul>
          <Avatar>
            <AvatarFallback>RG</AvatarFallback>
          </Avatar>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1040px] flex-1 px-5 pt-16 pb-16 sm:px-10 sm:pt-24">
        <section aria-labelledby="scan-item">
          <SectionHeading id="scan-item" className="mt-0 mb-5">
            Scan item
          </SectionHeading>
          <Input
            size="scan"
            leadingIcon={<BarcodeGlyph />}
            trailingHint={
              <span className="inline-flex items-center gap-2">
                Press enter
                <svg viewBox="0 0 24 12" className="h-2.5 w-6" aria-hidden="true">
                  <path
                    d="M0 6h22M17 1l5 5-5 5"
                    stroke="currentColor"
                    strokeWidth="1"
                    fill="none"
                  />
                </svg>
              </span>
            }
            placeholder="Scan barcode or type here"
            aria-label="Scan barcode or type an item code"
          />
          <p className="mt-4 text-[15px] leading-[1.5] text-muted-foreground">
            Scan a barcode or enter an item code to continue.
          </p>
        </section>

        <section aria-labelledby="details">
          <SectionHeading id="details" className="mt-24 mb-5">
            Details
          </SectionHeading>
          <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-3">
            <Field layout="stacked" icon={<TagIcon />} label="Item ID" htmlFor="atlas-item-id">
              <Input id="atlas-item-id" placeholder="e.g. 1062847" />
            </Field>
            <Field layout="stacked" icon={<HashIcon />} label="Quantity" htmlFor="atlas-qty">
              <Input id="atlas-qty" defaultValue="1" className="tnum" inputMode="numeric" />
            </Field>
            <Field layout="stacked" icon={<FileTextIcon />} label="Notes" htmlFor="atlas-notes">
              <Input id="atlas-notes" placeholder="Add a note (optional)" />
            </Field>
          </div>
        </section>

        <section aria-labelledby="additional">
          <SectionHeading id="additional" className="mt-24 mb-5">
            Additional
          </SectionHeading>
          <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
            <Field
              layout="stacked"
              icon={<UserIcon />}
              label="Assigned to"
              htmlFor="atlas-person"
            >
              <Select>
                <SelectTrigger id="atlas-person">
                  <SelectValue placeholder="Select a person (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="richard">Richard</SelectItem>
                  <SelectItem value="counter">Counter</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              layout="stacked"
              icon={<MapPinIcon />}
              label="Location"
              htmlFor="atlas-location"
            >
              <Select>
                <SelectTrigger id="atlas-location">
                  <SelectValue placeholder="Select a location (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="case-a">Case A</SelectItem>
                  <SelectItem value="back-room">Back room</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </section>

        <div className="mt-24 flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-6">
            <Button variant="circle">Save item</Button>
            <MicroLabel tone="ink">Save item</MicroLabel>
          </div>
          <Button variant="text">Clear all</Button>
        </div>
      </main>

      <footer className="mx-auto flex w-full max-w-[1040px] items-center justify-between px-5 pb-8 sm:px-10">
        <Hint>Game &middot; Trade &middot; Play</Hint>
        <Hint>GG Vault v0.1</Hint>
      </footer>
    </div>
  )
}
