import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { useEffect, useRef } from "react";
import {
  continueMarkdownList,
  indentMarkdownList,
  linkOnPaste,
  toggleMarkdownTask,
  toggleMarkdownWrap,
} from "@/lib/markdown-wrap";
import type { WrapResult } from "@/lib/markdown-wrap";
import { cx } from "@/lib/cx";
import { liveMarkdown } from "@/lib/live-markdown";

/** [`LiveMarkdownEditor`] 的 Props。 */
export type LiveMarkdownEditorProps = {
  /** Markdown 原文。 */
  value: string;
  /** 原文变化。 */
  onChange: (value: string) => void;
  /** 无障碍名称。 */
  label: string;
  /** 空白时的提示。 */
  placeholder?: string;
  /** 编辑区（可编辑元素）的 ID，供 `aria-controls` 与聚焦使用。 */
  id?: string;
  /**
   * 外观：`page` 铺满整页、无边框（笔记）；`field` 是带边框的表单字段，高度按 `rows` 行，可拖动调整（详情面板）。
   */
  variant?: "page" | "field";
  /** `field` 外观的可见行数。 */
  rows?: number;
};

/**
 * 把编辑器内容改成 `next`：只替换变化的那一段，这样撤销、光标和渲染都只动那一处。
 *
 * @param view 编辑器。
 * @param next 新的全文与选区。
 */
function applyWrap(view: EditorView, next: WrapResult): void {
  const before = view.state.doc.toString();
  let from = 0;
  while (from < before.length && from < next.value.length && before[from] === next.value[from]) {
    from += 1;
  }
  let tail = 0;
  while (
    tail < before.length - from &&
    tail < next.value.length - from &&
    before[before.length - 1 - tail] === next.value[next.value.length - 1 - tail]
  ) {
    tail += 1;
  }
  view.dispatch({
    changes: {
      from,
      to: before.length - tail,
      insert: next.value.slice(from, next.value.length - tail),
    },
    selection: { anchor: next.start, head: next.end },
    scrollIntoView: true,
    userEvent: "input",
  });
}

/**
 * 把 `markdown-wrap` 里的纯函数包装成编辑器命令（和原来文本框里的按键行为一致）。
 *
 * @param transform 根据全文与选区算出新内容；不处理时返回 `null`。
 * @returns 编辑器命令。
 */
function command(
  transform: (value: string, start: number, end: number) => WrapResult | null,
): (view: EditorView) => boolean {
  return (view) => {
    const { from, to } = view.state.selection.main;
    const next = transform(view.state.doc.toString(), from, to);
    if (next === null) return false;
    applyWrap(view, next);
    return true;
  };
}

/** Markdown 正文的按键：先走笔记自己的规则，其余交给 CodeMirror 的 Markdown 按键（引用续行等）。 */
const noteKeymap: KeyBinding[] = [
  { key: "Mod-b", run: command((v, s, e) => toggleMarkdownWrap(v, s, e, "**")) },
  { key: "Mod-i", run: command((v, s, e) => toggleMarkdownWrap(v, s, e, "*")) },
  { key: "Mod-Enter", run: command(toggleMarkdownTask) },
  { key: "Enter", run: command(continueMarkdownList) },
  // 不在列表里时不拦 Tab，焦点照常移走，键盘用户不会被困在正文里。
  {
    key: "Tab",
    run: command((v, s, e) => indentMarkdownList(v, s, e, false)),
    shift: command((v, s, e) => indentMarkdownList(v, s, e, true)),
  },
];

/** 编辑器外观（用设计 Token，随亮 / 暗主题变化）。 */
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "var(--nv-text)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--nv-font-sans)",
    lineHeight: "1.625",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--nv-text)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--nv-text-muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--nv-primary) 22%, transparent)",
  },
});

/** 两种外观各自的字号与留白。 */
const variantThemes = {
  page: EditorView.theme({
    "&": { fontSize: "15px" },
    ".cm-content": { padding: "0.5rem 0 4rem" },
  }),
  field: EditorView.theme({
    "&": { fontSize: "inherit" },
    ".cm-content": { padding: "0.5rem 0" },
  }),
};

/**
 * Markdown 正文编辑器：边写边渲染（类似 Typora），保存的仍是 Markdown 原文。
 *
 * 编辑器是非受控的：外部 `value` 与编辑器内容不一致时（例如保存失败后恢复）才会整体替换，
 * 避免每次按键都重置光标。
 *
 * @param props 原文、变化回调、无障碍名称、占位提示与外观。
 * @returns 编辑器容器。
 */
export function LiveMarkdownEditor({
  value,
  onChange,
  label,
  placeholder,
  id,
  variant = "page",
  rows = 3,
}: LiveMarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  // 回调放进 ref：编辑器只创建一次，但始终调用最新的 onChange。
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (host.current === null) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown({ base: markdownLanguage, addKeymap: false }),
          liveMarkdown(),
          keymap.of([...noteKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          baseTheme,
          variantThemes[variant],
          placeholder === undefined ? [] : placeholderText(placeholder),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "aria-multiline": "true",
            ...(id === undefined ? {} : { id }),
          }),
          EditorView.domEventHandlers({
            paste(event, target) {
              const { from, to } = target.state.selection.main;
              const pasted = event.clipboardData?.getData("text/plain") ?? "";
              const next = linkOnPaste(target.state.doc.toString(), from, to, pasted);
              if (next === null) return false;
              event.preventDefault();
              applyWrap(target, next);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // 只在挂载时创建；之后的外部变化由下面的 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  if (variant === "page") {
    return <div ref={host} className="min-h-0 w-full flex-1" />;
  }
  return (
    <div
      ref={host}
      // 行数变化（展开）只改高度，编辑器、选区与焦点都不变。
      data-rows={rows}
      style={{ height: `calc(${rows} * 1.625em + 1rem)` }}
      className={cx(
        "w-full resize-y overflow-hidden rounded-md border border-border bg-surface px-3 text-sm",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "focus-within:border-focus",
      )}
    />
  );
}
