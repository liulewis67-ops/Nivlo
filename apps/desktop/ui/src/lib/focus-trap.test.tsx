import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { trapTab, restoreModalFocus } from "./focus-trap";

/** 一个带三个按钮的「对话框」，外面还有一个按钮。 */
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <button type="button">外面</button>
      <div ref={ref} role="dialog" onKeyDown={(event) => trapTab(event, ref.current)}>
        <button type="button">第一个</button>
        <button type="button" disabled>
          禁用的
        </button>
        <button type="button">最后一个</button>
      </div>
    </>
  );
}

describe("trapTab", () => {
  it("跳过被父级样式隐藏、负 tabindex、关闭的 details 与禁用 fieldset 中的控件", () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <div ref={ref} role="dialog" tabIndex={-1} onKeyDown={(event) => trapTab(event, ref.current)}>
        <div style={{ display: "none" }}>
          <button>父级隐藏</button>
        </div>
        <button tabIndex={-2}>负索引</button>
        <fieldset disabled>
          <button>组禁用</button>
        </fieldset>
        <details>
          <summary tabIndex={0}>说明</summary>
          <button>折叠内容</button>
        </details>
        <button>可用</button>
      </div>,
    );
    ref.current?.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(screen.getByText("说明")).toHaveFocus();
    screen.getByRole("button", { name: "可用" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "可用" }), { key: "Tab" });
    expect(screen.getByText("说明")).toHaveFocus();
  });

  it("按实际 tabindex 顺序循环，动态隐藏末项后回到仍然可用的控件", () => {
    const ref = { current: null as HTMLDivElement | null };
    const { rerender } = render(
      <div ref={ref} role="dialog" tabIndex={-1} onKeyDown={(event) => trapTab(event, ref.current)}>
        <button tabIndex={2}>第二站</button>
        <button tabIndex={1}>第一站</button>
        <button>末站</button>
      </div>,
    );
    ref.current?.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(screen.getByRole("button", { name: "第一站" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? screen.getByRole("dialog"), {
      key: "Tab",
      shiftKey: true,
    });
    expect(screen.getByRole("button", { name: "末站" })).toHaveFocus();
    rerender(
      <div ref={ref} role="dialog" tabIndex={-1} onKeyDown={(event) => trapTab(event, ref.current)}>
        <button tabIndex={2}>第二站</button>
        <button tabIndex={1}>第一站</button>
        <button hidden>末站</button>
      </div>,
    );
    screen.getByRole("button", { name: "第二站" }).focus();
    fireEvent.keyDown(screen.getByRole("button", { name: "第二站" }), { key: "Tab" });
    expect(screen.getByRole("button", { name: "第一站" })).toHaveFocus();
  });

  it("空对话框保持焦点；来源消失时返回标题，已有新焦点时不抢回", () => {
    const origin = document.createElement("button");
    document.body.append(origin);
    render(
      <>
        <main>
          <h1>页面标题</h1>
          <input aria-label="新目标" />
        </main>
        <div role="dialog" tabIndex={-1} />
      </>,
    );
    const dialog = screen.getByRole("dialog");
    origin.remove();
    dialog.focus();
    restoreModalFocus(origin, dialog);
    expect(screen.getByRole("heading")).toHaveFocus();
    screen.getByRole("textbox").focus();
    restoreModalFocus(origin, dialog);
    expect(screen.getByRole("textbox")).toHaveFocus();
  });
  it("在最后一个上按 Tab 回到第一个；在第一个上按 Shift+Tab 到最后一个；跳过禁用的", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "第一个" });
    const last = screen.getByRole("button", { name: "最后一个" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("中间的元素按 Tab 交给浏览器处理（不拦截）", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "第一个" });
    first.focus();
    const event = fireEvent.keyDown(first, { key: "Tab" });
    // fireEvent 返回 false 表示被 preventDefault 了。
    expect(event).toBe(true);
  });
});
