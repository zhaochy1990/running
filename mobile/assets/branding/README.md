# STRIDE Icon Assets — v1 Placeholder

## Files

| File | Purpose |
|------|---------|
| `icon-dark.svg` | Primary icon. Black background (`#0a0a0a`) + white S + green underline. Use for JPush console upload and as default launcher icon. |
| `icon-light.svg` | Light-theme preview. White background + black S + green underline. |
| `icon-monochrome.svg` | Single-color silhouette (black on transparent). For Android 13+ notification icons and themed icon foreground. No accent color. |
| `icon-adaptive-foreground.svg` | Android adaptive icon foreground layer. Transparent background, content scaled to fit within the central 66% safe zone. Use as `adaptive_icon_foreground` in `flutter_launcher_icons`. |

## Get a 1024×1024 PNG immediately (for JPush console)

**Option A — Inkscape (recommended):**
```bash
inkscape --export-filename=icon-1024.png --export-width=1024 icon-dark.svg
```

**Option B — ImageMagick:**
```bash
magick convert -background none -density 96 icon-dark.svg -resize 1024x1024 icon-1024.png
```

**Option C — Python (no external tools needed):**
```bash
pip install cairosvg
python -c "import cairosvg; cairosvg.svg2png(url='icon-dark.svg', write_to='icon-1024.png', output_width=1024, output_height=1024)"
```

Run any of the above from inside this `assets/branding/` directory.

## Flutter launcher icons integration (S1 scaffold)

Add to `pubspec.yaml`:
```yaml
flutter_launcher_icons:
  android: true
  ios: false
  image_path: "assets/branding/icon-dark.svg"
  adaptive_icon_background: "#0a0a0a"
  adaptive_icon_foreground: "assets/branding/icon-adaptive-foreground.svg"
  min_sdk_android: 21
```

Then run:
```bash
dart run flutter_launcher_icons
```

## When to replace with the real logo

Replace these SVGs when a designer delivers the final STRIDE identity (expected v1.1+). At that point:
1. Drop in the new SVGs (same filenames, same 1024×1024 viewBox).
2. Re-run `dart run flutter_launcher_icons` to regenerate all launcher icon sizes.
3. Update the JPush console with a freshly exported PNG.

No code changes required — only asset replacement.

## Design notes

- The "S" glyph is extracted from **Geist Mono Bold** (Vercel, OFL license) via `fonttools`. The exact outline path (`M306 -16Q185...`) is written directly into the SVG as a `fill`-based `<path>` — no font embedding, no stroke approximation, no runtime font dependency.
- SVG transform `translate(271.155,777) scale(0.802817,-0.802817)` applied to the raw font path:
  - `scale(s, -s)` flips the Y axis (font coordinate system is Y-up; SVG is Y-down).
  - Scale factor `0.802817` maps cap-height (710 font units) to 570px in the 1024×1024 canvas.
  - `tx=271.155` centers the advance-width cell (600 units → 481.7px) horizontally.
  - `ty=777` places the baseline; the cap-top lands at y=207 — optical center nudge of −20px upward relative to pure geometric center.
- Underline width equals `advance_width × scale × 0.95 = 457.6px`, horizontally centered on the advance-width cell, 50px below the baseline (y=827), height 40px, rx=4.
- `icon-adaptive-foreground.svg` applies an additional 0.60× uniform scale around the canvas center so the composition fits within the Android adaptive icon safe zone (central 66.7% = 682×682px).
- Accent green is exactly `#00e676` (brighter pop-green for icon contexts; distinct from the dashboard's `#00a85a`).
- No gradients, shadows, or filters — pure flat fills for maximum crispness at all sizes and on any background.
