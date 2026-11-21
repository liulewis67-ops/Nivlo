/**
 * 命令面板里「前往：…」可以直接打开的视图，按侧栏顺序。主窗口的 Ctrl+K 与全局搜索框共用；
 * 后端 `open_main_at` 接受的视图与它一致。
 */
export const GOTO_VIEWS = [
  "inbox",
  "today",
  "calendar",
  "notes",
  "projects",
  "workflows",
  "trash",
  "settings",
] as const;

/** [`GOTO_VIEWS`] 里的一个视图。 */
export type GotoView = (typeof GOTO_VIEWS)[number];
