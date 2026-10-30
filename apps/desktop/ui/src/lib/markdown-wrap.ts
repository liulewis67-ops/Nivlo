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
export function continueMarkdownList(
  value: string,
  start: number,
  end: number,
): WrapResult | null {
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
