import { EditorView } from "@codemirror/view";

/**
 * 找到 Markdown 正文编辑器（CodeMirror）。
 *
 * @param element `getByLabelText("描述")` 拿到的可编辑区域。
 * @returns 编辑器。
 */
export function bodyView(element: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(element);
  if (view === null) throw Error("Expected a Markdown body editor");
  return view;
}

/**
 * 正文编辑器里的原文。
 *
 * @param element 可编辑区域。
 * @returns 原文。
 */
export function bodyText(element: HTMLElement): string {
  return bodyView(element).state.doc.toString();
}

/**
 * 像用户输入一样整体替换正文。
 *
 * @param element 可编辑区域。
 * @param text 新的原文。
 */
export function setBody(element: HTMLElement, text: string): void {
  const view = bodyView(element);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

/**
 * 设置正文的选区。
 *
 * @param element 可编辑区域。
 * @param start 起点。
 * @param end 终点。
 */
export function selectBody(element: HTMLElement, start: number, end: number): void {
  bodyView(element).dispatch({ selection: { anchor: start, head: end } });
}

/**
 * 正文的选区。
 *
 * @param element 可编辑区域。
 * @returns `[起点, 终点]`。
 */
export function bodySelection(element: HTMLElement): [number, number] {
  const { from, to } = bodyView(element).state.selection.main;
  return [from, to];
}
