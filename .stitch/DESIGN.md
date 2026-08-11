# Design System: STRIDE Ember
**Project ID:** 12727163079393064568

## 1. Visual Theme & Atmosphere

STRIDE Ember is a dark, focused mobile system for athletes who need calm guidance rather than a dense dashboard. It borrows Raycast's confident layering and precision, then replaces its stronger gradient energy with a restrained coral signal. The interface should feel native on both iOS and Android: compact, tactile, highly legible, and clearly distinct from the STRIDE web product.

Dark surfaces create hierarchy through subtle tonal steps and fine inset highlights. Coral appears only where attention or action is required. Training information should read like a coach's concise briefing, with enough breathing room to make complex data feel approachable. Avoid neon effects, glossy gradients, oversized desktop panels, and decorative charts without a decision-making purpose.

## 2. Color Palette & Roles

- **Night Canvas (#07080A):** App background and full-screen foundation.
- **Obsidian Surface (#101111):** Primary cards, conversation surfaces, and bottom navigation.
- **Raised Graphite (#18191A):** Elevated cards, inputs, selected rows, and active context modules.
- **Soft Divider (#2A2B2D):** Hairline borders and quiet structural separation.
- **Primary Ink (#F9F9F9):** Titles, key values, and high-priority content.
- **Secondary Ink (#CECECE):** Body copy and session details.
- **Muted Ink (#8F9093):** Labels, timestamps, metadata, and inactive navigation.
- **Stride Coral (#FF6363):** Primary action, current state, progress, and Coach emphasis. Use sparingly.
- **Coral Pressed (#E95252):** Pressed and high-contrast coral state.
- **Coral Wash (#2A1719):** Low-emphasis coral background for selected states and insights.
- **Recovery Mint (#69D3A7):** Completed, ready, and positive recovery states only.
- **Caution Amber (#E3AC5B):** Fatigue or attention states only; never as decoration.

Coral should occupy less than ten percent of a typical screen. Data visualizations begin in neutral grays and use coral only for the active series or decision-relevant point.

## 3. Typography Rules

Use **Inter** as the cross-platform product typeface, falling back to the native iOS or Android sans-serif for Chinese glyphs. Titles use semibold weight with tight but natural spacing. Body copy uses regular weight and generous line height for Chinese readability. Labels use medium weight and never rely on all caps.

Use **JetBrains Mono** or the platform's tabular-numeral feature for pace, distance, duration, heart rate, training load, and date ranges. Numeric treatments should align cleanly without making the interface feel like a terminal.

Maintain a compact mobile scale: 28px display values, 22px screen titles, 17px card titles, 15px body copy, 13px metadata, and 11px navigation labels.

## 4. Component Stylings

* **Buttons:** Primary actions use Stride Coral with dark text, a comfortable 48px touch height, and softly rounded 14px corners. Secondary actions use Raised Graphite with a Soft Divider outline. Icon actions are 44px square. Pressed states darken or compress slightly; do not add glow.
* **Cards/Containers:** Cards use Obsidian Surface or Raised Graphite, fine translucent borders, and 16px corners. Important cards may use a very subtle top inset highlight. Shadows are nearly absent; hierarchy comes from surface tone and spacing.
* **Inputs/Forms:** Inputs use Raised Graphite, 16px corners, a minimum 48px touch height, and a quiet outline. Focus uses a thin coral border rather than a bright halo. The chat composer may grow to multiple lines while remaining pinned above navigation.
* **Chips/Statuses:** Compact pill shapes are reserved for phase, readiness, completion, and metric context. Neutral states stay gray; coral marks current or actionable states; mint marks completed or healthy states.
* **Navigation:** A dark bottom bar uses five evenly spaced destinations. The active destination uses coral icon and label; inactive destinations use Muted Ink. Respect native safe areas.
* **Data Displays:** Prefer concise metric pairs, progress rails, and small trend lines over dashboard grids. Use tabular numerals and explicit labels. Never communicate status by color alone.

## 5. Layout Principles

Design for a 390px-wide mobile viewport with native safe areas. Use a 20px horizontal page margin, an 8px spacing rhythm, and at least 44px touch targets. Keep the primary decision or next action visible in the first viewport.

Coach Chat uses a natural message transcript, compact athlete context, embedded Coach proposal cards, and a bottom-pinned composer. Training Plan uses a dominant Today card followed by a vertically scannable seven-day schedule; it should not resemble a web dashboard compressed onto a phone.

Information hierarchy follows: current decision, supporting evidence, then historical detail. Keep charts secondary to interpretation. Use progressive disclosure for detailed analysis and workout prescriptions.
