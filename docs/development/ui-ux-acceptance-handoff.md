# UI/UX implementation acceptance handoff

Candidate date: 2026-11-02. Implementation owner: Codex. Status: **implementation/evidence delivered; not release approved**. Human design/accessibility/native reviewers are unassigned. The user authorized available checks with documented gaps. [Implementation ledger](ui-ux-progress.md) records stage commits and failures; [task scorecard](ui-ux-task-scorecard.md) contains the unrun participant protocol.

| Requirement | Implementation and authoritative evidence | Remaining acceptance |
| --- | --- | --- |
| UX-01 — identify and schedule at default size | M1 task-first details, both date controls visible at 960×640; [M1 manifest](../../tests/visual/stages/m1/manifest.json), detail behavior tests | Uncoached task timing/success |
| UX-02 — retain editor through layout changes | Stable editor host, serialized draft transitions; M1 pending-save resize recording and tests; M4 real WebView2 200% node/title/selection/focus checks | Mixed-DPI movement and human low-vision task review |
| UX-03 — correct calendar identity/date | M2 full-title tooltip, overflow/backlog, keyboard date editing, failed-create recovery and Undo; [M2 manifest](../../tests/visual/stages/m2/manifest.json), calendar/drop tests | Similar-prefix participant tasks |
| UX-04 — visible actions and efficient shortcuts | M3 Commands/Open/Create/Complete/Undo, Inbox Organize, capture type radio traversal; [M3 manifest](../../tests/visual/stages/m3/manifest.json), discovery/shortcut tests | First-use discovery and actual tray menu/conflict review |
| UX-05 — readable localized guidance | Paired Chinese/light and English/dark scenes; M4 composited flat-text audit, compact search recovery and source detector | Painted glass/background and non-text focus contrast; NVDA |
| UX-06 — recover failed saves | M1 in-flight edit/close/navigation/retry/discard tests; M3 persistent search/capture errors and Undo; M4 child Escape/modal ownership | Human recovery task after toast expiry |
| UX-07 — actual focus/announcements | Modal inertness/containment/return, child Escape, selected search row visibility, native search/capture focus tests | NVDA version/actual speech, native IME candidate session |
| UX-08 — Windows native behavior | Work-area/DPI conversion tests; release E2E logs, isolated WebView2/data profiles, native zoom/badge screenshots and cold/warm timing | Physical mixed-DPI pair, source-app-specific capture, badge per-pixel hit regions, tray/conflict checks |
| UX-09 — current rules and regression records | Draft PRODUCT/DESIGN, paired release notes/history, [44 current-candidate scenes](../../tests/visual/stages/m5/manifest.json), [44+6 visual reviews](../../tests/visual/stages/m5/visual-review.json), participant protocol and per-stage commits/logs | Named human design sign-off; manual release matrix |

The five original findings map to: adaptive task-first details (M1); identifiable dense calendar/backlog (M2); readable search/Settings/Workflows hierarchy (M3/M4); visible organization/commands/capture choices (M3); documented conventions and expanded fixture coverage (M0–M5). These are implementation remedies; the original provisional heuristic score is not recalculated without the requested evaluation.

Final checks and commands:

- `pnpm run check:ui`: format/types/lint and 692 tests across 68 files.
- `pnpm build:ui`, `pnpm tauri build --no-bundle`: production frontend and isolated Windows candidate.
- `pnpm run check:rust`: M4's unchanged native implementation passed format/clippy, 709 tests (six pre-existing ignored), architecture and link checks. M5 changes no Rust or dependencies.
- `pnpm visual`: six individually reviewed goldens, 0.000% pixel differences.
- `node scripts/visual/visual.mjs --release-stage`: 44 current-candidate scenes, including 1000 Notes and 1000 Todos with ten filtering/typing trials each.
- `node tests/e2e/e2e.mjs --native --runs 3 --warm-runs 20 --zoom --badge-matrix --evidence-stage m5`: final native suite, current source/executable hashes, focus-inclusive warm/cold metrics, main/search content zoom and four badge shapes.
- `node scripts/visual/verify-release-evidence.mjs`: binds all current scene/golden/review hashes, native screenshots, source/executable/harness identities and recorded acceptance assertions.

Actual command exits/logs are linked by the stage ledger; this list alone proves no pass. The Vite >500kB chunk advisory remains; it has no measured native invocation budget failure. Browser dense timings include debounce/CDP/polling and are not substituted for native or participant measurements.

Release decision remains open for the manual rows in [M4 acceptance scope](../../tests/visual/stages/m4/acceptance.md). No participant success/ease score, NVDA pass, mixed-monitor pass or app-specific drop result is inferred from automation. PRODUCT/DESIGN remain implementation drafts until human confirmation.

Rollback uses the ordinary stage commits with their helpers/translations/tests/evidence. No item-schema migration is required. Keep normal editing data readable; preserve the original SQLite profile. Earlier native test runs accidentally shared WebView2 UI cache, documented in M4; final evidence must use the corrected temporary browser profile. Two scratch profiles remain after cleanup approval rejections, with exact paths in the ledger.
