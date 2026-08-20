# STRIDE Raycast Mobile Foundation

Design a native-feeling mobile interface for STRIDE, an AI running coach for serious recreational runners. Adapt the OpenDesign Raycast system to mobile training workflows: precision-instrument darkness, restrained coral punctuation, dense athletic evidence, and calm decisions.

Reference: `https://open-design.ai/zh/plugins/design-system-raycast/`.

## Platform

- Target Android first at 390 px logical width and remain fully usable at 360 px.
- Produce one edge-to-edge app screen, never a phone mockup, browser frame, website, or presentation board.
- Respect status and bottom safe areas. Every primary control and route row has a semantic touch target of at least 48 px.
- Use a single-column mobile hierarchy. Focused detail flows use a back action without bottom navigation.
- Primary tabs use the stable four-item navigation `跑者 / 训练 / 数据 / 教练`.

## Color Roles

- Canvas `#07080A`; standard surface `#101111`; raised surface `#1B1C1E`; pressed surface `#0D0D0D`.
- Primary text `#F9F9F9`; secondary text `#CECECE`; muted text `#9C9C9D`; metadata and disabled text `#6A6B6C`.
- Containment uses `rgba(255,255,255,0.06)` borders; quiet dividers use `rgba(255,255,255,0.04)`.
- Raycast coral `#FF6363` is the STRIDE brand accent. Use it as punctuation for the active decision, current training state, key route point, or destructive signal; keep it below roughly ten percent of a normal screen.
- Interactive and focus blue is `#55B3FF`; success and healthy recovery use `#5FC992`; warning uses `#FFBC33`. STRIDE green is semantic success only, never the global brand or primary-action color.
- Status is always encoded with text, icon, shape, or position in addition to color.

## Typography

- Use Inter for headings, body, labels, buttons, and navigation. Use weight 500 as the body baseline on dark surfaces.
- Enable `calt`, `kern`, `liga`, and `ss03` globally. Use positive tracking from `0.2px` to `0.4px` for body, labels, and navigation; avoid negative tracking on body copy.
- Use Geist Mono with tabular numerals for every date, time, week range, pace, heart rate, distance, duration, load, percentage, target, set, and repetition count.
- Mobile scale: 40/44 display, 22/28 screen title, 18/23 card title, 16/26 body, 14/20 compact body, 12/16 label. Long Chinese guidance uses at least 1.6 line height.

## Depth And Shape

- Cards use 12-16 px radii; compact controls use 6-8 px; pills are reserved for statuses, compact filters, and the primary CTA.
- Standard card: `#101111`, 1 px translucent white border, and no free-floating drop shadow.
- Ring elevation: `rgb(27,28,30) 0 0 0 1px, rgb(7,8,10) 0 0 0 1px inset`.
- Raised elevation: `rgba(255,255,255,0.05) 0 1px 0 inset, rgba(0,0,0,0.28) 0 1.2px 2.4px, 0 0 0 1px rgba(255,255,255,0.06)`.
- Interactive controls pair an inset top highlight with a dark inset bottom edge. A single generic `shadow-sm` is not an approved elevation treatment.
- Focus uses a visible two-layer ring: `0 0 0 1px #55B3FF, 0 0 0 4px rgba(85,179,255,0.45)`. The solid edge maintains at least 3:1 non-text contrast against every dark surface.

## Components

- Primary CTA: near-white or translucent-white surface, `#18191A` text, 48-52 px height, and a full pill radius. Coral is reserved for the action icon, active marker, or genuinely critical CTA.
- Secondary action: transparent or raised dark surface, near-white text, 6-8 px radius, translucent border, and ring/raised elevation.
- Ghost action: no fill, muted text, minimum 48 px hit area; brighten toward white on interaction.
- Inputs use canvas-dark fill, 8 px radius, subtle white border, muted placeholder, and blue focus ring.
- Data cards expose the decision first, its evidence second, and history last. Prefer precise rows, rails, and compact trends over generic dashboard tiles.
- Coach proposals show old and proposed states explicitly and keep the confirmation action separate from discussion.

## Layout And Motion

- Spacing scale is 4, 8, 12, 16, 20, 24, 32, 48. Use 20 px mobile side margins and 24-32 px separation between major sections.
- Product information may be dense; surrounding space remains calm. Avoid a card for every metric.
- Motion uses 150 ms for immediate feedback and 200 ms for normal transitions with `cubic-bezier(0.2,0,0,1)`.
- Hover and pressed feedback primarily adjusts opacity and inset depth rather than swapping to unrelated colors. Pressed scale may be subtle and must not cause layout movement.
- Respect reduced-motion preferences: remove nonessential translation and scale, make state changes immediate or use a short opacity transition, and preserve all information without animation.

## Product Behavior

- User-facing copy is concise Simplified Chinese. Keep runner-standard units such as `km`, `/km`, `bpm`, and `min`.
- Make the next decision obvious without hiding evidence. Training recommendations cite the metric or reason that supports them.
- Use realistic running data rather than placeholders. Prefer one visually dominant action per screen.
- Represent relevant loading, empty, error, offline, disabled, pressed, and success states explicitly.

## Acceptance Gate

- The rendered canvas is `#07080A`, not white or pure black; core surfaces and text use the roles above.
- Inter is the interface font, Geist Mono is the athletic-data font, and body tracking is non-negative.
- Cards and controls use translucent borders plus paired outer/inset depth where elevated.
- Coral remains punctuation; green appears only for success or healthy recovery.
- The screen has no horizontal overflow at 360 or 390 px, respects safe areas, and has no obsolete five-item navigation.
- The UI contains no gradients used as decorative backgrounds, glass blur, generic fitness art, design annotations, or internal implementation terminology.
