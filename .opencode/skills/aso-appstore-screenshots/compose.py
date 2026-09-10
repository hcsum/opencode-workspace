#!/usr/bin/env python3
"""Spec-driven store-screenshot composer.

One JSON spec describes a whole set: background, type, device frames, and
"breakout" panels lifted straight out of the real captures. Nothing is
redrawn or generated, so whatever ships is exactly what the app renders.

Units
-----
    float  -> fraction of the canvas (x/width-ish values of canvas width,
              y/top values of canvas height). Resolution-independent, so the
              same spec renders at any target size.
    int    -> absolute pixels. Only crop rectangles (which index into the
              capture, not the canvas) should normally be ints.

Usage
-----
    python3 compose.py spec.json --outdir out
    python3 compose.py spec.json --size iphone-6.9 --outdir out/6.9
    python3 compose.py spec.json --only 03 --outdir out
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from measure import corner_radius

PRESETS = {
    "iphone-6.9": (1320, 2868),
    "iphone-6.7": (1290, 2796),
    "iphone-6.5": (1242, 2688),
    "ipad-13": (2064, 2752),
    "ipad-12.9": (2048, 2732),
    "play-phone": (1080, 1920),
    "og": (1200, 630),
    "x-card": (1600, 900),
}

FONT_STACK = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
]
FALLBACK_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FALLBACK_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"


# ── units ───────────────────────────────────────────────────────────────────

def px(value, base):
    """float -> fraction of `base`; int -> absolute pixels."""
    return round(value * base) if isinstance(value, float) else int(value)


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def font(size, weight):
    for path in FONT_STACK:
        try:
            f = ImageFont.truetype(path, size)
            try:
                f.set_variation_by_name(weight)
            except (OSError, AttributeError):
                pass
            return f
        except OSError:
            continue
    heavy = weight in ("Black", "Heavy", "Bold", "Semibold")
    return ImageFont.truetype(FALLBACK_BOLD if heavy else FALLBACK_REG, size)


# ── background ──────────────────────────────────────────────────────────────

def background(theme, W, H):
    bg = theme.get("bg", {})
    if bg.get("type") == "solid":
        img = Image.new("RGB", (W, H), rgb(bg["color"]))
    else:
        top, bottom = rgb(bg.get("top", "#333333")), rgb(bg.get("bottom", "#111111"))
        gamma = bg.get("gamma", 0.85)
        strip = Image.new("RGB", (1, H))
        pxs = strip.load()
        for y in range(H):
            t = (y / max(1, H - 1)) ** gamma
            pxs[0, y] = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        img = strip.resize((W, H))

    glow = bg.get("glow")
    if glow:
        x0, y0, x1, y1 = glow["box"]
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).ellipse(
            (px(x0, W), px(y0, H), px(x1, W), px(y1, H)), fill=glow.get("strength", 70)
        )
        img = Image.composite(
            Image.new("RGB", img.size, rgb(glow["color"])), img,
            mask.filter(ImageFilter.GaussianBlur(px(glow.get("blur", 0.17), W))),
        )

    grain = bg.get("grain", 0.0)
    if grain:
        noise = Image.effect_noise((W, H), 7).convert("L")
        img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)), grain)
    return img.convert("RGBA")


# ── type ────────────────────────────────────────────────────────────────────

def fit_one_line(draw, text, size, weight, max_w):
    """Titles may shrink to hold a line. Never used for body copy."""
    f = font(size, weight)
    while draw.textlength(text, font=f) > max_w and f.size > size * 0.55:
        f = font(f.size - 3, weight)
    return f


def wrap(draw, text, f, max_w):
    """Body copy wraps. It never shrinks -- a silently shrunk subhead is the
    single most common reason a set reads weak at thumbnail size."""
    lines, cur = [], ""
    for word in text.split():
        probe = (cur + " " + word).strip()
        if cur and draw.textlength(probe, font=f) > max_w:
            lines.append(cur)
            cur = word
        else:
            cur = probe
    if cur:
        lines.append(cur)
    return lines


def draw_type(canvas, frame, theme, lay, W, H):
    d = ImageDraw.Draw(canvas)
    y = px(lay["title_top"], H)
    for line in frame["title"]:
        f = fit_one_line(d, line, px(lay["title_size"], W), theme.get("title_weight", "Black"),
                         px(lay["title_max_w"], W))
        d.text((W // 2, y), line, font=f, fill=rgb(theme["title_color"]), anchor="ma")
        y += round(f.size * lay.get("title_line", 1.09))

    sub = frame.get("subtitle")
    if not sub:
        return
    f = font(px(lay["sub_size"], W), theme.get("sub_weight", "Medium"))
    y += px(lay.get("sub_gap", 0.014), H)
    for line in wrap(d, sub, f, px(lay["sub_max_w"], W)):
        d.text((W // 2, y), line, font=f, fill=rgb(theme["sub_color"]), anchor="ma")
        y += round(f.size * lay.get("sub_line", 1.22))


# ── device + panels ─────────────────────────────────────────────────────────

def drop_shadow(canvas, box, radius, color, blur, alpha, dy=0, spread=6):
    x0, y0, x1, y1 = box
    pad = blur * 3
    layer = Image.new("RGBA", (x1 - x0 + pad * 2, y1 - y0 + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        (pad - spread, pad - spread, pad + (x1 - x0) + spread, pad + (y1 - y0) + spread),
        radius=radius + spread, fill=(*rgb(color), alpha),
    )
    canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)), (x0 - pad, y0 - pad + dy))


def rounded(img, radius, corners=(True, True, True, True)):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, img.width - 1, img.height - 1), radius=radius, fill=255, corners=corners
    )
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def phone(canvas, capture, cap_spec, theme, x, top, screen_w, device="none", stroke=None):
    """The capture on the canvas, bare by default or wearing a vector device.

    `device: "none"` is the default: no bezel, body, side buttons or extra body
    radius, just the screen with its own corner radius and a shadow under it.
    A mockup frame costs about a tenth of every frame's height and says nothing
    the capture does not already say, so the set reads as the app rather than as
    a product shot. `device: "phone"` opts back into the vector body.

    `stroke` ({"color", "width", "alpha"}, width a fraction of the screen width)
    draws a hairline on the screen edge, and only matters with `device: "none"`:
    a light capture on a light canvas has no bezel left to hold its edge, and
    without one the two grounds bleed into each other at thumbnail size. Put it
    on the light phone rather than darkening the whole canvas for one frame.

    Runs off the canvas when it must -- a cropped device bottom reads better
    than a shrunken screen.
    """
    cw, ch = cap_spec["w"], cap_spec["h"]
    scale = screen_w / cw
    screen_h = round(ch * scale)

    if device == "none":
        r = round(cap_spec.get("screen_radius", 165) * scale)
        drop_shadow(canvas, (x, top, x + screen_w, top + screen_h), r,
                    theme.get("shadow", "#000000"),
                    blur=round(screen_w * 0.05), alpha=120,
                    dy=round(screen_w * 0.028))
        shot = capture.resize((screen_w, screen_h), Image.Resampling.LANCZOS)
        canvas.alpha_composite(rounded(shot, r), (x, top))
        if stroke:
            w = max(1, round(screen_w * stroke.get("width", 0.004)))
            layer = Image.new("RGBA", (screen_w, screen_h), (0, 0, 0, 0))
            ImageDraw.Draw(layer).rounded_rectangle(
                (w / 2, w / 2, screen_w - 1 - w / 2, screen_h - 1 - w / 2), radius=r,
                outline=(*rgb(stroke.get("color", "#000000")), stroke.get("alpha", 255)),
                width=w)
            canvas.alpha_composite(layer, (x, top))
        return
    bezel = max(6, round(screen_w * cap_spec.get("bezel_ratio", 0.0133)))
    r_screen = round(cap_spec.get("screen_radius", 165) * scale)
    r_body = r_screen + bezel

    bx0, by0 = x - bezel, top - bezel
    bx1, by1 = x + screen_w + bezel, top + screen_h + bezel
    drop_shadow(canvas, (bx0, by0, bx1, by1), r_body, theme.get("shadow", "#000000"),
                blur=round(screen_w * 0.053), alpha=140, dy=round(screen_w * 0.031))

    body = Image.new("RGBA", (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((0, 0, body.width - 1, body.height - 1), radius=r_body, fill=(38, 32, 29, 255))
    bd.rounded_rectangle((0, 0, body.width - 1, body.height - 1), radius=r_body,
                         outline=(142, 130, 121, 255), width=max(2, bezel // 5))
    bd.rounded_rectangle((1, 1, body.width - 2, body.height - 2), radius=r_body,
                         outline=(196, 184, 172, 150), width=max(1, bezel // 9))
    canvas.alpha_composite(rounded(body, r_body), (bx0, by0))

    d = ImageDraw.Draw(canvas)
    btn, bw = (52, 45, 41, 255), max(3, round(8 * scale))
    for y0, y1 in ((0.115, 0.155), (0.185, 0.245), (0.255, 0.315)):
        d.rounded_rectangle((bx0 - bw, by0 + screen_h * y0, bx0 + 2, by0 + screen_h * y1),
                            radius=bw, fill=btn)
    d.rounded_rectangle((bx1 - 2, by0 + screen_h * 0.20, bx1 + bw, by0 + screen_h * 0.30),
                        radius=bw, fill=btn)

    shot = capture.resize((screen_w, screen_h), Image.Resampling.LANCZOS)
    canvas.alpha_composite(rounded(shot, r_screen), (x, top))


def breakout(canvas, capture, cap_spec, panel, theme, phone_x, phone_top, screen_w, W, H, frame_id):
    """One real UI element, lifted out of the capture and scaled up.

    anchor:
      over    -- floats on top of the element it came from (top aligned to the
                 element's top, minus a small pad). The enlarged panel hides the
                 original completely and everything lower on the phone stays in
                 shot. This is the default and the one to reach for.
      element -- bottom aligned to the element's bottom.
      canvas  -- sits on the bottom edge of the frame, square bottom corners, so
                 it reads as continuing past it.

    Hard rule, enforced below: a scaled panel MUST fully cover its source
    element. If it does not, the same card appears twice in the frame.
    """
    crop = tuple(panel["crop"])
    width = px(panel["width"], W)
    scale = screen_w / cap_spec["w"]

    src = capture.crop(crop)
    height = round(src.height * width / src.width)
    src = src.resize((width, height), Image.Resampling.LANCZOS)

    radius = panel.get("radius", "auto")
    if radius == "auto":
        # Measured off the pixels, then scaled with the panel. A mask radius that
        # does not match the source leaves pale slivers in the four corners.
        radius = round(corner_radius(capture, crop) * width / (crop[2] - crop[0]))
    else:
        radius = px(radius, W)

    anchor = panel.get("anchor", "over")
    x = (W - width) // 2
    corners = (True, True, True, True)
    if anchor == "canvas":
        y = H - height
        corners = (True, True, False, False)
    elif anchor == "element":
        y = round(phone_top + crop[3] * scale) - height
    else:  # over
        y = round(phone_top + crop[1] * scale) - px(panel.get("pad", 0.0038), H)

    el = (round(phone_x + crop[0] * scale), round(phone_top + crop[1] * scale),
          round(phone_x + crop[2] * scale), round(phone_top + crop[3] * scale))
    if not (x <= el[0] and y <= el[1] and x + width >= el[2] and y + height >= el[3]):
        print(f"  ! {frame_id}: panel does not fully cover its source element "
              f"(panel {x},{y},{x+width},{y+height} vs element {el}) -- the same "
              f"element will appear twice. Widen the panel or change the anchor.")

    drop_shadow(canvas, (x, y, x + width, y + height), radius, theme.get("shadow", "#000000"),
                blur=px(panel.get("shadow_blur", 0.037), W), alpha=panel.get("shadow_alpha", 170),
                dy=0 if anchor == "canvas" else px(0.007, W))
    canvas.alpha_composite(rounded(src, radius, corners), (x, y))


# ── frames ──────────────────────────────────────────────────────────────────

def compose(spec, frame, W, H, root):
    theme, lay, cap = spec["theme"], spec["layout"], spec["capture"]
    canvas = background(theme, W, H)
    draw_type(canvas, frame, theme, lay, W, H)

    # "none" (default) for a bare capture, or "phone" for the vector body. Set
    # once on `layout`, overridable per frame and per phone in a multi-phone frame.
    device = frame.get("device", lay.get("device", "none"))

    phones = frame.get("phones")
    if phones:
        for p in phones:
            img = Image.open(root / p["capture"]).convert("RGBA")
            phone(canvas, img, cap, theme, px(p["x"], W), px(p["top"], H), px(p["w"], W),
                  p.get("device", device), p.get("stroke", lay.get("stroke")))
    else:
        img = Image.open(root / frame["capture"]).convert("RGBA")
        w = px(frame.get("phone_w", lay["phone_w"]), W)
        top = px(frame.get("phone_top", lay["phone_top"]), H)
        x = (W - w) // 2
        phone(canvas, img, cap, theme, x, top, w, device,
              frame.get("stroke", lay.get("stroke")))
        if frame.get("panel"):
            breakout(canvas, img, cap, frame["panel"], theme, x, top, w, W, H, frame["id"])

    return canvas.convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("--outdir", default="out")
    ap.add_argument("--size", default=None, help="preset name or WxH; default: spec canvas")
    ap.add_argument("--only", nargs="*", help="frame ids to render")
    args = ap.parse_args()

    spec_path = Path(args.spec).resolve()
    spec = json.loads(spec_path.read_text())
    root = spec_path.parent

    if args.size:
        W, H = PRESETS.get(args.size) or tuple(int(v) for v in args.size.lower().split("x"))
    else:
        W, H = spec["canvas"]["w"], spec["canvas"]["h"]

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    for frame in spec["frames"]:
        if args.only and frame["id"] not in args.only:
            continue
        out = outdir / f"{frame['id']}.png"
        compose(spec, frame, W, H, root).save(out)
        print(f"✓ {out} ({W}x{H})")


if __name__ == "__main__":
    main()
