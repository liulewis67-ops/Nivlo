# UI/UX implementation release notes

Date: 2026-11-02. Implementation notes for the next candidate, not a published release. Native/accessibility/participant release gates remain in the [stage ledger](ui-ux-progress.md).

## English

- Search has a visible Commands mode, Open/Create Todo and Complete/Reopen actions, and expandable keyboard help. Typing `>` and existing shortcuts still work. Undo takes priority over help; errors retain your query and keep recovery controls available.
- Every Inbox row has an Organize action, including Today and Tomorrow, without requiring hover.
- Floating capture shows Todo, Note and Tip choices. **Tab now moves focus instead of changing capture type.** Use arrow keys inside the type group, then Tab to reach the title. Capture still starts in the title; clicking a type keeps your draft and selection. Failed creation leaves the text and a visible retry route.
- Settings links wrap and focus the selected section. Appearance choices are grouped by badge, surface/accent/opacity, skin and motion.
- Workflow summaries use available width and expose full text on focus/hover. Narrow Notes, Projects and Workflow workspaces stack their panes; resizing keeps the active Note editor and draft.
- Getting started includes a copy → paste → Inbox → Organize example and displays global shortcuts only when registered. It remains skippable and can be reopened from Settings.

## 简体中文

- 搜索新增可见的「命令」、打开、创建待办、完成 / 重新打开和键盘帮助入口。仍可输入 `>` 或使用原有快捷键。撤销优先显示；错误时保留搜索词和恢复操作。
- 收集箱每行始终显示「整理」，可安排到今天或明天，无需先悬停。
- 悬浮捕获显示待办、笔记、提示选项。**Tab 改为移动焦点，不再切换类型。** 在类型组内用方向键选择，再按 Tab 到标题。开始捕获时仍直接聚焦标题；点击类型保留草稿和选区。创建失败后保留文字并显示重试入口。
- 设置分组链接自动换行，跳转后聚焦分组标题。外观按徽标、表面 / 强调色 / 透明度、皮肤和动画分组。
- 自动化说明使用可用空间，并可通过聚焦或悬停查看全文。窄窗口中的笔记、项目和自动化面板上下排列；调整大小不丢失正在编辑的笔记草稿。
- 新手引导包含复制 → 粘贴 → 收集箱 → 整理的完整例子，只介绍已注册的全局快捷键。仍可跳过，并可在设置中重新查看。
