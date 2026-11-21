# M4 integrated acceptance scope

Date: 2026-11-02. Owner: Codex. These records describe the available environment, not a release approval. The user requested proceeding with available checks and documenting gaps.

| Check | Evidence and status | Limit |
| --- | --- | --- |
| Modal ownership, usable Tab targets, focus return | Frontend tests cover onboarding/background inertness, one owning modal, disconnected/hidden targets and heading fallback | Browser DOM tests do not establish screen-reader announcements |
| Nested Escape | Tooltip reproduction failed before the fix; regression now passes | Other existing child-menu tests remain in the full suite |
| Rendered text contrast | Per-scene accessibility JSON records composited foreground/background and thresholds | Flat backgrounds only; gradient/backdrop samples are explicitly unmeasured |
| Search work-area geometry | Eight Rust tests include 100/125/150/200% scales, negative monitor origin, short/narrow work areas, stable anchor, unsupported areas and content-zoom conversion | Pure geometry coverage does not replace moving a real window between monitors |
| Windows release integration | Native E2E logs and measurements are recorded separately | Final rerun isolates both database and WebView2 profile; earlier harness runs did not isolate the browser cache |
| Mixed-DPI pair | Not run: this machine reports one 1920×1080 monitor at 125% | Requires physical 100/150/200% display transitions, work-area changes and fitting-loop observation |
| NVDA | Not run: no reviewer/session available; usual installation paths not found | Browser AX snapshots are not NVDA speech/focus evidence |
| Source-app capture | Existing generic Win32 clipboard/OLE harness only | Chrome, Edge, Word and Explorer each require an actual source-app result; no app-specific pass inferred |
| Tray menu and registration conflict | Hotkey disable/rebind and hidden/uncreated-main handoff are automated | Actual tray Search/menu clicks and conflict with another registered application are not manually exercised |
| Windows IME | Composition/duplicate-submit logic remains covered in the frontend suite | CDP text insertion is not a native IME candidate-window session |
| Live reduced motion | Existing CSS/settings and automated behavior only; screenshots freeze animation | Live motion and Windows preference review remain unrun |
| Gradient/glass contrast and focus indicators | Unmeasured samples retained in audit output | Requires painted-background/non-text contrast review; zero flat-text failures is not blanket WCAG certification |
| Native badge transparency | Client/button bounds can be measured | Per-pixel OS click-through and edge hit regions need manual review |
| Participant tasks | Not run: 5–8 participants unavailable | No task-success, timing or ease scores invented |

Unrun rows remain release acceptance gaps. The user's instruction permits implementation/evidence submission with these gaps; it does not supply a human design sign-off or approve release.

Harness isolation correction: `NIVLO_DATA_DIR` isolated database/log fixtures, but did not isolate WebView2 local storage. A skin fixture leaked between runs and caused the combined badge test to see 88×40 instead of 64×32. The harness now sets `WEBVIEW2_USER_DATA_FOLDER` only in the spawned test process environment, asserts the scratch profile exists and has no inherited skin, and cleans up after child exit. This override is documented in [Microsoft's environment creation reference](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.3967.48). The isolated zoom/badge sequence passes. Earlier shared browser cache preferences may have been changed; that profile was not deleted or reset because its prior values are unknown. No production database writes are inferred from this cache defect.
