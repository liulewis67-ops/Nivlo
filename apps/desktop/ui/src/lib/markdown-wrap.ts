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
