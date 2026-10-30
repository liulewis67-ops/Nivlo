/** 加粗 / 斜体之后的文本与选区。 */
export type WrapResult = {
  /** 新的全文。 */
  value: string;
  /** 新选区的起点。 */
  start: number;
  /** 新选区的终点。 */
  end: number;
};

/**
 * 给选中的文字加上（或去掉）Markdown 标记，如 `**` 加粗、`*` 斜体。
 *
 * * 选区两边已经是这个标记时去掉它（再按一次就取消）；
 * * 没有选中文字时插入一对标记，光标停在中间，接着打字就是加粗 / 斜体的内容；
 * * 结果里的选区仍然框住原来那段文字，方便连着再按别的。
 *
 * @param value 全文。
 * @param start 选区起点。
 * @param end 选区终点。
 * @param marker 标记，如 `"**"`。
 * @returns 新的全文与选区。
 */
export function toggleMarkdownWrap(
  value: string,
  start: number,
  end: number,
  marker: string,
): WrapResult {
  const size = marker.length;
  const before = value.slice(Math.max(0, start - size), start);
  const after = value.slice(end, end + size);
  if (before === marker && after === marker) {
    return {
      value: value.slice(0, start - size) + value.slice(start, end) + value.slice(end + size),
      start: start - size,
      end: end - size,
    };
  }
  return {
    value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
    start: start + size,
    end: end + size,
  };
}

/** 一行列表项：缩进、记号（`-` / `*` / `+` / `1.`）、可选的任务框，以及正文。 */
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s+)?(.*)$/;

/**
 * Markdown 列表里按 Enter：光标在一个列表项的末尾时，下一行自动带上同样的记号
 * （有序列表加一，任务框换成未勾选的 `[ ]`）；这一项是空的时去掉记号，结束列表。
 *
 * 只在光标位于行尾、没有选中文字时生效，其余情况返回 `null`，按普通换行处理。
 *
 * @param value 全文。
 * @param start 选区起点。
 * @param end 选区终点。
 * @returns 新的全文与光标位置；不需要特殊处理时为 `null`。
 */
export function continueMarkdownList(value: string, start: number, end: number): WrapResult | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", start);
  if (lineEnd !== -1 && lineEnd !== start) return null;
  if (lineEnd === -1 && start !== value.length) return null;
  const match = LIST_ITEM.exec(value.slice(lineStart, start));
  if (match === null) return null;
  const [, indent = "", marker = "", gap = " ", task, text = ""] = match;
  if (text.trim() === "") {
    // 空的一项：去掉记号，结束列表。
    return {
      value: value.slice(0, lineStart) + value.slice(start),
      start: lineStart,
      end: lineStart,
    };
  }
  const number = /^\d+/.exec(marker);
  const nextMarker = number === null ? marker : `${Number(number[0]) + 1}.`;
  const prefix = `\n${indent}${nextMarker}${gap}${task === undefined ? "" : "[ ] "}`;
  const caret = start + prefix.length;
  return { value: value.slice(0, start) + prefix + value.slice(start), start: caret, end: caret };
}

/** 列表缩进一级用的空格。 */
const LIST_INDENT = "  ";

/**
 * Markdown 列表里按 Tab / Shift+Tab：给选区涉及的列表项整行缩进 / 取消缩进一级（两个空格）。
 *
 * 选区涉及的行里一个列表项都没有时返回 `null`，Tab 照常把焦点移走，键盘用户不会被困在正文里。
 *
 * @param value 全文。
 * @param start 选区起点。
 * @param end 选区终点。
 * @param outdent 是否取消缩进（Shift+Tab）。
 * @returns 新的全文与选区；不处理时为 `null`。
 */
export function indentMarkdownList(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): WrapResult | null {
  const first = value.lastIndexOf("\n", start - 1) + 1;
  const lastBreak = value.indexOf("\n", end);
  const last = lastBreak === -1 ? value.length : lastBreak;
  const lines = value.slice(first, last).split("\n");
  if (!lines.some((line) => LIST_ITEM.test(line))) return null;
  let shiftStart = 0;
  let shiftEnd = 0;
  let offset = first;
  const changed = lines.map((line, index) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (!LIST_ITEM.test(line)) return line;
    const delta = outdent ? -Math.min(LIST_INDENT.length, /^ */.exec(line)?.[0].length ?? 0) : 2;
    if (index === 0 && start >= lineStart) shiftStart = delta;
    if (end >= lineStart) shiftEnd += delta;
    // 注意 outdent 时 delta 可能是 -0：按「是否取消缩进」分支，而不是看正负。
    return outdent ? line.slice(-delta) : LIST_INDENT + line;
  });
  return {
    value: value.slice(0, first) + changed.join("\n") + value.slice(last),
    start: Math.max(first, start + shiftStart),
    end: Math.max(first, end + shiftEnd),
  };
}

/** 一行任务项：缩进、记号与空白、任务框里的那个字符。 */
const TASK_ITEM = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\].*)$/;

/**
 * Ctrl+Enter：勾选 / 取消勾选选区涉及的任务项（`- [ ]` ↔ `- [x]`）。
 * 选区涉及的行里有未勾选的就全部勾上，否则全部取消；一个任务项都没有时返回 `null`。
 *
 * @param value 全文。
 * @param start 选区起点。
 * @param end 选区终点。
 * @returns 新的全文与选区（长度不变，选区不动）；不处理时为 `null`。
 */
export function toggleMarkdownTask(value: string, start: number, end: number): WrapResult | null {
  const first = value.lastIndexOf("\n", start - 1) + 1;
  const lastBreak = value.indexOf("\n", end);
  const last = lastBreak === -1 ? value.length : lastBreak;
  const lines = value.slice(first, last).split("\n");
  const tasks = lines.map((line) => TASK_ITEM.exec(line));
  if (tasks.every((task) => task === null)) return null;
  const check = tasks.some((task) => task !== null && task[2] === " ");
  const changed = lines.map((line, index) => {
    const task = tasks[index];
    return task === null || task === undefined ? line : `${task[1]}${check ? "x" : " "}${task[3]}`;
  });
  return { value: value.slice(0, first) + changed.join("\n") + value.slice(last), start, end };
}

/**
 * 选中文字后粘贴一个网址：变成 Markdown 链接 `[文字](网址)`，而不是用网址替换掉文字。
 * 没有选中文字、粘贴的不是单个 http(s) 网址，或选中的本身就是网址时返回 `null`，按普通粘贴处理。
 *
 * @param value 全文。
 * @param start 选区起点。
 * @param end 选区终点。
 * @param pasted 剪贴板里的文字。
 * @returns 新的全文与光标位置（在链接之后）；不处理时为 `null`。
 */
export function linkOnPaste(
  value: string,
  start: number,
  end: number,
  pasted: string,
): WrapResult | null {
  const url = pasted.trim();
  const selected = value.slice(start, end);
  if (start === end || !/^https?:\/\/\S+$/i.test(url) || /^https?:\/\//i.test(selected)) {
    return null;
  }
  if (selected.includes("\n")) return null;
  const link = `[${selected}](${url})`;
  const caret = start + link.length;
  return { value: value.slice(0, start) + link + value.slice(end), start: caret, end: caret };
}
