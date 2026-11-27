# StarAt product context — implementation draft

Status: extracted from the existing product specification and implementation on 2026-11-01; pending human confirmation before publication as final product guidance. No new audience or brand claims are introduced.

StarAt is a local-first desktop capture and action-management tool. Its confirmed workflow is capture → organize → schedule → execute. Todo, Note and Tip share source-aware items; Inbox collects material, Today supports execution and Calendar supports planning. Notes provides long-form editing. Projects/tags organize items; Workflows automate capture processing.

Main, floating capture and global search are coordinated Windows desktop surfaces. Keyboard shortcuts, drag/drop and visible controls complement each other. Persisted business state and domain validation belong behind typed IPC; temporary editor drafts belong in the UI. Native window geometry and foreground ownership belong in platform adapters.

Preserve existing product semantics, source information, Markdown behavior, undo and soft-delete recovery. This initiative requires no schema migration, new item category, synchronization service or component library.

Audience segments, brand personality beyond the existing product specification, and measured participant outcomes remain unverified. Do not infer them from demo data.

Authority: [product specification](../../../docs/architecture/StarAt_Product_Design.md), [implementation contract](../../../docs/development/ui-ux-implementation-guide.md), [stage ledger](../../../docs/development/ui-ux-progress.md).
