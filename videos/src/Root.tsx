import React from "react"
import { Composition } from "remotion"

import { loadBrandFonts } from "./brand"
import { tutorials } from "./captures"
import { FPS, layout } from "./timing"
import { Tutorial } from "./Tutorial"

loadBrandFonts()

/** One composition per captured tutorial, 1920 by 1080 at 30 frames a second. */
export const Root: React.FC = () => (
  <>
    {tutorials.map((m) => (
      <Composition
        key={m.slug}
        id={`${String(m.number).padStart(2, "0")}-${m.slug}`}
        component={Tutorial}
        durationInFrames={layout(m).total}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ manifest: m }}
      />
    ))}
  </>
)
