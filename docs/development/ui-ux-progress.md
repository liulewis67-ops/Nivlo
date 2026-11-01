# UI/UX implementation stages and evidence

Started: 2026-11-01. Scope: [implementation guide](ui-ux-implementation-guide.md), all W0–W6 packages; [initial evaluation](ui-ux-evaluation-plan.md) remains historical evidence. Each completed milestone receives a separate commit. Implementation owner: Codex. Human design/accessibility/native reviewers and participant recruitment are unassigned; no approval or participant result is inferred.

## M0 / W0 — baseline

Source: commit `14a17eca874d2d920f86515a97c8adb716245459`, branch `main`. The two input guides, development README and `.impeccable/critique` were already local changes when work began. Input guides are included in the baseline commit as the authorized specification; existing README/critique edits are preserved.

Reproduce browser captures with `node scripts/visual/visual.mjs --implementation-baseline`. Output is separate from regression goldens: [manifest](../../tests/visual/implementation-baseline/manifest.json). Every artifact records viewport, locale, theme, device pixel ratio, browser user agent, clock and SHA-256. Fixture revision `w0-v1` uses existing demo data plus twenty same-prefix calendar items, mixed Todo/Note/Tip, scheduled time and due overlays. Browser Date is pinned to 2026-10-13 noon Asia/Shanghai and UUIDs are sequential. Every scene clears browser preferences and uses an isolated temporary Chrome profile. No production data is accessed.

Capture coverage: 18 reviewed scenes covering all eight main routes at default 960×640, Inbox Note/Todo details, dense Calendar, existing 1100×720 views, floating collapsed/expanded browser representations, global Search at 640×440, light and representative dark state. Source conventions and known deviations are recorded in the draft [PRODUCT](../../apps/desktop/ui/PRODUCT.md) and [DESIGN](../../apps/desktop/ui/DESIGN.md) context. These are implementation drafts, pending human confirmation, as required by W0.

Environment: Windows build 26300 (host reports Windows 10 Home China / version 2009); browser version is in the manifest. Native WebView2 version, OS display scale, native compact window rendering and participant task recordings are not measured by this browser baseline. These remain explicit M4/M5 acceptance work, not a reason to claim native success. Reduced motion is requested and screenshot animation is frozen; live motion is not certified.

Behavior inventory: main navigation uses visible labeled buttons; Ctrl+K opens search; command mode requires `>`; details focus their container and first Tab reaches title; autosave waits 700ms, catches failure without a caller outcome and starts a last-resort save on unmount. Calendar has three visible month chips then overflow; due overlays are separate and non-draggable. Search already fits content using `fitSearch` / native `fit_search`. Source-level facts require rendered and runtime retesting in their owning stages. The existing mock's Today date is explicitly 2026-10-10; the browser clock is 2026-10-13, so the Today heading and calendar today marker intentionally follow that backend fixture date.

Visual review found the default-size Todo's schedule/due controls below the initial viewport, Inbox list compression with details open, and dense-calendar overflow overlapping the following row. These observations substantiate the M1/M2 work; they are not corrected in M0.

## Implementation backlog and acceptance ownership

| Milestone | Requirements | Implementation / evidence | State |
| --- | --- | --- | --- |
| M0: W0 | UX-05/09 | Baseline manifest, draft context, dated history amendment, this issue ledger | Complete; human/native acceptance remains in owning later stages |
| M1: W1 | UX-01/02/06 | Serialized flush outcome; scoped leave requests for item/note/route/external open; retry/stay/confirmed discard; stable responsive editor host and hierarchy | Pending |
| M2: W2 | UX-02/03 | Full identity, default-size backlog sheet, overflow, safe async/IME creation, scheduling announcements and rollback | Pending M1 |
| M3: W3 | UX-04/05 | Visible commands/actions, contextual readable guidance; Inbox/floating/onboarding/settings/workflows/adjacent pages; paired translations | Pending shared modal rules |
| M4: W4/W5 | UX-06/07/08 | Integrated focus/announcements/recovery; release Windows E2E, NVDA, mixed DPI, real source apps, search work-area sizing | Pending M1–M3; device/manual evidence needed |
| M5: W6 | UX-01–09 | Reviewed visual matrix, automated gates, participant scorecard, release performance and docs | Pending all implementation stages |

Issue records below use the guide's route/environment/reproduction/impact/fix/retest contract. They are preliminary findings, not reproduced data-loss claims.

| Issue / priority | Route/state and reproduction | Evidence / user impact | Remedy / owner | Retest |
| --- | --- | --- | --- | --- |
| UX-01/02, P1 | Default 960×640 Inbox, open a title | Baseline detail capture; fixed grid reduces list width | Stable modal/docked host; Codex M1 | Resize and pending-save input/focus survive; title/schedule accessible |
| UX-06, P0 investigation | Dirty item/note; fail update and request close/switch/route/external open | `useItemDraft` catches errors and returns void; recovery across unmount unverified | Explicit serialized flush and scoped transition coordination; Codex M1 | Inject each failure; retry latest edits; transition once; confirmed discard only |
| UX-03, P1 | Dense Calendar; identify same-prefix title, overflow and change date | Dense fixture; truncation/native title does not establish keyboard identity | Shared tooltip, wrapping week, backlog sheet, async creation; Codex M2 | Correct item/date, time/due preserved; IME/failure/undo cases |
| UX-04/05, P2 | Search, Inbox, floating, settings, workflows; discover common actions | Existing hidden actions and 10/11px guidance in source | Visible routes and readable contextual copy; Codex M3 | Uncoached task sessions and paired locale/theme renders |
| UX-07/08, P1 investigation | Palette click and Windows global invocation/handoff | Initial evaluation reports browser focus uncertainty; native unverified | Reproduce then fix; Codex M4 | Immediate typing, focus containment/return, NVDA and release native/device matrix |

## Verification log

- Passed: `node scripts/visual/visual.mjs --implementation-baseline` (18 scenes); all images visually reviewed.
- Passed: repeated capture pixel comparison against a temporary copy of all 18 images, zero differing pixels at the existing pixelmatch threshold 0.1. Encoded PNG hashes are provenance, not a cross-run rendering acceptance criterion.
- Passed: `node --check scripts/visual/visual.mjs`, `node scripts/check-doc-links/check-doc-links.mjs` and `git diff --check`.
- No production UI/backend files changed in M0; full UI/Rust/native gates are reserved for their relevant implementation milestones.
- Historical automated passes cited in the input documents are not results of this implementation.
- Final publication of context, named review sign-offs, participant data and native hardware matrix remain open.
