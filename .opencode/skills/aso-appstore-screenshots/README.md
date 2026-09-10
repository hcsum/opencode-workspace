# Store screenshots from real app captures

A skill for designing and rendering app store screenshot sets — App Store,
Google Play, or any other size — from real simulator/device captures.

Two things make it different from the usual scaffold-then-AI-enhance pipeline:

- **Nothing is generated.** Every pixel of app UI in the output is cropped from
  a real capture. Image models redraw interfaces subtly wrong.
- **The user's selling points come first.** The workflow opens by asking what
  they think sells the app, then verifies each point against the codebase,
  pushes back, and turns the survivors into headlines.

## Workflow

1. Selling points — ask, verify against the code, push back, write headlines.
2. Captures — collect, rate `Great`/`Usable`/`Retake`, pair with headlines.
3. Palette — pick a background from the app's own colours.
4. Render — one JSON spec, composited deterministically.
5. Review — contact sheet, checked at thumbnail size.

## Requirements

```bash
pip install Pillow
```

No API key, no image model.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | The workflow, and the layout rules worth remembering |
| `compose.py` | Spec-driven composer: background, type, capture placement, breakout panels |
| `measure.py` | Pixel probes: an element's real corner radius and content bounds |
| `contact_sheet.py` | Tiles a rendered set into one reviewable image |
| `examples/ori.json` | Reference spec: the shipped Ori set (5 bare frames, one of them two-phone) |
| `scripts/resize_to_appstore.py` | Last resort for images that cannot be re-rendered |

## Spec

Floats are fractions of the canvas, ints are absolute pixels — which is why one
spec renders at any target size:

```bash
python3 compose.py screenshots/spec.json --outdir screenshots/final
python3 compose.py screenshots/spec.json --size iphone-6.9 --outdir screenshots/final/6.9
python3 compose.py screenshots/spec.json --size 1080x1920 --outdir screenshots/play
```

Presets: `iphone-6.9` `iphone-6.7` `iphone-6.5` `ipad-13` `ipad-12.9`
`play-phone` `og` `x-card`, or any `WxH`.

## Output

```text
screenshots/
  aso-state.md      resumable progress
  spec.json         every tuned number
  raw/              simulator captures
  final/            store-ready files
  sheet.png         contact sheet
```
