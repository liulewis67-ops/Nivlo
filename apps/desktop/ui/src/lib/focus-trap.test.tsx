import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { trapTab } from "./focus-trap";

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
