# Nivlo design context — implementation draft

## Overview

Extracted 2026-11-01; pending human confirmation before final publication. Preserve the incumbent neutral desktop system. This document describes source evidence and explicitly separates future requirements. The CSS tokens remain normative; no duplicate token definitions are introduced here.

## Colors

Use [tokens.css](src/styles/tokens.css) and [global.css](src/styles/global.css). Light surfaces are white on a cool neutral background; dark surfaces use the existing charcoal palette. Blue denotes primary/selected/focus, red danger, green success and amber Tips. Status also needs text or icon evidence. Rendered contrast, transparency and disabled states still require verification; token tests alone cannot certify them.

## Typography

System UI stack, starting with Microsoft YaHei UI; Cascadia Mono for code. Incumbent token scale: 12/13/14/16/20px. Body is 14px with 1.5 line height. Source deviations include 10/11px shortcut/guidance/calendar text. Target: supporting guidance and deadline labels at least 12px, primary content 14px, ordinary actions 13–14px.

## Layout

Use the existing 4px rhythm, 8px compact gaps, 12–16px related fields and 24px major sections. Observed main grid reserves 216px navigation and a 384px detail panel regardless of viewport; default native main size is 960×640. This compresses list titles.

Target (not yet implemented): at least 1200px shell width permits docked details; 800–1199px uses a modal detail sheet; below 800px uses a labeled navigation drawer. Calendar backlog docks only with at least 1000px calendar content width. Preserve a stable editor instance on resize. The default native size stays unchanged. Core flows must remain reachable at effective widths around 400px and 200% zoom.

## Elevation & Depth

Use existing md/lg shadows for elevated surfaces. Layer tokens: menu 40, dialog 45, tooltip 50, toast 60. One modal owns focus; do not stack independent backdrops. Motion uses existing 120/200ms tokens and reduced-motion overrides.

## Shapes

Incumbent radii are 4/8/12px plus full radius. Preserve familiar buttons, input borders, compact badges and semantic icons. Native floating pill/number/dot/skin dimensions are 64×32 / 36×36 / 28×28 / 88×40 logical pixels; browser viewport captures cannot certify native hit bounds.

## Components

Reuse Button, Input, Textarea, Tooltip and Menu. Button has primary/secondary/ghost/danger variants; medium is 36px and compact 28px. Global focus-visible is a 2px token-colored outline with 2px offset. Selected, busy, saved and failed states have separate meanings.

Observed details put description before scheduling and delete near Close. Target: title and scheduling first, compact empty description, source summary, labeled secondary actions and persistent save/retry feedback. Observed Calendar chips truncate and use native title text; target full-title Tooltip on focus/hover and keyboard date editing through details. These targets do not claim implemented behavior.

## Do's and Don'ts

- Preserve typed IPC, backend validation, localization, Markdown, undo and native window ownership.
- Use full accessible identity when truncating dense rows; wrap long source paths in details.
- Keep pending drafts mounted until successful flush or confirmed discard.
- Do not add decorative motion, a new visual identity, a component library or a second item store.
- Review actual theme/language/zoom variants; never infer native or assistive-technology success from browser mocks.

See [stage ledger](../../../docs/development/ui-ux-progress.md) for evidence and remaining gates.
