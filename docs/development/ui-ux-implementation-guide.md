# StarDeskBox desktop UI and interaction implementation guide

Date: 2026-11-01  
Status: development specification; implementation and acceptance are pending.  
Progress: [stage ledger and baseline evidence](ui-ux-progress.md).  
Scope decision: all five findings from the [evaluation plan](ui-ux-evaluation-plan.md), covering detail/calendar operation, discoverability/guidance, accessibility and native Windows behavior.  
Audience: design, frontend, desktop integration, QA and release maintainers.

## 1. Purpose and authority

Make capture → organize → schedule → execute feel like one coordinated workflow. Preserve StarDeskBox's existing neutral surfaces, system typography, semantic accents and familiar desktop controls. Improve hierarchy, available space and predictable operation across the main, floating and search windows.

This document defines the target implementation. Statements marked **observed** describe the preliminary review; **required** describes future acceptance; **verify** identifies unresolved behavior. A requirement is not a claim that the current code already satisfies it.

Use this guide for the work described here, the [product design](../architecture/StarDeskBox_Product_Design.md) for product semantics, and the [frontend guide](StarDeskBox_Frontend_Development_Guide.md) and [backend guide](StarDeskBox_Backend_Development_Guide.md) for architectural boundaries. Reconcile an actual conflict in a written decision before changing domain behavior. The [older interaction plan](interaction-optimization-plan.md) remains historical evidence; its fixed-height search description is superseded by current content-fitting behavior.

No new product category, synchronization service, item type, data schema or general command framework is needed for this work. Keep domain rules and persisted items behind typed IPC. A draft awaiting save is temporary UI state, never a second business-data store. Do not add a component library or move native window geometry/focus into React.

### 1.1 Starting evidence and limits

- **Observed:** coherent shared tokens and controls; default main window 960×640; sidebar 216px and detail 384px; detail-open Inbox titles compress; description precedes scheduling; calendar labels truncate.
- **Observed:** the six visual scenarios primarily cover main 1100×720 and floating states; historical baselines predate recent badge changes.
- **Observed:** 108 focused tests passed during the review. This is historical evidence, not the result of implementing this document.
- **Verify:** browser search opened by click appeared to retain focus on its trigger. Reproduce before assigning a root cause; native WebView2 failure was not established.
- **Verify:** runtime save failure during close/switch, NVDA, native compact badge rendering, mixed DPI, tray handoff and application-specific drag formats.
- **Source risk:** `useItemDraft` starts saving from unmount cleanup, catches errors internally and returns no outcome. This cannot by itself enforce successful save before destroying the editor. Treat the failure path as a required engineering investigation, not a reproduced data-loss incident.

### 1.2 Requirements and traceability

| ID | Required outcome | Work package | Acceptance evidence |
| --- | --- | --- | --- |
| UX-01 | Identify and schedule an item at default size without navigating past an empty description | W1 | Default-size recording, detail tests, screenshots |
| UX-02 | Resizing or changing layout retains the active item, edits, selection and sensible focus | W1/W2 | Resize, zoom and pending-save tests |
| UX-03 | Identify calendar items and change intended dates accurately with mouse and keyboard | W2 | Dense/similar-title task results and calendar tests |
| UX-04 | Common actions have visible routes; shortcuts remain efficient and documented | W3 | Uncoached first-use sessions and shortcut checks |
| UX-05 | Guidance remains readable and contextual in Chinese/English and both themes | W0/W3 | Rendered variant matrix |
| UX-06 | Failed saves remain recoverable through navigation, close and retry | W1/W4 | Injected failure and in-flight edit tests |
| UX-07 | Keyboard focus and announcements follow actual interaction state | W4 | Keyboard, browser focus, NVDA records |
| UX-08 | Native invocation, handoff, placement and capture work on supported Windows setups | W5 | Release-build E2E and device matrix |
| UX-09 | Design rules, behavior records and regression coverage describe shipped behavior | W0/W6 | Documentation and reviewed baseline manifest |

## 2. Shared visual and layout contract

All dimensions below are proposed CSS/logical pixels, not physical screen pixels. Use available container width rather than monitor resolution or devicePixelRatio to choose layout. Verify against actual fonts and translated content. Centralize new values in tokens/layout constants; do not scatter breakpoint checks through feature components.

| Area | Implementation contract |
| --- | --- |
| Identity | Reuse `tokens.css`, `global.css`, `Button`, `Input`, `Tooltip`, `Menu` and existing navigation icons. Semantic status must also have text/icon evidence. |
| Typography | Keep the existing 12/13/14/16/20px scale. Primary content 14px, ordinary actions 13–14px, supporting text at least 12px. Remove 10/11px instructional text and deadline labels. Use 16/20px headings according to existing hierarchy. These are project targets, not a substitute for zoom/contrast checks. |
| Rhythm | Use the existing 4px spacing basis: 8px inside compact groups, 12–16px between related fields, 24px between major sections. Align related headers and list content edges. |
| Controls | Ordinary actions remain 36px high; compact controls at least 28px. New icon targets at least 28×28px; use 36px for primary small-window actions. Keep dense calendar controls distinguishable and separated. |
| State | Selected, focused, hovered, disabled, busy, saved and failed states have distinct meanings. Focus is not indicated solely by a fill change. Reuse the existing focus token and short motion durations. |
| Motion | Animate opacity/transform where needed; honor reduced motion. Do not add motion to core task completion merely for decoration. Optional skin animation stays optional. |
| Overflow | Page-level horizontal overflow is unacceptable in core flows. Long identifiers wrap in details; dense rows may truncate only when full identity is accessible by keyboard and pointer. Editors/code may have their own justified horizontal scrolling. |
| Layers | Reuse menu/dialog/tooltip/toast z tokens. Define which modal owns focus. Close or suspend incompatible transient surfaces; do not stack independent full-screen backdrops. |

### 2.1 Responsive layout decisions

| Available shell width | Main navigation | Item details | Calendar backlog |
| --- | --- | --- | --- |
| At least 1200px | Existing 216px sidebar | Docked 384px panel; center retains at least 600px | Dock only when calendar's own content width is at least 1000px |
| 800–1199px, including default 960px | Existing 216px sidebar | Modal side sheet, width up to 384px, with backdrop; list retains its normal width behind it | Explicit toolbar action opens a modal sheet instead of squeezing the grid |
| Below 800px, including effective width under zoom | Compact header with labeled navigation trigger; navigation becomes a modal drawer | Modal sheet up to `viewport width minus 32px`; stack date/time controls when needed | Same modal sheet pattern; full-width usable controls |

At 960×640, a modal sheet is the selected implementation direction. At 1200px the width budget is 216+384+600. These are initial engineering values; adjust only with recorded default-size/zoom evidence and update this document and shared constants together.

Keep default native main size 960×640. Target resizing to 800×600 without task loss and effective content widths around 400px under 200% zoom. Do not raise the native minimum window size to conceal a layout defect. Document any platform constraint discovered during verification.

Use one stable detail instance and draft owner across breakpoint changes. Prefer a stable shell host that changes positioning and reserved grid space; moving the same form between different React parents/portals may remount it and must be prevented. A dock-to-modal transition must set modal semantics, background inertness and focus containment; the reverse transition removes them without closing or saving merely because of resize.

At most one modal sheet is active. Opening details from the backlog sheet transfers focus ownership and closes the backlog sheet; returning restores a meaningful originating item/toolbar trigger. Navigation state, active dates and scroll positions survive temporary overlays.

## 3. W0 — Capture the implementation baseline

Responsibilities: design lead and frontend lead. Dependencies: none.

1. Record branch/commit, Windows/WebView2 version, language/theme, logical viewport, OS scale and fixture revision for every artifact. Use isolated test data.
2. Capture all core routes and window variants before implementation; include default-size Inbox with details open and Calendar with similar-prefix titles.
3. Write an inventory of typography, spacing, action labels, status colors, control sizes, modal behavior and keyboard rules actually implemented. Record deviations rather than silently treating them as a new standard.
4. Prepare draft context documentation under `apps/desktop/ui`: PRODUCT.md summarizes confirmed product truth; DESIGN.md summarizes incumbent visual rules and the target rules in this guide. Mark unverified audience/brand assumptions explicitly. A separate surface brief may record Operate mode for each surface; do not assign modes globally to the product.
5. Correct the historical search-height note with a dated amendment, preserving previous decisions. Search already uses `fitSearch`/`fit_search`; do not reimplement height fitting from scratch.

Exit: versioned baseline manifest, reproducible fixtures, documented incumbent conventions and a linked work backlog. Missing context files do not justify a visual rebrand.

## 4. W1 — Item detail and safe editor transitions

Responsibilities: frontend lead; design review for hierarchy; QA for failure/resize cases. Start after W0 establishes the baseline.

### 4.1 Detail hierarchy

Keep Close and save state visible in the header. Place destructive actions in a labeled More menu, separate from Close. Put the editable title first in the content flow; opening an existing item focuses the panel with the first forward Tab going to title. Newly created items may focus/select title, consistent with existing behavior.

For Todo: title → optional brief → scheduled date/time → due date/time → reminder → project → priority → description → tags → source → type conversion. For Tip: title/brief → schedule → reminder → project → description → tags → source → type conversion. For Note: title → schedule → project → description → tags → source → type conversion; the dedicated Notes editor remains the primary long-form experience. Backend rules remain authoritative about field applicability.

- Schedule and due are visibly distinct with concise localized helper copy: when the user plans to work versus when the item must be finished. Do not invent date relationships or auto-shift due dates.
- At 960×640 and100% zoom with a typical one-line title and no alert, scheduled and due controls for Todo must be available without first expanding description. At zoom/error states, allow vertical scrolling while preserving access.
- Empty description initially occupies a compact three-row editor. Existing content may show a short preview with an explicit Edit/Expand control; expanding must preserve caret, undo history and draft. Never collapse a field during active editing or validation failure.
- Show a concise source summary and an explicit Source section. Full URL/path wraps when expanded; use existing opening/rerun operations. Expanding source does not mutate the item.
- Group secondary organization fields with explicit expand/collapse controls where necessary. Use `aria-expanded`/`aria-controls`; remember expansion within the current editor session. Do not hide populated or invalid fields without an obvious summary.
- Keep type conversion in secondary actions because it changes applicable fields; reuse backend conversion behavior and its error reporting.

### 4.2 Save and leave contract

Retain 700ms idle autosave initially. Introduce an explicit outcome for save/flush: success, validation/error, or cancelled. A caller must not infer success merely because the current `save(): Promise<void>` resolves after catching an error.

| State/event | Required behavior |
| --- | --- |
| Dirty, debounce expires | Persist the actual changed fields through existing typed IPC. |
| Saving, user edits again | Preserve newer edits; serialize another save if needed. A response may acknowledge only the version sent. |
| Close, switch item/note, route navigation or external open request | Run a shared leave request; flush the latest draft before applying the transition. Keep the editor mounted until the outcome is known. |
| Already saving when leave is requested | Await the in-flight request and flush newer edits; do not return early as though all work were saved. |
| Save fails | Keep editor and draft, show localized reason and Retry. Offer Stay; Discard requires explicit confirmation and affects only that draft. |
| User chooses Retry | Apply the queued transition only after the latest dirty version is saved. Prevent duplicate transition execution. |
| More navigation requests arrive while blocked | Keep one pending destination using a documented latest-request-wins rule; Cancel clears it. Do not execute stale callbacks. |
| Successful close | Restore connected origin focus; if the row vanished, use next row or page heading. Do not override a deliberate focus move elsewhere. |
| Window hides | Preserve mounted draft and normal autosave. Hiding is not an instruction to discard. Native destruction/exit requires a separate verified lifecycle decision. |

Use this contract for both ItemDetailPanel and NoteEditor, since they share `useItemDraft`. Integrate with the existing workflow unsaved guard rather than overwriting its singleton `leaveGuard`. If simultaneous owners are possible, add scoped registrations with cleanup and deterministic precedence: active modal editor first, underlying view second. Keep the coordinator limited to navigation and pending UI drafts. Do not add a general routing framework.

Unmount flushing can remain a last-resort safeguard, but normal exits must use the explicit transition contract. Do not claim recovery across process crash or OS termination without a separate persistence design.

### 4.3 Acceptance

- Details do not reduce the default-size list to a narrow column; title and scheduling hierarchy matches §4.1.
- Resize during editing and while a save is pending causes no remount, lost input, duplicate update or stale success indicator.
- Inject failure during close, item switch, Notes switch, sidebar navigation and search-driven open. The draft remains recoverable and the intended transition occurs once after successful retry.
- Preserve Markdown shortcuts, input undo, project/tag behavior and backend type-conversion rules.

## 5. W2 — Calendar identification and scheduling

Responsibilities: frontend and design; QA verifies both pointer and keyboard paths. Depends on W1 detail/leave contracts.

### 5.1 Information presentation

- Keep the month/week switch, date navigation and labeled Unscheduled action visible. The action always includes the current count; a responsive default must not remove the route to the backlog.
- Scheduled chips show item identity and optional time; due overlays retain dashed treatment, flag and a readable Due label. Completed styling must not erase identity or depend only on color.
- Reuse the existing Tooltip for full title on hover and focus, wrapping long content. Keep the full accessible name. Native `title` alone is insufficient for keyboard discovery.
- Month view remains compact; preserve the existing three-item limit initially. Ensure visible chips plus a reachable “N more” action fit vertically. At short heights, reduce the visible count or allow the grid content to scroll vertically; never clip the only overflow action.
- Selecting “N more” opens the existing week view anchored to that day and announces the change. Provide the originating date's full item list there; do not introduce a second day-detail modal in this phase.
- Week view uses wrapping titles with enough space to distinguish similar prefixes; per-day scroll regions must have clear labels and reachable focus. Test eight and twenty items in one day, not only sparse fixtures.
- M2 rendered decision (2026-11-01): below 600px of calendar content width, week view stacks labeled days vertically with bounded, scrollable item regions. Seven narrow columns broke titles into single-character lines at 400px. Month view retains the three-chip maximum, reducing the visible count by measured cell height and reserving room for the overflow action. These values live with the shared layout constants and calendar cell sizing.
- Backlog docks only when the calendar content budget permits it. At narrower sizes, use the shared modal sheet and preserve the calendar date/scroll behind it.

### 5.2 Mutation behavior

Keep current semantics: moving a scheduled entry changes scheduled date and preserves time; dropping on the same day is a no-op; a due overlay is not draggable. Display the actual result only after success or a correctly rolled-back optimistic update. Show localized failures and retain the original item/date.

Provide an explicit “Schedule…”/“Change planned date…” path through item details for every scheduled or unscheduled item. Keyboard-only users must be able to open the item, change its date and return; successful keyboard drag is not the sole accessible path. Keep existing drag sensors where they work, but do not claim that adding `KeyboardSensor` alone establishes correct droppable navigation.

Announce item title and destination date after change. Preserve existing undo semantics and duration initially. Undo uses the original schedule including null/time and must report failure. Closing a toast does not remove the persistent ability to edit the date again.

Day inline-create must ignore Enter while IME composition is active, retain input on failure, prevent duplicate submission and clear only on confirmed success. Current `createTodo` returns immediately while IPC runs; change its caller/result handling as necessary. Explicit Escape cancels. If blur cancels an unsent draft, test and document that behavior rather than silently implying it was saved.

### 5.3 Acceptance

Use three titles with identical first 12 characters, mixed item kinds, due and scheduled representations of the same item, eight-plus items/day and long translated labels. Users can expose the full identity and select the intended item; date changes preserve time/due and never target a neighboring row. Pointer, keyboard date editing, month overflow and narrow backlog access all work at 960×640 and zoomed layouts.

## 6. W3 — Discoverability and readable guidance

Responsibilities: frontend and design/content. Reuse existing operations; dependencies are shared layout and modal rules.

### 6.1 Search and commands

- Keep SearchPanel shared by main palette and global window. Preserve recent items, grouping, selection, metadata, debounce, fast Enter, IME handling, create, copy, complete/reopen and undo.
- Add a visible labeled Commands mode control as an alternative to knowing `>`. Typing `>` retains its existing behavior. Mode changes preserve predictable focus and announce the active mode. Global search lists only commands actually supported there; do not promise all main-window commands.
- Footer always prioritizes result/action state and Undo over help. Normal browsing shows navigation/open guidance and one contextual action hint; a keyboard-help control exposes the complete shortcut list. Wrap rather than shrink below 12px. Avoid two status live regions announcing the same event.
- Clear action names distinguish Open, Create Todo and Complete/Reopen. Creating from main search opens details; creating from global search hides and returns to the previous app, as today.
- Resolve initial focus by reproducing both trigger click and Ctrl+K before changing code. On open, input accepts immediate typing. Escape restores a valid opener only when closing without transferring to another action target. Opening details transfers focus there; palette unmount cleanup must not steal it back to Search.
- Search content height remains measured in React and applied through existing Rust window fitting. Batch size updates to avoid repeated identical IPC calls; retain existing maximum440px and native working-area placement. Extra guidance must fit by wrapping/scrolling content, not by enlarging the native contract without review.

### 6.2 Inbox and capture

- Each Inbox row retains a visible labeled Organize/More route. On roomy rows, Today/Tomorrow may remain direct actions. On compact rows, keep one visible action menu and put all organization operations inside it; do not spend title width on multiple hidden button slots.
- Hover/focus may reveal additional shortcuts but cannot be the only way to discover organization. Bulk toolbar explains selected count and operates on the existing selection/filter rules.
- Floating capture visibly exposes Todo/Note/Tip selection. Replace the current input-level Tab/Shift+Tab type cycling with standard focus traversal. Implement a labeled single-selection type group: Tab reaches/leaves the group, arrow keys change its selection, and the next Tab reaches the title input. Pointer selection preserves title/caret and keeps the window open. Enter in the title submits; Escape cancels; neither arrow keys in title nor IME composition changes type. This deliberately changes the existing Tab shortcut to remove its focus trap; update model tests, help, onboarding and release notes in the same PR. Keep the initial focus on title for fast capture.
- Onboarding stays skippable and uses actual registered shortcut values. Include one short actionable example of capture followed by organization; returning users can reopen help without resetting their data.
- Capture failure keeps entered content available and explains retry. Clicking type/help controls inside the floating window must not be mistaken for native focus loss and discard input.

### 6.3 Settings, Workflows and adjacent surfaces

- Settings section links wrap at narrow widths instead of compressing into tiny labels. Keep a visible current section, semantic navigation and focused headings that are not hidden by a sticky toolbar. Prefer the existing page/section model over a new settings architecture.
- Group appearance choices by meaning: badge shape, surface/accent, opacity and motion. Show current value; any preview must not diverge from the actual saved selection.
- Workflow list gives name first, readable summary second and enabled state separately. Use two-line summaries or full-text focus/hover access instead of unnecessarily truncating into a large blank workspace. Keep scripts/import/dry-run and current unsaved safeguards intact.
- Apply the same typography, action menus, empty/loading/error copy and focus rules to Today, Notes, Projects and Trash. Do not change business behavior just to make screens superficially identical.
- Add all copy to matching `zh-CN.json`/`en.json` keys. Preserve real labels and user content; avoid claims about unimplemented capabilities.

## 7. W4 — Accessibility, feedback and recovery

Responsibilities: frontend and accessibility QA; verify on actual Windows/NVDA. This is part of every package, with a final integrated sweep.

| Interaction | Required contract |
| --- | --- |
| Docked details | Non-modal labeled region; ordinary page navigation remains usable. |
| Modal details/backlog/navigation/search | Named dialog, modal semantics, inert background, contained Tab sequence, Escape handling and meaningful focus return. Hidden controls are excluded from focus order. |
| Nested menu/tooltip | Escape first closes the active child surface; it must not also discard or close the parent editor. |
| Item deletion | Reuse soft delete and recovery. Restore to next logical row when origin disappears; permanent deletion retains explicit confirmation. |
| Completion/reopen | Clear state and status announcement; keyboard Enter intended to open does not accidentally complete. Preserve existing contextual key behavior. |
| Saving | Concise Saving/Saved state; error is persistent and actionable. Announce state changes without reading the full form after every keystroke. |
| Undo | Keep the existing 5s completion/search and6s deletion/calendar windows initially; announce availability. Verify persistent recovery after expiry through reopen/date editing/Trash. If timing extensions are needed, scope the change consistently rather than changing one toast arbitrarily. |
| Empty/filter/loading/error | Distinguish no data from no match and failed load. Provide appropriate Create, Clear filter or Retry action. Keep prior content visibly busy during replacement and avoid wrong-target mutations. |

Audit real computed colors, including opacity, accents and hover/selected/disabled states. Project contrast targets: 4.5:1 normal text, 3:1 large text and applicable control/focus boundaries. Passing token tests alone is insufficient. Validate 200% zoom, reduced motion, Chinese IME, long English labels and keyboard-only traversal; record NVDA version and the actual announcement.

Reuse existing modal/focus helpers where suitable. Extend them only with tested requirements such as hidden elements, empty dialogs and dynamic controls; do not maintain divergent focus traps per feature. Test resize across modal/non-modal boundaries and search→detail transitions specifically.

## 8. W5 — Native Windows behavior

Responsibilities: desktop integration developer and Windows QA. Run against an isolated release-build profile; browser mocks cannot pass these gates.

| Scenario | Required result |
| --- | --- |
| Global capture/search from another app | Correct window appears and input accepts text without an extra click; registered shortcut shown in help matches reality. |
| Escape | Search/capture cancels or closes according to its state and returns focus to the recorded previous app. |
| Click away | Transient window hides according to existing behavior and does not reclaim focus from the app the user selected. |
| Search result/command | Main window uncreated, hidden and visible variants all reach intended item/route; search hides and main owns focus. |
| Tray Search | Correct localized menu and registered shortcut; click opens searchable input directly. |
| Shortcut conflict/disabled/restore | Accurate status, one action's failure does not disable another, working registration and tray/help update together. |
| Mixed DPI and monitors | Test 100/150/200% scales, at least one mixed-scale pair, taskbar work areas, monitor movement and restored edge placement. Windows remain visible without size oscillation or focus loss. |
| Floating shapes | Native pill 64×32, number 36×36, dot 28×28, skin 88×40 and expanded panel have correct hit bounds, no unexpected invisible drag area or cropped shadow/content. |
| Capture sources | Actual Chrome, Edge, Firefox, VS Code, Word and Explorer examples; text/URL/image/file/folder/multiple-file cases preserve supported information or explain an unsupported format. |
| Search fitting | First open, empty/recent, few/many results, command mode and error/help changes fit without flicker loops; never exceed the existing size/working-area constraints. |

Reuse `tests/e2e/e2e.mjs --native` and [drop matrix](drop-matrix.md); record app/version per real source. Generic OLE fixtures do not certify every application's additional clipboard formats. Test AltGr-sensitive layouts where shortcut logic changes. Do not modify production data or register a lasting test shortcut.

Keep native geometry, foreground tracking and focus return in current Tauri/platform adapters. Frontend communicates intent and measured content size through typed IPC. If an IPC change becomes necessary, implement the use case and thin command, update command registration, generated bindings, the specific window capability and capability tests together. Do not grant search editing/deletion permissions merely to share a main-window control.

For a work area smaller than the nominal search window, clamp dimensions as well as origin in the native adapter. Convert that monitor's work area to logical units once. Target width is the lesser of 640px and available width minus 32px; target maximum height is the lesser of 440px and available height minus 32px. Apply the content-height request within that cap, with the existing 56px minimum only when the work area permits it. Re-evaluate after monitor/DPI changes and notify/layout the existing page normally; React must not guess physical scale. Record an explicit unsupported-work-area outcome when even the minimum input cannot fit. Add narrow-work-area tests and verify that repeated page measurement/native fitting converges without an oscillation loop. This is a required extension to verify against current code, not an assertion that existing placement already resizes the window.

## 9. Engineering change map

Paths beginning `src/` below are relative to `apps/desktop/ui/`. New modules named here are proposed; inspect existing exports and dependencies before creating them.

| Package | Primary existing targets | Planned changes / focused tests |
| --- | --- | --- |
| W0 | `src/styles/tokens.css`, `src/styles/global.css`, context docs | Shared layout/type rules, inventory; preserve contrast tests |
| W1 | `src/features/shell/MainShell.tsx`, `nav-store.ts`, `src/features/detail/ItemDetailPanel.tsx`, `use-item-draft.ts`, `SourceSection.tsx`, `src/features/notes/NoteEditor.tsx` | Stable responsive detail host; reorder fields; explicit flush outcome and guarded transitions; detail/notes/shell regression cases |
| W2 | `src/features/calendar/CalendarPage.tsx`, `CalendarChip.tsx`, calendar model | Sheet backlog, full-title access, overflow, async inline create; calendar page/drop/model tests |
| W3 | `src/features/search/SearchPanel.tsx`, `SearchApp.tsx`, `src/features/search/CommandPalette.tsx`, `src/features/inbox/InboxRow.tsx`, `src/features/floating/TodayPanel.tsx`, `src/features/quick-create/QuickCreateForm.tsx` | Guidance/mode controls, visible action routes, reachable capture type controls; existing search/inbox/floating/quick-create tests |
| W3 | `src/features/settings/SettingsPage.tsx`, `SkinSetting.tsx`, `src/features/workflows/WorkflowsPage.tsx`, `WorkflowEditor.tsx`, `src/features/onboarding/OnboardingDialog.tsx` | Readable navigation, summaries, contextual help; settings/workflow/onboarding tests |
| W4 | `src/components/`, `src/lib/focus-trap.ts`, `src/stores/toast-store.ts`, `src/features/trash/useDeleteItems.ts` | Shared dialog/focus and recovery behavior only where needed; focus/toast/trash tests |
| W5 | `apps/desktop/src-tauri/src/windows/`, existing platform adapters and capabilities | Fix reproduced native defects; Windows/native and capability tests |
| W6 | `scripts/visual/visual.mjs`, `tests/visual/`, `tests/e2e/`, `src/test/ipc-mock.ts`, `src/test/workflow-mock.ts`, `src/i18n/` | Deterministic scenario fixtures, failure modes, expanded checks, localized copy and current documentation |

Prefer extracting small shared presentation or transition helpers when multiple surfaces need identical behavior. Avoid creating a second source of item state or duplicating mutation logic across calendar, details and search. Keep backend validation authoritative.

## 10. W6 — Verification and evidence

### 10.1 Fixture contract

Create deterministic empty, typical and dense fixtures; pin the clock for date-dependent scenes, locale/theme, ordering and item IDs. Include: long Chinese/English titles; identical prefixes; emoji; long paths/URLs; many tags; due-only, scheduled-only and both; completed/overdue; three source types; failed update; slow/out-of-order queries; 1000 items/notes for interaction responsiveness. Do not reuse live user data or change screenshots merely because the wall clock advanced.

### 10.2 Meaningful automated tests

- W1: edit while save in flight, pending close, failure/retry/discard, route and item changes, double navigation, stable draft during responsive transitions, source error and correct focus destination.
- W2: full identity from keyboard, backlog at default size, overflow route, intended item/date/time mutation, same-day no-op, due overlay non-draggable, failed/IME inline create, undo failure.
- W3/W4: palette click and shortcut initial focus, immediate typing, Tab/Shift+Tab containment, Escape priority, search→detail focus, empty/error/create/undo priorities, command mode parity, capture-type keyboard exit and visible action alternatives.
- Keep existing IME, bulk selection/filter, Markdown, backend conversion and workflow unsaved checks. Add tests for observable behavior and actual failure cases, not snapshots of component implementation.

### 10.3 Visual regression matrix

Maintain existing scenarios; add named scenes for Inbox/details960×640 in light/dark, Today960×640, dense Calendar960×640, week view/overflow, backlog sheet, Search 640×440 and fewer-result fitted heights, main palette, Settings, Workflows, Notes and Projects. Pair core pages with long-title and relevant empty/error variants. Add a below 800px effective-width scene and a breakpoint transition check.

Use a representative pairwise matrix rather than every possible combination. All changed core surfaces need both themes and both languages represented across the reviewed set. OS-scale/multi-monitor/floating hit-bound verification remains native/manual; a screenshot at deviceScaleFactor 1 is not that evidence.

For each scene record viewport, locale, theme, fixture revision, clock and motion setting. Freeze animations for stable comparisons, then separately verify actual motion/reduced motion. Inspect every changed baseline and diff; never bulk-accept visual updates to turn a failing run green.

### 10.4 Commands and gate selection

Run from repository root. Use the current lockfile and installed toolchain; do not upgrade dependencies as part of this work.

```powershell
# Targeted behavior tests during a work package
pnpm --filter @stardeskbox/desktop-ui exec vitest run src/features/detail/item-detail-panel.test.tsx src/features/calendar/calendar-page.test.tsx src/features/calendar/calendar-drop.test.tsx

# Completed frontend changes
pnpm run check:ui
pnpm build:ui

# Reviewed browser visual regression (Chrome required)
pnpm visual

# Document-only changes and all work-package documentation
node scripts/check-doc-links/check-doc-links.mjs

# Native changes / final integrated Windows candidate
pnpm tauri build --no-bundle
node tests/e2e/e2e.mjs --native --runs 3

# When backend/platform/capability code changes
pnpm run check:rust
```

Select relevant targeted tests first, then complete required package/integrated checks once changes stabilize. Run the existing Impeccable source detector over changed UI targets after the final UI edit; classify results with context. The prior toast-border and optional-skin findings are not automatic removal requests. Browser and native evidence remain necessary even with clean source scans. If IPC changes, run `pnpm gen:bindings` and verify generated binding/capability changes.

Documentation work alone requires link/path review, not a new native build or a full application test run. This guide's creation does not constitute implementing or passing any of the gates above.

### 10.5 Formative task evaluation

Run 5–8 participants spanning first-time and practiced desktop users; include keyboard/low-vision experience where possible. Use the same task scripts before and after, fixed fixture complexity and clear timing start/end points. Separate first-use discovery from practiced speed.

| Task | Proposed practiced target | Critical correctness |
| --- | --- | --- |
| Capture provided text | 15s | Exactly one intended item; return to original work |
| Assign Inbox item to project/date | 30s | Correct item/project/date; distinguish scheduled and due |
| Identify and move calendar item | 30s | Correct identity/date; preserve time and due |
| Find/open known item with search | 15s | Correct result; immediate typing and correct focus transfer |
| Recover completion/deletion/date change | Record baseline, then improve | Recovery remains possible after toast expiry |
| Leave failed-save editor, then retry | Record baseline, then improve | No silent draft loss; exactly one final transition |

Record task success as exact fractions, time, actions, wrong targets, assistance, backtracking and ease 1–7. Target aggregate success at least 90% unassisted and median ease at least 6/7, with each task reported separately. These small-sample thresholds are directional release goals, not statistical proof. A severe failure cannot be hidden by an aggregate score.

Search performance: preserve the existing repeated-open budget below 150ms on documented release-test hardware; collect at least 20 warm activations and report median/p95 plus cold activation separately. Include input focus in the endpoint. Do not compare a browser-only timer with historical native invocation measurements. Record typing responsiveness under dense fixtures; regressions require explanation and measurement before acceptance.

## 11. Delivery sequence, estimates and ownership

All work packages are in scope. Sequence establishes dependencies; it does not defer accessibility/native work until cosmetic polish is done. Every frontend PR includes relevant keyboard and localized-state checks.

| Milestone | Contents | Dependency / exit | Estimate |
| --- | --- | --- | --- |
| M0 | W0 baseline, fixtures, documentation and issue mapping | Reproducible baseline and agreed contracts | 1–2 person-days |
| M1 | W1 safe draft transitions and responsive details | Failure/resize tests and default-size task pass | 3–5 person-days |
| M2 | W2 calendar identity/backlog/creation recovery | M1; correct pointer and keyboard scheduling | 2–4 person-days |
| M3 | W3 guidance/discovery and remaining surfaces | Shared modal rules; feature tests and translations | 3–5 person-days |
| M4 | W4 integrated accessibility + W5 native remediation | M1–M3; hardware and NVDA records | 2–4 person-days |
| M5 | W6 regression completion, participant retest, release evidence | All packages; no unresolved release blockers | 2–3 person-days |

Initial total: 13–23 person-days, excluding participant recruitment delays and newly discovered backend defects. Re-estimate after M0. Assign named owners and target dates in the issue tracker; these role assignments and effort ranges are not staffing commitments. Cross-surface changes require one design reviewer to prevent each package inventing its own spacing, labels or modal behavior.

Suggested reviewable PR boundaries: baseline/docs/fixtures; draft lifecycle with tests; responsive detail hierarchy; calendar; search/focus/guidance; Inbox/floating/onboarding; Settings/Workflows/adjacent consistency; reproduced native fixes; final visual/native evidence. Keep each PR usable and provide before/after captures, behavior tests and remaining verification limits. Do not combine domain/schema changes with visual cleanup.

## 12. Release, rollback and completion

Release blockers: any lost draft, wrong-item destructive operation, inaccessible core keyboard path, broken native focus handoff, obscured critical control, or unsupported claim that an unrun check passed. Remaining P1 task friction requires resolution or an explicit documented release decision; P2/P3 work remains in this scope and is not silently dropped.

Every issue record contains: requirement ID, environment, route/state, reproduction, evidence, impact, proposed fix, owner, tests, acceptance result and remaining limits. Keep observed, automated-passed, manually-passed and not-run statuses distinct.

Use ordinary reversible commits for presentation changes; avoid permanent flags that duplicate both old/new UI. A rollback must include corresponding helper, translation and baseline changes. Verify data written by normal editing remains readable; this plan requires no migration. Keep any later necessary migration backward-compatibility decision separate.

Completion checklist:

- [ ] UX-01 through UX-09 have linked acceptance evidence and named reviewers.
- [ ] All five findings have implemented remedies and retest results.
- [ ] Default 960×640, larger, below 800px effective width, light/dark and Chinese/English are reviewed.
- [ ] Draft failure, search focus, calendar overflow and keyboard alternatives are verified.
- [ ] NVDA, 200% zoom, reduced motion and rendered contrast records are attached.
- [ ] Windows release E2E, tray/command handoff, native badges and mixed-DPI matrix are complete or explicitly blocked with a release decision.
- [ ] Real-app capture outcomes update the drop matrix accurately.
- [ ] Required build/test checks pass; changed visual baselines were individually reviewed.
- [ ] Participant task results and performance measurements are compared to baseline.
- [ ] PRODUCT.md/DESIGN.md, interaction history and [evaluation plan](ui-ux-evaluation-plan.md) link to shipped behavior; release notes describe actual user-facing changes.
- [ ] Review processes/tabs/servers and temporary profiles are cleaned up; no production data was used.

Final handoff package: source PRs, requirements-to-evidence table, reviewed screenshots/diffs, automated test logs, native/accessibility matrix, task scorecard, performance results, known limitations and rollback instructions.

Implementation follow-up (2026-11-02): [stage ledger](ui-ux-progress.md), [requirements handoff](ui-ux-acceptance-handoff.md) and [task scorecard](ui-ux-task-scorecard.md) record stage commits and actual evidence. The user instructed proceeding with available checks and documenting gaps; unchecked human/hardware release criteria above remain unrun, rather than being silently marked passed.
