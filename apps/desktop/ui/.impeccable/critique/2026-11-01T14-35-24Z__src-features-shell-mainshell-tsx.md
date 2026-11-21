---
target: Desktop visual presentation and interaction evaluation plan
total_score: 27
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
target_identity: "file:E:\\personal_projects\\Nivlo\\apps\\desktop\\ui\\src\\features\\shell\\MainShell.tsx"
target_fingerprint: "sha256:34baf993d594b20d1d650f37c9b33e25d35bcee00f38097a5d8b760f4d78b116"
target_path: "E:\\personal_projects\\Nivlo\\apps\\desktop\\ui\\src\\features\\shell\\MainShell.tsx"
timestamp: 2026-11-01T14-35-24Z
slug: src-features-shell-mainshell-tsx
---
# Desktop visual and interaction evaluation plan

Date: 2026-11-01. Scope: `apps/desktop/ui`, including main, floating and global-search windows. This is an evaluation plan and preliminary review; it does not authorize or implement a redesign.

## Direction and evidence

Nivlo is an **Operate** interface: success means capturing information, organizing it, scheduling it and completing work with little interruption. Preserve its restrained system typography, neutral surfaces, blue accents and familiar desktop controls. Evaluate coordination across the whole journey before polishing individual screens.

Assessment A reviewed current browser fixtures on Today, Inbox, item details, Calendar, Settings, Workflows and Search at 1280×720, and Inbox/details and Calendar at the shipping default 960×640. Source and existing product/interaction plans were also inspected. The preview uses fixture dates; those dates are not evidence of a product defect. Native WebView2 focus/DPI, NVDA, injected errors and real compact floating-window rendering were not validated in this review.

Existing Windows screenshot baselines were last committed on 2026-10-12; UI changes extend through 2026-10-31. Treat those baselines as historical evidence, particularly for the redesigned floating badge. Do not regenerate them until differences have been reviewed.

Assessment B independently ran the source detector and inspected the browser preview at main960×640 and search640×440. Its scan returned two findings: `side-tab` at `src/components/ToastViewport.tsx:32` (a status border) and `bounce-easing` at `src/styles/global.css:385` (optional character-skin animation under reduced-motion protection). Both require contextual interpretation; neither establishes a main-shell design defect. Valid findings JSON was emitted, but the launcher returned exit1 instead of the documented findings exit2. No horizontal overflow was observed on the inspected main view; this does not rule out title truncation with details open.

Five focused test files passed, 108 tests total: main shell, command palette, search app, base contrast and accent contrast. Native E2E was inspected but not run. Read-only browser automation could not inject a detector overlay; screenshots/accessibility-tree and source results were used instead. No overlay was created.

One browser-mock observation requires reproduction: opening search by clicking its trigger left `document.activeElement` reporting that trigger despite the input's `autoFocus`. Do not label this a confirmed WebView2 defect. Add a targeted check that clicking Search allows immediate typing, Tab stays inside the modal, and Escape restores the trigger focus.

## Preliminary assessment

Strengths:

- Stable, labeled navigation and Today counts/progress establish orientation.
- Shared tokens and components cover themes, typography, spacing and reduced motion.
- Shared search, recent items, metadata and keyboard paths support frequent work; retained sources support traceability.

The visual language is coherent. The main weakness is how available space is distributed around identification and scheduling.

| Priority | Evidence | Evaluation and candidate direction |
| --- | --- | --- |
| P1 | At 960×640, the 216px sidebar and 384px detail panel leave a narrow item list. Long titles truncate. The eight-row description precedes scheduling, which begins below the viewport. | Test identifying and scheduling an Inbox item with details open. Compare a task-first field order, compact description and adaptive panel behavior before choosing a solution. |
| P1 | Calendar titles and deadline chips truncate even with sparse fixtures at 960×640; the backlog hides at this width. | Test similar-prefix titles, eight or more items/day, unscheduled items and keyboard rescheduling. Require reliable access to full identity and date before mutation. |
| P2 | Search footer instructions and Settings section links are small and dense; some Workflows text truncates despite unused workspace. | Test reading, locating and understanding supporting information; compare contextual hints and clearer hierarchy. |
| P2 | Inbox actions appear on hover/focus, `>` exposes commands, and Tab cycles capture types. | Measure first-use discovery without coaching. Keep efficient shortcuts while verifying visible alternatives. |
| P2 | Six visual regression scenes omit default-size open details, Search, Settings, Notes, Projects, Workflows and most states. PRODUCT.md/DESIGN.md are absent. The interaction plan says search height was deferred, but current code implements fitting. | Build a current surface/state inventory and behavior ledger. Document implemented conventions and discrepancies; do not treat planned behavior as tested behavior. |

No P0 was established in this representative review. This does not certify untested flows.

Provisional Nielsen scores, based on source and representative rendered review:

| Heuristic | Score / 4 | Evidence or remaining question |
| --- | --- | --- |
| System status | 3 | Counts/progress and registration state exist; async/error behavior needs runtime checks. |
| Real-world match | 3 | Task-oriented labels; test understanding of scheduled versus due. |
| Control and freedom | 3 | Close, undo and unsaved-change safeguards; validate across native windows. |
| Consistency | 3 | Shared tokens/components; verify cross-window state and shortcuts. |
| Error prevention | 3 | IME and mutation guards in source; stress cases remain. |
| Recognition | 2 | Hidden actions, command syntax and truncated identity require learning. |
| Efficiency | 3 | Quick capture, search, bulk tools and keyboard paths exist. |
| Minimalist presentation | 3 | Coherent restraint; detail/calendar space allocation needs work. |
| Recovery | 2 | Draft retry and undo exist; injected failure recovery untested. |
| Help | 2 | Onboarding and shortcut help exist; small guidance and stale plans reduce confidence. |
| **Total** | **27/40** | **Provisional: acceptable; task-flow improvements required.** |

## Evaluation sequence

Suggested effort: 4–6 working days, assuming participant and mixed-DPI hardware availability. This is an estimate, not a schedule commitment.

| Phase | Lead responsibility | Work | Deliverable / exit condition |
| --- | --- | --- | --- |
| 1. Establish baseline, 0.5–1 day | Design + frontend | Inventory surfaces, states and conventions; capture current default and larger windows; reconcile plan/code differences. | Dated screenshots, surface/state matrix, behavior ledger and baseline task recordings. |
| 2. Evaluate core tasks, 1–2 days | UX researcher or designer | Run 5–8 formative sessions with first-time and experienced desktop users. Collect the measures below without coaching. | Task results and evidence-backed friction ranked by frequency, impact and recovery cost. Small-sample results are directional. |
| 3. Technical and native checks, 1–2 days | Frontend + Windows QA | Keyboard/NVDA, contrast, zoom, themes/languages, mixed DPI, native focus/handoff and app-specific capture sources. Reuse existing automated tests. | Reproduction records; passed/failed/unverified status per check; no browser-mock claim of native success. |
| 4. Compare solutions and retest, about 1 day | Design + frontend + QA | Prototype changes to the highest-impact flow, then rerun identical tasks. | Before/after comparison, prioritized implementation backlog and reviewed regression coverage. Implementation effort is separate. |

### Task script and proposed acceptance targets

Timing begins once a participant receives the task and required content; record first-use and practiced trials separately. These are proposed targets, not measured results.

| Task | What to observe | Proposed target |
| --- | --- | --- |
| Capture text, URL and file from another app | Discoverability, input focus, duplicates, source preservation and return to previous work | Simple text capture within 15s after learning; exactly one correct item with retained source where applicable. |
| Process an Inbox item into a project and date | Identification with detail open, schedule/due comprehension, scrolling and backtracking | Within 30s after learning; intended item and date correct; no assistance. |
| Identify and reschedule a calendar item | Similar titles, crowded days, backlog access, drag and keyboard alternatives | Within 30s after learning; no wrong-item/date mutation. |
| Find and open/complete through global search | First-use discovery, selection, IME Enter, completion feedback and main-window handoff | Known-item retrieval within 15s after learning; correct target and visible confirmation. |
| Undo completion/deletion and recover failed save | Discover undo, recover after timeout through persistent controls, retain drafts, retry safely | No lost work or unrecoverable unintended change; no dependence on noticing a short-lived toast. |
| Change a shortcut and leave an unsaved workflow | Registration/conflict feedback, disable/restore, cancel/confirm navigation | Outcome understood; no silent draft loss or unexpected command. |

For each task, record unassisted success as a fraction, elapsed time, clicks/keystrokes, backtracking, wrong actions, requests for help and single-task ease (1–7). Proposed aggregate gate: at least 90% unassisted success across core task attempts and median ease at least 6/7. With 5–8 participants, report exact counts and each task separately; a strong aggregate must not conceal a failed task. Any data loss or wrong-item destructive outcome blocks acceptance.

### Visual coordination and state matrix

- Main window: shipping 960×640, existing regression size 1100×720 and larger 1280×800; include details open and resized windows. Determine and document supported minimum size.
- Floating: actual native pill64×32, number36×36, dot28×28, skin88×40 and expanded panel. Browser tools that clamp tiny viewports cannot certify these shapes.
- Search: 640px width, content-fitted height up to440px; recent, results, no results, pending query, command mode and completion/undo.
- Content: empty, typical and dense lists; long Chinese/English titles, similar prefixes, long paths/URLs, many tags, overdue and completed items; eight-plus calendar items/day.
- States: loading, success, failure, disabled, focused, selected, hover, saving, save error/retry and unsaved navigation. Use representative combinations rather than an unbounded Cartesian product.
- Variants: light/dark and Chinese/English on every critical surface; reduced motion and 200% content zoom on core tasks. Review heading rhythm, row height, semantic colors, icons, hit areas and primary-action placement together.

### Accessibility and native checklist

- Complete core tasks keyboard-only: visible focus, logical order, modal containment/return, no traps, calendar alternatives to drag, IME-safe Enter and no unintended completion.
- Specifically reproduce main-palette initial focus after opening by click, immediate typing, Tab wrapping and focus return. Preserve the existing passing shortcut, IME, undo and announcement checks.
- Check NVDA labels, selected/expanded states and loading/success/error announcements. Inspect actual computed contrast: proposed AA targets 4.5:1 normal text, 3:1 large text and applicable non-text controls; measure effective colors, including transparency.
- At 200% zoom and supported window sizes, preserve access to content and critical controls. Respect reduced motion; identify targets that are too small or tightly spaced in actual use.
- Use a test data profile on Windows/WebView2: global shortcut invocation, direct typing, Esc focus return, click-away without focus theft, hidden/uncreated main-window handoff, `>` commands and tray Search.
- Test 100%/150% mixed-DPI monitors, moving across monitors, work-area bounds and edge persistence. Browser resizing is not a substitute.
- Revisit the existing drop matrix using real Chrome, Edge, Firefox, VS Code, Word and Explorer sources. Generic OLE test success does not establish every application's format handling.
- Re-measure global-search invocation on a release build. Retain the existing repeated-open budget below150ms; report hardware, cold/warm runs and percentile distribution. Old measurements are context, not a current pass.

## Decisions and deliverables

Use P0 for blocked core tasks or data loss, P1 for substantial difficulty or wrong-target risk, P2 for recoverable friction and P3 for polish. Every issue needs route/state, environment, reproduction, evidence, user impact, proposed remedy and retest criterion. Assign implementation owners during triage.

First evaluate detail/calendar space allocation. Then address discoverability and guidance density, followed by cosmetic alignment. Preserve existing power-user paths unless comparison demonstrates a better interaction.

Final package: current screenshot/state matrix, task scorecard, accessibility/native checklist, token/component consistency inventory, prioritized backlog and a reviewed regression plan. Add snapshots for confirmed gaps; do not rewrite all historical baselines as a substitute for review. Publish PRODUCT.md/DESIGN.md only after confirming product truth and incumbent conventions with the user.

## Evidence references

- Product: `docs/architecture/Nivlo_Product_Design.md`.
- Interaction history: `docs/development/interaction-optimization-plan.md`.
- Native capture coverage: `docs/development/drop-matrix.md`.
- Historical timings: `docs/development/perf-baseline.md`.
- Shared visual rules: `apps/desktop/ui/src/styles/tokens.css`, `src/styles/global.css`, `src/components/`.
- Layout: `src/features/shell/MainShell.tsx`, `src/features/detail/ItemDetailPanel.tsx`, `src/features/calendar/CalendarPage.tsx`.
- Window geometry: `apps/desktop/src-tauri/src/windows/mod.rs`, `windows/search.rs`.
- Existing verification: `scripts/visual/visual.mjs`, `tests/e2e/e2e.mjs`, `tests/visual/baselines/win32/`.
