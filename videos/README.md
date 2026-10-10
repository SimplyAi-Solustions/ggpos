# GG Vault tutorials

Short how-to videos for the counter, made with [Remotion](https://www.remotion.dev) from screenshots of the demo build. Each video is a run of real screens with a pointer, zooms, a caption band and a music bed, in GG's colours and type.

This folder sits outside the pnpm workspace on purpose: it has its own `package.json` and lockfile, installs with npm, and nothing in CI builds it.

## Make the videos

From this folder:

```sh
npm install

# 1. Build the counter in demo mode, so ?demo=1 signs in to the demo shop.
VITE_DEMO_SWITCH=1 pnpm --filter web build

# 2. Capture the screenshots. Serves the build, walks every script in
#    capture/tutorials, writes public/captures/<slug>/ and src/captures/.
npm run capture              # every tutorial
npm run capture -- selling   # just the ones whose file name matches

# 3. Make the music bed (public/music/bed.wav). Once is enough.
npm run music

# 4. Render to out/NN-slug.mp4.
npm run render               # every tutorial
npm run render -- 03-selling # just this one
```

```sh
# 5. Make copies under 30 MB in out/share/, for chat apps and email.
npm run share
```

`npm run studio` opens Remotion Studio to scrub through a tutorial before rendering.

Screenshots, the music bed and the rendered videos are not committed. Run the steps above to make them again.

## Write a tutorial

Each file in `capture/tutorials/` is one video. It opens a session with the title, subtitle, outline and the next video's name, then calls `step()` once per screen:

```js
await step("Scan the label with the scanner. Typing the code and pressing Enter does the same.", page.getByTestId("till-scan-field"), {
  action: "type",
  value: "GGS-7F3K2B",
  zoom: true,
  section: "Put items on the ticket",
})
```

`step()` takes the screenshot, records where the target is so the video can zoom to it and move the pointer there, then clicks, types or presses. `show()` highlights something without touching it.

Captions follow the copy rules in `DESIGN.md`: plain British English, short, no exclamation marks, no emoji, no em-dashes. Each caption must describe what is on its screenshot.

## Licence

Remotion is free for individuals and companies of up to three people. A bigger company needs a company licence from remotion.pro.
