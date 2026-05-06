# STRIDE Overrides on Vercel DESIGN.md

The mobile app uses `mobile/DESIGN.md` (a verbatim copy of Vercel's design
system from <https://getdesign.md/vercel/design-md>) as the source of truth
for typography, spacing, components, and tokens. The two STRIDE-specific
deviations below are the only places we depart from Vercel's defaults.

## 1. Accent color → STRIDE green

Vercel's accent slot is monochrome. STRIDE replaces it with the existing
brand green from the web frontend:

| Token | Vercel default | STRIDE override |
|-------|----------------|-----------------|
| `--accent` (primary action, focus ring, sparkline highlights, "today"
  badges, like-button active) | `#000` (light) / `#fff` (dark) | **`#00e676`** |

This is the same green used in `frontend/src/App.tsx:50` (`accent-green`).
Keep it as a single, sparingly-applied accent — never as large fills, never
as gradients. Vercel's restraint principle still applies; we just swap the
hue.

## 2. Geist Mono usage extended to all numeric data

Vercel uses Geist Mono only for code blocks and a small number of UI labels.
STRIDE extends Mono usage to **every numeric quantity** because mobile
running data is fundamentally numeric:

| Element | Font |
|---------|------|
| Pace (`5:30/km`, `4:42/km`) | **Geist Mono Bold** |
| Heart rate (`168 bpm`, `Avg 152`) | **Geist Mono Bold** |
| Distance (`12.3 km`, `26.0 km`) | **Geist Mono Medium** |
| Duration (`1:23:45`, `42:15`) | **Geist Mono Medium** |
| Calories (`850 kcal`) | **Geist Mono Regular** |
| Dates (`2026-05-06`, `5/6 周三`) | **Geist Mono Regular** |
| Percentages, ratios (`78%`, `1.12`) | **Geist Mono Regular** |
| Temperature, humidity (`24°C`, `62%`) | **Geist Mono Regular** |
| HR zones, lap numbers, set/rep counts | **Geist Mono Regular** |
| Body labels, headings, navigation, CTAs | Geist Sans (per Vercel default) |

Rationale: monospace gives numbers visual stability — when scrolling a list
of activities or laps, the digits in column align without any
table/right-align gymnastics. This is one of the running data dashboard's
key affordances.

## Where these overrides apply

- All Flutter widgets in `mobile/lib/`
- Future iOS build (Phase 2) inherits the same
- The web frontend (`frontend/`) is informally aligned today; full adoption
  on web is in scope but not blocking v1

## What is NOT overridden

Everything else in `mobile/DESIGN.md` applies as-is:

- Color scale (gray-100 through gray-1000 in light/dark)
- Spacing scale (`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`)
- Border radius (`4 / 6 / 8 / 12`)
- Type scale (display / heading / body / caption)
- Component variants (button states, input chrome, card elevation)
- Motion language (cubic-bezier curves, durations)
- Empty / loading / error state patterns

When a question arises and STRIDE_OVERRIDES.md doesn't address it, defer to
DESIGN.md.
