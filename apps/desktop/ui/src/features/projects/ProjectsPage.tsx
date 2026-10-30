import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Menu } from "@/components";
import type { MenuItemSpec } from "@/components";
import { useProjectsQuery, useTagsQuery } from "@/features/organize";
import { moveFocusWithArrows } from "@/lib/arrow-focus";
import { isCommandKey, isDialogOpen } from "@/lib/typing";
import { cx } from "@/lib/cx";
import { ipc } from "@/lib/ipc";
import type { ProjectDto, TagSummaryDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";
import { ProjectItemRow } from "./ProjectItemRow";

/** 归档后「撤销」提示停留的时间（毫秒）。 */
const ARCHIVE_UNDO_MS = 6000;

/** 当前选中的项目或标签。 */
type Selection = { kind: "project" | "tag"; id: string };

/** 正在被编辑名称的项目或标签。 */
type Renaming = { kind: "project" | "tag"; id: string; name: string };

/** [`SidebarRow`] 的 Props。 */
type SidebarRowProps = {
  /** 展示名称。 */
  name: string;
  /** 右侧的数量文案；缺省不显示。 */
  count: string | null;
  /** 数量的无障碍描述。 */
  countLabel: string;
  /** 是否被选中。 */
  selected: boolean;
  /** 点击选中。 */
  onSelect: () => void;
  /** 更多操作菜单项。 */
  menu: MenuItemSpec[];
  /** 更多操作按钮的无障碍名称。 */
  menuLabel: string;
};

/**
 * 侧栏里的一行：名称 + 数量，悬停（或键盘聚焦）时出现「…」菜单。
 *
 * @param props 名称、数量、选中状态与菜单。
 * @returns 列表项。
 */
function SidebarRow({
  name,
  count,
  countLabel,
  selected,
  onSelect,
  menu,
  menuLabel,
}: SidebarRowProps) {
  return (
    <li
      className={cx(
        "group flex items-center rounded-md",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        selected ? "bg-primary/10" : "hover:bg-surface-hover",
      )}
    >
      <button
        type="button"
        data-sidebar-item=""
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className={cx("truncate text-sm text-text", selected && "font-medium")}>{name}</span>
        {count !== null && (
          <span aria-label={countLabel} className="shrink-0 text-xs text-muted tabular-nums">
            {count}
          </span>
        )}
      </button>
      <Menu
        trigger={
          <Button
            size="sm"
            variant="ghost"
            aria-label={menuLabel}
            className="mr-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            {"…"}
          </Button>
        }
        items={menu}
      />
    </li>
  );
}

/** [`NameEditor`] 的 Props。 */
type NameEditorProps = {
  /** 无障碍名称。 */
  label: string;
  /** 初始值。 */
  initial: string;
  /** 占位提示。 */
  placeholder?: string;
  /** 提交（回车）。 */
  onSubmit: (name: string) => void;
  /** 取消（Esc / 失焦且没有改动）。 */
  onCancel: () => void;
};

/**
 * 行内的名称输入：回车提交，Esc 取消；失焦时按取消处理（不悄悄保存半截输入）。
 *
 * @param props 初始值与回调。
 * @returns 输入框。
 */
function NameEditor({ label, initial, placeholder, onSubmit, onCancel }: NameEditorProps) {
  const [text, setText] = useState(initial);

  /**
   * 回车提交、Esc 取消。
   *
   * @param event 键盘事件。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit(text);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <li className="px-1 py-1">
      <Input
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        maxLength={100}
      />
    </li>
  );
}

/**
 * 项目与标签视图（实施计划 3.3）：左边是项目与标签，右边是选中项里的条目。
 *
 * * 项目：新建（回车）、重命名、归档（带撤销）；视图按「未完成 → 优先级 → 计划日期」排序（D-05）；
 * * 标签：按标签过滤、重命名（重名会提示）、合并到另一个标签；
 * * 点击条目标题在右侧打开详情，在详情里修改项目与标签，列表随之更新。
 *
 * @returns 项目与标签页面。
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectsQuery = useProjectsQuery();
  const tagsQuery = useTagsQuery();
  const projects = projectsQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const [picked, setPicked] = useState<Selection | null>(null);
  const [creating, setCreating] = useState(false);

  // Ctrl+N（macOS ⌘N）新建项目，与「今天」「笔记」一致；有对话框打开时不响应。
  useEffect(() => {
    /**
     * 「新建」快捷键。
     *
     * @param event 键盘事件。
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (!isCommandKey(event, "n") || isDialogOpen()) return;
      event.preventDefault();
      setCreating(true);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [merging, setMerging] = useState<{ from: TagSummaryDto; into: string } | null>(null);

  // 选中的项目 / 标签不在了（被归档、被合并）时回落到第一个项目，再回落到第一个标签。
  const selection: Selection | null =
    picked !== null &&
    (picked.kind === "project"
      ? projects.some((project) => project.id === picked.id)
      : tags.some((summary) => summary.tag.id === picked.id))
      ? picked
      : projects[0] !== undefined
        ? { kind: "project", id: projects[0].id }
        : tags[0] !== undefined
          ? { kind: "tag", id: tags[0].tag.id }
          : null;
  const selectedProject =
    selection?.kind === "project"
      ? projects.find((project) => project.id === selection.id)
      : undefined;
  const selectedTag =
    selection?.kind === "tag" ? tags.find((summary) => summary.tag.id === selection.id) : undefined;

  const itemsQuery = useQuery({
    queryKey:
      selection?.kind === "tag"
        ? queryKeys.tagItems(selection.id)
        : queryKeys.projectItems(selection?.id ?? ""),
    queryFn: () =>
      ipc.listItems({
        itemType: null,
        includeArchived: false,
        projectId: selection?.kind === "project" ? selection.id : null,
        tagId: selection?.kind === "tag" ? selection.id : null,
        orderBy: selection?.kind === "project" ? "project" : "created",
        limit: null,
      }),
    enabled: selection !== null,
    staleTime: Infinity,
  });
  const items = itemsQuery.data ?? [];

  /** 让项目 / 标签列表回到后端的真实状态。 */
  function resync(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tags() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.items() });
  }

  /**
   * 创建项目并选中它。
   *
   * @param name 用户输入的名称。
   */
  function createProject(name: string): void {
    if (name.trim() === "") {
      setCreating(false);
      return;
    }
    ipc
      .createProject(name)
      .then((project) => {
        setCreating(false);
        setPicked({ kind: "project", id: project.id });
        resync();
      })
      .catch(reportError);
  }

  /**
   * 提交重命名。
   *
   * @param name 新名称。
   */
  function commitRename(name: string): void {
    if (renaming === null) return;
    const target = renaming;
    setRenaming(null);
    if (name.trim() === "" || name.trim() === target.name) return;
    const request =
      target.kind === "project"
        ? ipc.renameProject(target.id, name)
        : ipc.renameTag(target.id, name);
    request.then(resync).catch(reportError);
  }

  /**
   * 归档项目，给出可撤销的提示。
   *
   * @param project 要归档的项目。
   */
  function archive(project: ProjectDto): void {
    ipc
      .archiveProject(project.id)
      .then(() => {
        resync();
        useToastStore
          .getState()
          .push("success", t("projects.archived", { name: project.name }), ARCHIVE_UNDO_MS, {
            label: t("today.undo"),
            undo: true,
            onClick: () => {
              ipc.unarchiveProject(project.id).then(resync).catch(reportError);
            },
          });
      })
      .catch(reportError);
  }

  /** 确认合并标签。 */
  function confirmMerge(): void {
    if (merging === null || merging.into === "") return;
    const { from, into } = merging;
    const target = tags.find((summary) => summary.tag.id === into);
    setMerging(null);
    ipc
      .mergeTags(from.tag.id, into)
      .then(() => {
        resync();
        useToastStore
          .getState()
          .push(
            "success",
            t("projects.merged", { from: from.tag.name, into: target?.tag.name ?? "" }),
          );
      })
      .catch(reportError);
  }

  const heading = selectedProject?.name ?? (selectedTag ? `# ${selectedTag.tag.name}` : "");
  return (
    <section aria-label={t("projects.label")} className="flex h-full min-w-0">
      <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
        <nav
          aria-label={t("projects.sidebar")}
          className="flex flex-col gap-4 px-2 py-3"
          // ↑ / ↓ 在项目与标签之间移动并打开它（项目列表的最后一个接着是第一个标签）。
          onKeyDown={(event) => {
            if (moveFocusWithArrows(event, "[data-sidebar-item]")) {
              (document.activeElement as HTMLElement | null)?.click();
            }
          }}
        >
          <div>
            <header className="flex items-center justify-between px-2 pb-1">
              <h1 className="text-xs font-semibold tracking-wide text-muted">
                {t("projects.projects")}
              </h1>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("projects.new")}
                onClick={() => setCreating(true)}
              >
                {"+"}
              </Button>
            </header>
            <ul>
              {projects.map((project) =>
                renaming?.kind === "project" && renaming.id === project.id ? (
                  <NameEditor
                    key={project.id}
                    label={t("projects.renameLabel")}
                    initial={project.name}
                    onSubmit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <SidebarRow
                    key={project.id}
                    name={project.name}
                    count={project.openCount > 0 ? String(project.openCount) : null}
                    countLabel={t("projects.count", { count: project.openCount })}
                    selected={selection?.kind === "project" && selection.id === project.id}
                    onSelect={() => setPicked({ kind: "project", id: project.id })}
                    menuLabel={t("projects.menu", { name: project.name })}
                    menu={[
                      {
                        id: "rename",
                        label: t("projects.rename"),
                        onSelect: () =>
                          setRenaming({ kind: "project", id: project.id, name: project.name }),
                      },
                      {
                        id: "archive",
                        label: t("projects.archive"),
                        onSelect: () => archive(project),
                      },
                    ]}
                  />
                ),
              )}
              {creating && (
                <NameEditor
                  label={t("projects.newLabel")}
                  initial=""
                  placeholder={t("projects.newPlaceholder")}
                  onSubmit={createProject}
                  onCancel={() => setCreating(false)}
                />
              )}
            </ul>
            {projects.length === 0 && !creating && projectsQuery.data !== undefined && (
              <p className="px-3 py-2 text-xs text-muted">{t("projects.noProjects")}</p>
            )}
          </div>
          <div>
            <h2 className="px-2 pb-1 text-xs font-semibold tracking-wide text-muted">
              {t("projects.tags")}
            </h2>
            <ul>
              {tags.map((summary) =>
                renaming?.kind === "tag" && renaming.id === summary.tag.id ? (
                  <NameEditor
                    key={summary.tag.id}
                    label={t("projects.renameLabel")}
                    initial={summary.tag.name}
                    onSubmit={commitRename}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <SidebarRow
                    key={summary.tag.id}
                    name={`# ${summary.tag.name}`}
                    count={String(summary.itemCount)}
                    countLabel={t("projects.tagCount", { count: summary.itemCount })}
                    selected={selection?.kind === "tag" && selection.id === summary.tag.id}
                    onSelect={() => setPicked({ kind: "tag", id: summary.tag.id })}
                    menuLabel={t("projects.menu", { name: summary.tag.name })}
                    menu={[
                      {
                        id: "rename",
                        label: t("projects.rename"),
                        onSelect: () =>
                          setRenaming({
                            kind: "tag",
                            id: summary.tag.id,
                            name: summary.tag.name,
                          }),
                      },
                      {
                        id: "merge",
                        label: t("projects.merge"),
                        isDisabled: tags.length < 2,
                        onSelect: () =>
                          setMerging({
                            from: summary,
                            into:
                              tags.find((other) => other.tag.id !== summary.tag.id)?.tag.id ?? "",
                          }),
                      },
                    ]}
                  />
                ),
              )}
            </ul>
            {tags.length === 0 && tagsQuery.data !== undefined && (
              <p className="px-3 py-2 text-xs text-muted">{t("projects.noTags")}</p>
            )}
          </div>
        </nav>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selection === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            {projectsQuery.data !== undefined && tagsQuery.data !== undefined && (
              <>
                <p className="text-base font-medium text-text">{t("projects.empty.none")}</p>
                <p className="max-w-sm text-sm text-muted">{t("projects.empty.noneHint")}</p>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t("projects.new")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            <header className="flex items-baseline gap-3 border-b border-border px-6 py-4">
              <h2 className="truncate text-lg font-semibold text-text">{heading}</h2>
              <span className="text-sm text-muted tabular-nums">
                {selectedProject !== undefined
                  ? t("projects.count", { count: selectedProject.openCount })
                  : t("projects.tagCount", { count: selectedTag?.itemCount ?? 0 })}
              </span>
            </header>
            {merging !== null && (
              <div
                role="group"
                aria-label={t("projects.mergeTitle", { name: merging.from.tag.name })}
                className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-6 py-3 text-sm text-text"
              >
                <span>{t("projects.mergeTitle", { name: merging.from.tag.name })}</span>
                <select
                  aria-label={t("projects.mergeTarget")}
                  value={merging.into}
                  onChange={(event) => setMerging({ ...merging, into: event.target.value })}
                  className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
                >
                  {tags
                    .filter((other) => other.tag.id !== merging.from.tag.id)
                    .map((other) => (
                      <option key={other.tag.id} value={other.tag.id}>
                        {other.tag.name}
                      </option>
                    ))}
                </select>
                <Button size="sm" variant="primary" onClick={confirmMerge}>
                  {t("projects.mergeConfirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMerging(null)}>
                  {t("projects.cancel")}
                </Button>
              </div>
            )}
            {itemsQuery.data !== undefined && items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
                <p className="text-base font-medium text-text">
                  {selection.kind === "project"
                    ? t("projects.empty.title")
                    : t("projects.empty.tag")}
                </p>
                {selection.kind === "project" && (
                  <p className="max-w-sm text-sm text-muted">{t("projects.empty.hint")}</p>
                )}
              </div>
            ) : (
              <ul
                aria-label={t("projects.items")}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
                // ↑ / ↓ 在各条的标题之间移动（笔记和提示没有勾选框，标题每行都有），Enter 打开详情。
                onKeyDown={(event) => moveFocusWithArrows(event, "[data-project-item]")}
              >
                {items.map((item) => (
                  <ProjectItemRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
