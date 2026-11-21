import { autocompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { ctxApi } from "./script-api";

/** [`ScriptEditor`] 的 Props。 */
type ScriptEditorProps = {
  /** 源码。 */
  value: string;
  /** 源码变化。 */
  onChange: (value: string) => void;
  /** 无障碍名称。 */
  label: string;
};

/**
 * 脚本里 `ctx.` / `console.` 的补全：候选来自 [`ctxApi`]，与参考文档同源。
 *
 * @param context 补全上下文。
 * @returns 补全结果；光标前不是 `ctx` / `console` 的成员访问时为 `null`。
 */
function ctxCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w.]+/);
  if (word === null || (word.from === word.to && !context.explicit)) return null;
  if (!/^(c|ct|ctx|co|con|cons|conso|consol|console)(\.[\w.]*)?$/.test(word.text)) return null;
  return {
    from: word.from,
    options: ctxApi().map((entry) => ({
      label: entry.label,
      type: entry.label.startsWith("console") ? "function" : "property",
      detail: entry.detail,
      info: entry.info,
    })),
    validFor: /^[\w.]*$/,
  };
}

/** 用设计 Token 配色的编辑器主题（随亮 / 暗主题变化）。 */
const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--nv-surface)",
    color: "var(--nv-text)",
    border: "1px solid var(--nv-border)",
    borderRadius: "var(--nv-radius-md)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "2px solid var(--nv-focus-ring)" },
  ".cm-content": { fontFamily: "var(--nv-font-mono)", caretColor: "var(--nv-text)" },
  ".cm-gutters": {
    backgroundColor: "var(--nv-surface)",
    color: "var(--nv-text-muted)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-scroller": { minHeight: "14rem", maxHeight: "28rem", overflow: "auto" },
});

/**
 * 脚本编辑器（CodeMirror 6）：JavaScript 高亮、行号、括号匹配与 `ctx` 补全。
 *
 * 编辑器是非受控的：外部 `value` 与编辑器内容不一致时（例如切换 Workflow）才会整体替换，
 * 避免每次按键都重置光标。
 *
 * @param props 源码、变化回调与无障碍名称。
 * @returns 编辑器容器。
 */
export function ScriptEditor({ value, onChange, label }: ScriptEditorProps) {
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
          lineNumbers(),
          history(),
          bracketMatching(),
          indentOnInput(),
          javascript(),
          autocompletion({ override: [ctxCompletions] }),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          theme,
          EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }),
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

  return <div ref={host} data-testid="script-editor" />;
}
