import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

/**
 * 「所见即所得」式的 Markdown 实时渲染（类似 Typora）：
 *
 * * 标题、加粗、斜体、删除线、行内代码、链接、引用、列表、任务项、代码块、分隔线直接按样式显示；
 * * 记号（`#`、`**`、`` ` ``、`[](网址)`、`>` 等）只在光标碰到它所在的元素 / 行时才露出来，方便修改；
 * * 编辑器失去焦点时全部隐藏，看到的就是排好版的样子；
 * * 任务项的 `[ ]` 换成可以直接点的勾选框。
 *
 * 文本本身始终是原样的 Markdown，保存的也是原文；这里只加装饰，不改内容。
 * 只给可见区域生成装饰，上万字的笔记也不会卡。
 */

/** 隐藏一段记号。 */
const hidden = Decoration.replace({});

/** 列表的圆点（替换 `-` / `*` / `+`）。 */
class BulletWidget extends WidgetType {
  /**
   * 没有状态，任意两个都相同。
   *
   * @returns 总是 `true`。
   */
  override eq(): boolean {
    return true;
  }

  /**
   * 生成显示用的元素。
   *
   * @returns 元素。
   */
  override toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }
}

/** 任务项的勾选框（替换 `[ ]` / `[x]`），点一下切换。 */
class TaskWidget extends WidgetType {
  /**
   * 创建勾选框。
   *
   * @param checked 是否已勾选。
   */
  constructor(readonly checked: boolean) {
    super();
  }

  /**
   * 勾选状态相同就复用 DOM。
   *
   * @param other 另一个勾选框。
   * @returns 勾选状态相同。
   */
  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }

  /**
   * 生成勾选框；点击时切换原文里的 `[ ]` / `[x]`。
   *
   * @param view 编辑器。
   * @returns 勾选框。
   */
  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
    box.checked = this.checked;
    box.tabIndex = -1;
    // 不让编辑器因为点击而移动光标（那样记号会露出来，框也跟着跳）。
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      const at = view.posAtDOM(box);
      const marker = view.state.sliceDoc(at, at + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({
        changes: { from: at + 1, to: at + 2, insert: marker[1] === " " ? "x" : " " },
        userEvent: "input.toggle",
      });
    });
    return box;
  }

  /**
   * 点击由勾选框自己处理，编辑器不管。
   *
   * @returns 总是 `true`。
   */
  override ignoreEvent(): boolean {
    return true;
  }
}

/** 分隔线（替换 `---`）。 */
class RuleWidget extends WidgetType {
  /**
   * 没有状态，任意两个都相同。
   *
   * @returns 总是 `true`。
   */
  override eq(): boolean {
    return true;
  }

  /**
   * 生成显示用的元素。
   *
   * @returns 元素。
   */
  override toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-hr";
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const taskWidgets = {
  checked: Decoration.replace({ widget: new TaskWidget(true) }),
  unchecked: Decoration.replace({ widget: new TaskWidget(false) }),
};

/** 行内元素 → 套在整个元素上的样式。 */
const INLINE_CLASS: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
  Link: "cm-md-link",
  URL: "cm-md-url",
  Autolink: "cm-md-link",
};

/** 行内元素里要隐藏的记号。 */
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);

/** 光标（或选区）所在的范围，用来决定哪些记号要露出来。 */
type Cursor = {
  /** 编辑器是否有焦点；没有焦点时全部按排版后的样子显示。 */
  focused: boolean;
  /** 选区列表。 */
  ranges: readonly { from: number; to: number }[];
};

/**
 * 选区是否碰到 `[from, to]`（端点相接也算，这样光标停在 `**粗**` 的右边时也能看到记号）。
 *
 * @param cursor 光标信息。
 * @param from 起点。
 * @param to 终点。
 * @returns 是否碰到。
 */
function touches(cursor: Cursor, from: number, to: number): boolean {
  return cursor.focused && cursor.ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * 选区是否碰到 `pos` 所在的那一行。
 *
 * @param state 编辑器状态。
 * @param cursor 光标信息。
 * @param pos 位置。
 * @returns 是否碰到。
 */
function touchesLine(state: EditorState, cursor: Cursor, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return touches(cursor, line.from, line.to);
}

/**
 * 记号后面紧跟的一个空格也一起隐藏（`# 标题` 里的空格、`> 引用` 里的空格）。
 *
 * @param state 编辑器状态。
 * @param to 记号的终点。
 * @returns 包含空格时的新终点。
 */
function withSpace(state: EditorState, to: number): number {
  return state.sliceDoc(to, to + 1) === " " ? to + 1 : to;
}

/**
 * 给一个语法节点加装饰。
 *
 * @param state 编辑器状态。
 * @param cursor 光标信息。
 * @param node 语法节点。
 * @param out 收集装饰。
 * @returns `false` 表示不用再进它的子节点。
 */
function decorateNode(
  state: EditorState,
  cursor: Cursor,
  node: SyntaxNodeRef,
  out: Range<Decoration>[],
): boolean | void {
  const { name, from, to } = node;

  const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name);
  if (heading !== null) {
    out.push(Decoration.line({ class: `cm-md-h${heading[1]}` }).range(state.doc.lineAt(from).from));
    return;
  }

  switch (name) {
    case "HeaderMark": {
      // `#` 在行首；Setext 标题下面那行 `===` 只淡化，不隐藏（隐藏后整行空着反而奇怪）。
      const parent = node.node.parent;
      if (parent !== null && parent.name.startsWith("ATX")) {
        if (!touchesLine(state, cursor, from)) {
          // 行首的 `#` 连同后面的空格；行尾可选的收尾 `#` 只隐藏它自己。
          out.push(hidden.range(from, from === parent.from ? withSpace(state, to) : to));
        }
      } else {
        out.push(Decoration.mark({ class: "cm-md-mark" }).range(from, to));
      }
      return;
    }
    case "Blockquote": {
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        out.push(Decoration.line({ class: "cm-md-quote" }).range(line.from));
        pos = line.to + 1;
      }
      return;
    }
    case "QuoteMark": {
      if (!touchesLine(state, cursor, from)) out.push(hidden.range(from, withSpace(state, to)));
      return;
    }
    case "FencedCode":
    case "CodeBlock": {
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        out.push(Decoration.line({ class: "cm-md-codeblock" }).range(line.from));
        pos = line.to + 1;
      }
      // 代码块里面不渲染任何 Markdown；只把围栏淡化。
      const cursorTree = node.node.cursor();
      if (cursorTree.firstChild()) {
        do {
          if (cursorTree.name === "CodeMark" || cursorTree.name === "CodeInfo") {
            out.push(
              Decoration.mark({ class: "cm-md-mark" }).range(cursorTree.from, cursorTree.to),
            );
          }
        } while (cursorTree.nextSibling());
      }
      return false;
    }
    case "HorizontalRule": {
      if (!touchesLine(state, cursor, from)) out.push(rule.range(from, to));
      return;
    }
    case "ListMark": {
      const item = node.node.parent;
      const task = item?.getChild("Task");
      const active = touchesLine(state, cursor, from);
      if (task !== null && task !== undefined) {
        // 任务项：勾选框一直显示；`- ` 只在光标所在行露出来。
        if (!active) out.push(hidden.range(from, withSpace(state, to)));
        return;
      }
      if (item?.parent?.name === "BulletList" && !active) out.push(bullet.range(from, to));
      else out.push(Decoration.mark({ class: "cm-md-list-mark" }).range(from, to));
      return;
    }
    case "TaskMarker": {
      const checked = /x/i.test(state.sliceDoc(from, to));
      out.push((checked ? taskWidgets.checked : taskWidgets.unchecked).range(from, to));
      const line = state.doc.lineAt(from);
      if (checked) {
        out.push(Decoration.mark({ class: "cm-md-done" }).range(withSpace(state, to), line.to));
      }
      return;
    }
    case "Link": {
      const active = touches(cursor, from, to);
      out.push(Decoration.mark({ class: "cm-md-link" }).range(from, to));
      if (active) return;
      // 只留下 `[文字]` 里的文字：隐藏 `[` 和 `](网址 "标题")`。
      const marks = node.node.getChildren("LinkMark");
      const open = marks[0];
      const close = marks[1];
      if (open === undefined || close === undefined || state.sliceDoc(open.from, open.to) !== "[") {
        return;
      }
      out.push(hidden.range(open.from, open.to));
      out.push(hidden.range(close.from, to));
      return false;
    }
    default:
      break;
  }

  const inline = INLINE_CLASS[name];
  if (inline !== undefined) {
    out.push(Decoration.mark({ class: inline }).range(from, to));
    if (touches(cursor, from, to)) return false;
    const marks = node.node.cursor();
    if (marks.firstChild()) {
      do {
        if (INLINE_MARKS.has(marks.name)) out.push(hidden.range(marks.from, marks.to));
      } while (marks.nextSibling());
    }
    // 子节点里还可能有别的行内元素（**粗体里的 *斜体***），继续往下走。
    return;
  }
}

/**
 * 生成可见区域的装饰。
 *
 * @param view 编辑器。
 * @returns 装饰。
 */
function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const cursor: Cursor = { focused: view.hasFocus, ranges: state.selection.ranges };
  const out: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({ from, to, enter: (node) => decorateNode(state, cursor, node, out) });
  }
  return Decoration.set(out, true);
}

/** 维护装饰：内容、选区、可见区域或焦点变化时重算。 */
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /**
     * 首次生成装饰。
     *
     * @param view 编辑器。
     */
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    /**
     * 需要时重算装饰。
     *
     * @param update 这次更新。
     */
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** 渲染样式（用设计 Token，随亮 / 暗主题变化）。 */
const liveTheme = EditorView.theme({
  ".cm-md-h1": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-md-h2": { fontSize: "1.35em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-md-h3": { fontSize: "1.15em", fontWeight: "650" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "650" },
  ".cm-md-h1, .cm-md-h2": { paddingTop: "0.35em", paddingBottom: "0.15em" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--nv-text-muted)" },
  ".cm-md-code": {
    fontFamily: "var(--nv-font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--nv-surface-hover)",
    borderRadius: "var(--nv-radius-sm)",
    padding: "0.1em 0.25em",
  },
  ".cm-md-link": { color: "var(--nv-primary)" },
  ".cm-md-link .cm-md-url": { color: "var(--nv-text-muted)" },
  ".cm-md-mark, .cm-md-list-mark": { color: "var(--nv-text-muted)" },
  ".cm-md-quote": {
    borderLeft: "3px solid var(--nv-border)",
    paddingLeft: "0.75em",
    color: "var(--nv-text-muted)",
  },
  ".cm-md-codeblock": {
    fontFamily: "var(--nv-font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--nv-surface-hover)",
    paddingLeft: "0.75em",
    paddingRight: "0.75em",
  },
  ".cm-md-bullet": { color: "var(--nv-text-muted)", display: "inline-block", width: "0.75em" },
  ".cm-md-task": {
    margin: "0 0.4em 0 0",
    verticalAlign: "-0.15em",
    width: "0.95em",
    height: "0.95em",
    accentColor: "var(--nv-primary)",
    cursor: "pointer",
  },
  ".cm-md-done": { color: "var(--nv-text-muted)", textDecoration: "line-through" },
  ".cm-md-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--nv-border)",
  },
});

/**
 * Markdown 实时渲染的扩展（需要和 `markdown()` 语言一起用）。
 *
 * @returns 扩展。
 */
export function liveMarkdown(): Extension {
  return [livePreview, liveTheme];
}
