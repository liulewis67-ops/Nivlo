# Nivlo design context — implementation draft

## Overview

Extracted 2026-11-01; pending human confirmation before final publication. Preserve the incumbent neutral desktop system. This document describes source evidence and explicitly separates future requirements. The CSS tokens remain normative; no duplicate token definitions are introduced here.

## Colors

Use [tokens.css](src/styles/tokens.css) and [global.css](src/styles/global.css). Light surfaces are white on a cool neutral background; dark surfaces use the existing charcoal palette. Blue denotes primary/selected/focus, red danger, green success and amber Tips. Status also needs text or icon evidence. Rendered contrast, transparency and disabled states still require verification; token tests alone cannot certify them.

## Typography

System UI stack, starting with Microsoft YaHei UI; Cascadia Mono for code. Incumbent token scale: 12/13/14/16/20px. Body is 14px with 1.5 line height. Source deviations include 10/11px shortcut/guidance/calendar text. Target: supporting guidance and deadline labels at least 12px, primary content 14px, ordinary actions 13–14px.

## Layout

Use the existing 4px rhythm, 8px compact gaps, 12–16px related fields and 24px major sections. Observed main grid reserves 216px navigation and a 384px detail panel regardless of viewport; default native main size is 960×640. This compresses list titles.

Implemented in M1: at least 1200px shell width permits docked details; 800–1199px uses a modal detail sheet; below 800px uses a labeled navigation drawer. One detail instance changes positioning without reparenting or saving merely because of resize. Modal sheets contain Tab and make the background inert. The default native size stays unchanged. M1 browser acceptance covers details and navigation at effective widths down to 400px; other pages' reflow, actual 200% zoom/native and assistive-technology acceptance remain in their owning stages and the integrated sweep.

Implemented in M2: Calendar backlog docks at at least 1000px of calendar content width. Otherwise the labeled toolbar action opens a side sheet, up to 384px / viewport minus 32px, without compressing the grid. The sheet uses the browser dialog top layer for full-shell background inertness and transfers focus ownership before opening details. This is DOM modality, not native window geometry. Below 600px of calendar content width, the week stacks labeled days vertically; the seven-column layout broke titles into single-character lines at 400px. Layout thresholds live in `src/lib/layout.ts`.

## Elevation & Depth

Use existing md/lg shadows for elevated surfaces. Layer tokens: menu 40, dialog 45, tooltip 50, toast 60. One modal owns focus; do not stack independent backdrops. Motion uses existing 120/200ms tokens and reduced-motion overrides.

## Shapes

Incumbent radii are 4/8/12px plus full radius. Preserve familiar buttons, input borders, compact badges and semantic icons. Native floating pill/number/dot/skin dimensions are 64×32 / 36×36 / 28×28 / 88×40 logical pixels; browser viewport captures cannot certify native hit bounds.

## Components

Reuse Button, Input, Textarea, Tooltip and Menu. Button has primary/secondary/ghost/danger variants; medium is 36px and compact 28px. Global focus-visible is a 2px token-colored outline with 2px offset. Selected, busy, saved and failed states have separate meanings.

M1 details put title/brief and scheduling before reminder, project, priority, description, tags, source and conversion. Description starts at three rows and expands the same native textarea, retaining draft, selection and undo ownership. Source has a concise summary and explicit expansion for the full wrapped location. Delete lives in the labeled More menu. Close and save state remain in the header.

Draft saves are serialized. A leave request waits for the in-flight version and subsequent edits; failures preserve the editor and expose Retry, Stay and confirmed Discard. One pending destination uses latest-request-wins; Stay clears it. Active detail drafts precede underlying Notes drafts, and the existing Workflow guard remains authoritative for its unsaved definition. Native hiding retains mounted drafts; process destruction/crash recovery is not claimed.

M2 calendar chips use wrapping full-title Tooltip on focus/hover, full accessible identity and a localized date-edit action description. Week/backlog titles wrap. Due overlays retain dashed borders, flag and a 12px Due label. Month cells show at most three chips, reducing that count by measured cell height to reserve a reachable overflow action; expanding it opens the corresponding week and focuses its labeled item region. The existing date controls in details provide the route to schedule without dragging. Success announcements use the persisted title/date; failed scheduling/Undo report an error and retain the last successful state. Inline creation ignores IME Enter, suppresses duplicate submissions and clears only after confirmed success; failure/blur retain text for retry.

## Do's and Don'ts

- Preserve typed IPC, backend validation, localization, Markdown, undo and native window ownership.
- Use full accessible identity when truncating dense rows; wrap long source paths in details.
- Keep pending drafts mounted until successful flush or confirmed discard.
- Do not add decorative motion, a new visual identity, a component library or a second item store.
- Review actual theme/language/zoom variants; never infer native or assistive-technology success from browser mocks.

See [stage ledger](../../../docs/development/ui-ux-progress.md) for evidence and remaining gates.
