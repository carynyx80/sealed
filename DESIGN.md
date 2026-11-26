# Sealed — design system: "private-bank broadsheet"

The brief: beautiful, confident, unmistakably NOT the default AI look. Banned: Instrument Serif, Inter, Plus Jakarta,
JetBrains Mono, Space Grotesk, DM Sans, Fraunces; cream/beige + terracotta; big soft rounded-3xl blob cards; purple gradients;
glassmorphism; emoji icons; "✨"; generic three-icon feature rows; centered-everything hero with two pill buttons as the only idea.

Reference feel: a Swiss private bank's annual report crossed with a broadsheet's markets page. Printed, precise, quiet money.

## Type (loaded in apps/web/src/app/layout.tsx)
- `font-display` / `font-sans` = **Schibsted Grotesk** (400–900). Headlines bold (700) with tight negative tracking; UI 400/500/600.
  Use the `text-display-xl|lg|md|sm` sizes for headings. Headlines are left-aligned, set large, allowed to break dramatically.
- `font-serif` / `.accent` = **Libre Caslon Text italic**. Sparing: ONE emphasised word or short phrase in a headline, pull quotes,
  footnotes. Never for UI labels or body copy.
- `font-mono` / `.num` = **Fragment Mono** for EVERY number, price, timer, hash, address, ticker and eyebrow label. Tabular, slashed zero.
- Eyebrows/section marks: mono, 11px, uppercase, tracking 0.08em, muted (`.eyebrow`, `.section-mark` e.g. "§ 02 — Buyback vault").

## Color (tailwind tokens)
- `paper` #F1EFE9 page · `paper-deep` #E8E5DC tinted panels · `sheet` #FCFBF8 cards · `white` inputs only
- `rule` #DEDAD1 hairlines · `rule-strong` #C9C4B8 hover/active
- `ink` #0F0F0D · `ink-soft` #2A2926 · `ink-slate` #5C5A54 secondary · `ink-muted` #8F8C84
- `signal` #2E3FE0 ultramarine — brand + privacy (Helius Privacy Ring) accent; `signal-tint` #E9ECFF. Use scarcely: one signal thing per view.
- `gain` #0A7D52 positive / vault buys · `burn` #D7263D burns, countdown < 30s, negative change
- `night` palette for inverted ink sections (`.card-night`, bg-night text-night-text): use for 1–2 dramatic bands per page
  (e.g. hero stats band, privacy ring section, vault countdown).
Legacy names (cream, linen, hairline, emerald, terracotta) are aliases to the new values — migrate them to the new names.

## Shape, layout, detail
- Radius: cards `rounded-card` (14px), fields `rounded-field` (10px), pills only for chips/buttons. No rounded-3xl.
- Borders over shadows. 1px `rule` hairlines; use ruled tables/ledgers with hairline dividers, not floating boxes everywhere.
- 12-col grid, generous margins, asymmetric compositions; big numerals as graphic elements; section marks "§ 01".
- Fine print matters: footnotes, units in muted mono, "as of" timestamps, tick marks on charts, crisp 1px SVG strokes.
- Icons: thin 1.25px stroke inline SVG, geometric; no emoji.

## Motion (framer-motion)
- Springs stiffness 260 damping 26 (existing `spring.ts`). Restraint: reveal once, numbers roll, countdowns tick.
- Signature motif: the **ring** — a thin concentric-circle mark for privacy/sealed state (slowly rotating dashed ring, `animate-ring`).
- Respect prefers-reduced-motion (MotionConfig reducedMotion="user" is already set).

## Quality bar
Responsive 375px → 1440px with no horizontal scroll, zero console errors, no hydration mismatches, AA contrast.
