import type { InboxEntryDto } from "@/lib/ipc";

/** 一条 Inbox 内容的来源类别，决定图标与说明文字。 */
export type EntryKind = "url" | "file" | "text" | "image" | "other";

/** 展示一条 Inbox 内容所需的来源摘要。 */
export type EntrySummary = {
  /** 来源类别。 */
  kind: EntryKind;
  /** 来源的简短说明：网址的主机 + 路径、文件名；没有可说的就是 `null`。 */
  detail: string | null;
  /** 来源应用（如「Chrome」）；未知时为 `null`。 */
  app: string | null;
  /** 被引用的文件是否已经不在原处（移动或删除）。 */
  missingFile: boolean;
};

/**
 * 网址的简短展示：去掉协议与 `www.`、末尾的 `/`，不含查询与 fragment。
 *
 * @param raw 完整网址；解析失败时原样返回。
 * @returns 主机 + 路径。
 */
export function shortenUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    return `${host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw;
  }
}

/**
 * 取路径的最后一段（同时支持 Windows 与 POSIX 分隔符）。
 *
 * @param path 文件路径。
 * @returns 文件名；路径为空时返回空串。
 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
}

/**
 * 由 Inbox 条目的来源与附件归纳出展示摘要。
 *
 * 被引用的文件只保存路径，随时可能被移走；这里把「文件不存在」作为一个正常的展示状态返回，
 * 而不是错误（实施计划 2.2）。
 *
 * @param entry Inbox 条目。
 * @returns 来源摘要。
 */
export function summarizeEntry(entry: InboxEntryDto): EntrySummary {
  const source = entry.sources[0];
  const reference = entry.attachments.find((attachment) => attachment.kind === "reference");
  const app = source?.sourceApp ?? null;
  switch (source?.sourceType) {
    case "web":
      return {
        kind: "url",
        detail: source.sourceUrl === null ? null : shortenUrl(source.sourceUrl),
        app,
        missingFile: false,
      };
    case "file":
      return {
        kind: "file",
        detail: reference?.name ?? baseName(source.sourcePath ?? ""),
        app,
        missingFile: reference !== undefined && !reference.exists,
      };
    case "image":
      return { kind: "image", detail: null, app, missingFile: false };
    case "text":
      return { kind: "text", detail: null, app, missingFile: false };
    default:
      return { kind: "other", detail: null, app, missingFile: false };
  }
}

/**
 * 在顺序列表里选中 `anchor` 到 `target` 之间（含两端）的全部 ID，用于 Shift 点击范围选择。
 *
 * @param order 列表当前从上到下的 ID。
 * @param anchor 上一次点击的 ID。
 * @param target 这次点击的 ID。
 * @returns 范围内的 ID；任一端不在列表里时只返回 `target`。
 */
export function selectRange(order: readonly string[], anchor: string, target: string): string[] {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * 列表变化后，丢弃已经不在列表里的选中项（被整理走、被撤销之外的删除等）。
 *
 * @param selected 当前选中的 ID。
 * @param order 列表现在的 ID。
 * @returns 仍然有效的选中项；没有变化时返回原集合（避免无意义的重渲染）。
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  order: readonly string[],
): ReadonlySet<string> {
  const present = new Set(order);
  const kept = [...selected].filter((id) => present.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
}
