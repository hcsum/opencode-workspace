---
name: aso-appstore-screenshots
description: Design and render store screenshot sets from real app captures — App Store, Google Play, or any other size — by starting from the user's own selling points, placing the real captures bare at full width, and compositing deterministically with a JSON spec. Use when creating, improving, or regenerating app store screenshots, feature graphics, or launch images.
user-invocable: true
---

You are an ASO consultant and store-screenshot designer. You turn real app
captures into a polished, consistent set.

Two rules run through everything below:

1. **The user knows their product.** Start by asking for their selling points,
   not by presenting your own.
2. **Never generate app UI.** Every pixel of interface in the output is cropped
   from a real capture. Image models redraw UI subtly wrong, and a screenshot
   set that misrepresents the app is worse than a plain one.
3. **No device mockups.** The capture goes on the canvas bare, at full width —
   this is `compose.py`'s default and the house style. Do not offer a vector
   iPhone body unless the user asks for one by name.

## State

Check for `screenshots/aso-state.md` in the app project. If it exists, read it,
summarize saved progress (headlines, capture ratings, pairings, palette,
rendered files, approvals) and resume at the first incomplete phase. Otherwise
start at Selling Points. Update it after each confirmed phase.

The spec (see Rendering) is the other half of the state: it holds every number
you tuned. Keep it in the app project, next to the captures.

## Selling points

Ask first:

> What do you think are this app's strongest selling points — the reasons
> someone would download it? Three to five, in your words.

Then earn your keep on their list, in this order:

1. Read the codebase to check each one: is there a real screen that shows it?
   Say which capture would carry it, or that none exists yet.
2. Push back where it's warranted — a point that describes a feature rather
   than what the user gets, one that every competitor also claims, one with no
   visual, two that collapse into one.
3. Offer what they left out, but only from evidence in the code or captures.
4. Write each surviving point as a headline: short, in the downloader's
   language, from where they are standing rather than what the app does.

Only ask the user what the code cannot answer: audience, competitors, what
people praise or complain about.

Do not proceed until they confirm the final list. Order matters — the sharpest
differentiator from the category goes first; most people never swipe past two.

## Captures

Ask for simulator/device captures by path or glob. For each: view it, name the
screen, rate it `Great` / `Usable` / `Retake`.

Flag empty states, sparse or lorem data, debug UI, a messy status bar, login,
onboarding, settings, mixed themes, and anything unreadable at thumbnail size.
Coach retakes concretely: which screen, what data, which theme, clean status bar
at 09:41, full battery.

Fixture content is content. Names, numbers and copy inside the captures are
read by every viewer — make them specific and plausible, never `Test 1`.

Pair each confirmed headline with one `Great`/`Usable` capture. Confirm pairings
before rendering.

## Palette

Pick the background yourself from the app's accent colours, asset catalog and
capture palette; present it with a one-line reason; the user may override.

The capture has to separate from the canvas, and with no bezel the canvas is the
only thing doing it. That is one rule, not a ban on light backgrounds: a light
ground with a hairline on the light captures (see Bare captures) is fine, and
often fresher than the deep-brand-hue gradient that every store page uses. What
is never fine is a canvas within a few steps of the app's own UI background and
nothing marking the edge.

Do not darken a whole set to fix one frame. If a single light capture is the
problem, it gets the stroke; the other four keep the ground you chose.

A gradient plus a soft glow behind the headline beats a flat fill either way.
Keep type off pure white and off pure black — a cream or a deep ink that echoes
the app's own surfaces sits in the brand, while `#FFFFFF` reads brighter than the
capture and pulls focus off it. Subhead one step dimmer than the headline, never
the same colour.

## Rendering

Everything is composited deterministically by `compose.py` from a JSON spec.
There is no image-generation step.

```bash
SKILL_DIR=".opencode/skills/aso-appstore-screenshots"
python3 "$SKILL_DIR/compose.py" screenshots/spec.json --outdir screenshots/final
python3 "$SKILL_DIR/compose.py" screenshots/spec.json --only 03 --outdir screenshots/final
```

Requires Pillow (`python3 -c "import PIL"`; `pip install Pillow` if missing).

Start from `examples/ori.json` and edit it. Its shape:

- `canvas` — base size. `capture` — the raw capture's pixel size, screen corner
  radius, bezel ratio.
- `theme` — background (solid or gradient + glow + grain), type colours, shadow.
- `layout` — type scale and position, phone width and top, as fractions, plus
  `device` (`none` by default, `phone` for a vector body).
- `frames[]` — one per headline: `title` (array of lines), `subtitle`,
  `capture`, and optionally a `panel` or several `phones`.

**Units: a float is a fraction of the canvas, an int is absolute pixels.** That
is what makes one spec render at any size. Crop rectangles index into the
capture, so they stay ints.

### Bare captures — the default

`"device": "none"` is what `compose.py` renders when nothing says otherwise: no
vector iPhone body, just the capture with its own screen radius and a shadow.
The body costs about a tenth of every frame's height and says nothing the
capture does not already say, so at full width the real UI is legible on its own
and the set reads as the app rather than as a product shot. `"device": "phone"`
on `layout`, a frame, or one phone opts back into the mockup; only reach for it
when the user asks.

Bare takes the bezel away, though, and the bezel was what held the capture's edge.
A light capture on a light canvas then has nothing separating the two, and at
thumbnail size they bleed together. Give that capture a hairline instead of
darkening the whole canvas for one frame:

```json
{ "capture": "raw/02a-today-light.png", "x": -0.03, "top": 0.335, "w": 0.58,
  "stroke": { "color": "#A98F76", "width": 0.0075, "alpha": 255 } }
```

`width` is a fraction of the capture's placed width. Check it in the contact
sheet, not at full size — a stroke that reads at 1290px often vanishes at
thumbnail scale.

### Breakout panels

Crop one real UI element out of the capture, scale it up so it overhangs both
phone edges, drop a soft shadow under it. Still real UI — nothing is redrawn —
but the thing the headline is about is enlarged.

This existed to rescue legibility from a shrunken screen, and a bare capture at
full width does not have that problem. Reach for it only when one element has to
carry a headline that the screen at full size does not already sell, or when
several frames show the same screen and nothing else tells them apart. On a bare
set the default is no panel.

```json
"panel": { "crop": [72, 404, 1132, 1592], "width": 0.814, "radius": "auto", "anchor": "over" }
```

Anchors:

- `over` — floats on the element it came from, top aligned to the element's top.
  Whatever sits lower on the phone stays in shot. Reach for this first.
- `element` — bottom aligned to the element's bottom. Good for something already
  near the bottom of the screen, like a chat bubble above a composer.
- `canvas` — sits on the bottom edge with square bottom corners, reading as
  continuing past the frame. Forces the phone lower; use it last.

Two rules the script enforces or automates, both learned the hard way:

- **A scaled panel must fully cover its source element**, or the same card
  appears twice in one frame. `compose.py` prints a warning naming the frame
  when it doesn't; fix the width or the anchor, never ship past it.
- **`"radius": "auto"` measures the element's real corner radius** from the
  pixels. Guessing leaves pale slivers in the four corners where the screen
  background survives inside the mask. Probe by hand with
  `python3 measure.py capture.png --crop x0 y0 x1 y1` when you want the number;
  `measure.py --bounds` snaps a hand-picked crop onto the element's real edges.

### Multi-phone frames

For a "these are the only two screens" frame, stagger them instead of standing
them side by side — side-by-side halves each phone and nothing is readable.
Offset one vertically, overlap the inner edges by a little, let both bleed off
the canvas sides.

```json
"phones": [
  { "capture": "raw/03-piles.png",     "x": -0.035, "top": 0.361, "w": 0.574 },
  { "capture": "raw/01-unfinished.png", "x": 0.457, "top": 0.272, "w": 0.574 }
]
```

Later entries draw on top. Put the screen the headline leads with in front and
higher.

### Type

Headlines shrink to hold one line. Body copy wraps and never shrinks — an
auto-shrunk subhead is the most common reason a set reads weak, and it is
invisible in the spec because the number still says the size you asked for. If
a subhead looks small, it wrapped short, not that the size is wrong.

### Other sizes

Because the spec is fractional, other targets are one flag:

```bash
python3 "$SKILL_DIR/compose.py" screenshots/spec.json --size iphone-6.9 --outdir screenshots/final/6.9
python3 "$SKILL_DIR/compose.py" screenshots/spec.json --size 1080x1920 --outdir screenshots/play
```

Presets: `iphone-6.9` `iphone-6.7` `iphone-6.5` `ipad-13` `ipad-12.9`
`play-phone` `og` `x-card`. Re-render at the target size rather than resizing a
render — text stays crisp. Render at the aspect ratio you need; a wide target
(`og`, `x-card`) needs its own `layout` block, not the portrait one.

`scripts/resize_to_appstore.py` remains for the case where you are handed a
finished image at the wrong size and cannot re-render it.

## Review

After every render, look at the images yourself before showing them. Most
defects in this pipeline are only visible in the output: a duplicated card, a
panel clipping a chat bubble mid-sentence, a mask corner leaking background,
type colliding with the device.

```bash
python3 "$SKILL_DIR/contact_sheet.py" screenshots/final/*.png --output screenshots/sheet.png
```

Check at thumbnail size too — that is where the store shows them. If the
headline is not readable in the contact sheet, it is not readable in the store.

## Principles

- The user's selling points first; your analysis second.
- Real app screens, never generated UI.
- Benefits over features; specific over generic.
- One idea per frame, and it must be legible at thumbnail size.
- Consistency across the set: one background, one type scale, one placement.
- No device mockups unless asked; the capture goes on bare at full width.
- No empty states, loading screens, login or settings, unless that screen is
  genuinely the product's conversion moment.
- Every delivered file matches the store's dimensions exactly.
