import * as React from "react"
import { cn } from "cn"

import { Chip, ChipGroup } from "@/components/ui/chip"
import { Hint, MicroLabel, SectionHeading } from "@/components/ui/micro-label"
import { Lede, PageTitle } from "@/components/ui/page-title"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Wordmark } from "@/components/ui/wordmark"
import { useTheme } from "@/components/theme-provider"
import { AtlasScanRebuild } from "@/kit/AtlasScanRebuild"
import { NovaAddItemRebuild } from "@/kit/NovaAddItemRebuild"
import { ScaleToFit } from "@/kit/ScaleToFit"
import {
  BrandSection,
  ColourSection,
  ControlsSection,
  DataSection,
  KitSection,
  MotionSection,
  ProductImageSection,
  TypeSection,
} from "@/kit/sections"

const THEMES = ["light", "dark", "system"] as const

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <ChipGroup
      aria-label="Colour mode"
      value={[theme]}
      onValueChange={(next) => {
        const chosen = next[0]
        if (chosen) setTheme(chosen as (typeof THEMES)[number])
      }}
    >
      {THEMES.map((option) => (
        <Chip key={option} value={option} className="h-7 px-3 text-[12px]">
          {option}
        </Chip>
      ))}
    </ChipGroup>
  )
}

function ComparePanel({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <figure className={cn("flex min-w-0 flex-col gap-3", className)}>
      <figcaption>
        <Hint>{label}</Hint>
      </figcaption>
      <div className="overflow-hidden rounded-[var(--radius)] border border-hairline-soft bg-background">
        {children}
      </div>
    </figure>
  )
}

function ReferenceMatch() {
  return (
    <KitSection
      id="reference-match"
      title="Reference match"
      note="The two screens Richard supplied, rebuilt in this system and set beside the originals at the same scale. Both are judged on weight, spacing and type at 1440px, and on stacking cleanly at 390px."
    >
      <div className="flex flex-col gap-16">
        <div>
          <MicroLabel tone="ink" className="mb-5">
            Atlas, scan item
          </MicroLabel>
          <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
            <ComparePanel label="Rebuilt in GG Vault">
              <ScaleToFit>
                <AtlasScanRebuild />
              </ScaleToFit>
            </ComparePanel>
            <ComparePanel label="Reference">
              <img
                src="/kit/atlas-scan-item.png"
                alt="The Atlas scan item reference screen"
                width={1456}
                height={1088}
                className="block h-auto w-full"
              />
            </ComparePanel>
          </div>
        </div>

        <div>
          <MicroLabel tone="ink" className="mb-5">
            Nova, add new item
          </MicroLabel>
          <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
            <ComparePanel label="Rebuilt in GG Vault">
              <ScaleToFit>
                <NovaAddItemRebuild />
              </ScaleToFit>
            </ComparePanel>
            <ComparePanel label="Reference">
              <img
                src="/kit/nova-add-item.png"
                alt="The Nova add new item reference screen"
                width={1456}
                height={1088}
                className="block h-auto w-full"
              />
            </ComparePanel>
          </div>
        </div>

        <div>
          <MicroLabel tone="ink" className="mb-5">
            Atlas, details
          </MicroLabel>
          <ComparePanel label="Reference: label treatment, right-aligned hints, block button">
            <img
              src="/kit/atlas-details.png"
              alt="The Atlas details reference screen"
              width={1456}
              height={1088}
              className="block h-auto w-full"
            />
          </ComparePanel>
        </div>
      </div>
    </KitSection>
  )
}

const CONTENTS = [
  ["colour", "Colour"],
  ["type", "Type"],
  ["controls", "Controls"],
  ["data", "Data"],
  ["product-images", "Product imagery"],
  ["brand", "Brand"],
  ["motion", "Motion"],
  ["reference-match", "Reference match"],
] as const

export function KitPage() {
  return (
    <TooltipProvider>
      <div className="min-h-svh">
        <header className="sticky top-0 z-40 border-b border-hairline-faint bg-background/95 backdrop-blur-[2px]">
          <div className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-6 px-5 py-4 sm:px-10">
            <Wordmark mark />
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1040px] px-5 pb-32 sm:px-10">
          <div className="pt-16 sm:pt-24">
            <PageTitle>GG Vault kit</PageTitle>
            <Lede>
              Every token, control and frame in the design system, in both modes, beside
              the reference screens they are built to match.
            </Lede>
          </div>

          <nav aria-label="Contents" className="mt-10">
            <SectionHeading className="mt-0 mb-4">Contents</SectionHeading>
            <ul className="flex flex-wrap gap-x-8 gap-y-3">
              {CONTENTS.map(([id, label]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="relative pb-1 text-[15px] text-muted-foreground transition-colors duration-150 ease-gg hover:text-foreground"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <ColourSection />
          <TypeSection />
          <ControlsSection />
          <DataSection />
          <ProductImageSection />
          <BrandSection />
          <MotionSection />
          <ReferenceMatch />
        </main>

        <footer className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-6 px-5 pb-12 sm:px-10">
          <Hint>Game &middot; Trade &middot; Play</Hint>
          <Hint>GG Vault design system</Hint>
        </footer>
      </div>
    </TooltipProvider>
  )
}

export default KitPage
