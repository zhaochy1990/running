# Runner Home Active Week — Precision Refinement

Edit the selected screen with only the three changes below. Preserve all other layout, Chinese copy, metrics, content order, four-item bottom navigation, spacing, and typography exactly as they are.

1. Replace the top-right bell/notification action with a watch data sync action using the Material `sync` icon. Keep the visible freshness text `08:12 已同步` near the greeting/date area.
2. Make the top bar fully opaque solid white `#FFFFFF`. Remove `backdrop-blur`, translucent opacity, frosted-glass styling, and any `bg-white/80` treatment.
3. Make both top-bar icon buttons exactly 48 x 48 logical pixels. Give `调整今天安排` an explicit 48-pixel height (`h-12`), not vertical padding that computes to less than 48 pixels, without turning it into another filled primary button. Bottom navigation items must each use the full 64-pixel bar height as their tap area.

Hard preservation rules:

- Bottom navigation remains exactly `跑者`, `训练`, `数据`, `教练` in that order. Never add `发现` or `我`.
- Keep STRIDE green `#1FAD5B`.
- Keep the hierarchy and all sections: decision, evidence, today's training, weekly progress, next key session, recent activities, all activities.
- Do not translate any Chinese headings into English.
- Do not redesign the page or add cards, charts, banners, gradients, or new content.
