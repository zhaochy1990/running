# STRIDE Mobile Foundation

Design a native-feeling mobile interface for STRIDE, an AI running coach for serious recreational runners. The product turns watch data into an adaptive training plan, daily decisions, and clear explanations.

## Platform

- Target Android first at a 390 px logical width; remain viable on smaller phones.
- Design one edge-to-edge app screen, not a phone mockup, website, browser window, or presentation board.
- Respect status-bar and bottom safe areas. Keep primary touch targets at least 48 px.
- Use a single-column mobile hierarchy. Do not introduce desktop sidebars or multi-column dashboards.

## Visual Language

- Canvas and surfaces: white `#FFFFFF`; primary text: near-black `#171717`.
- Use the STRIDE green `#1FAD5B` sparingly for the primary action, active state, focus, and meaningful highlights. Never use it as a large background or gradient.
- Use Geist Sans for interface copy. Render all athletic numbers, dates, pace, heart rate, distance, duration, load, percentages, and set/rep counts in Geist Mono with tabular alignment.
- Prefer shadow-as-border: `0 0 0 1px rgba(0,0,0,0.08)`. Keep elevation quiet and functional.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64. Radius scale: 4, 6, 8, 12.
- Establish hierarchy with typography, alignment, whitespace, and rules. Avoid excessive rounded cards, floating pills, gradients, glass effects, and generic fitness illustrations.

## Product Behavior

- User-facing copy is concise Simplified Chinese. Keep standard units such as `km`, `/km`, `bpm`, and `min` where runners expect them.
- Make the next decision obvious without hiding evidence. Training recommendations should expose the metric or reason that supports them.
- Use color as a secondary signal; status must also be clear through text, iconography, or shape.
- Keep bottom navigation stable when the requested screen belongs to a primary tab. Do not add it to focused flows such as authentication or full-screen details unless the brief asks for it.
- Show realistic running data rather than lorem ipsum. Prefer one strong primary action per screen.

## Quality Bar

- The screen must look intentionally designed for STRIDE, not like a generic wellness template.
- Preserve clear loading, empty, error, disabled, and pressed-state affordances when relevant to the brief.
- Do not place design annotations, explanations, color swatches, or implementation notes inside the generated UI.
