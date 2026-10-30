import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemTitle } from "./ItemTitle";

/** 让元素看起来有这么宽（jsdom 不做布局）。 */
function sizeOf(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true });
}

describe("ItemTitle", () => {
  it("被截断的标题在指针移上去时以提示显示全文", () => {
    const title = "更新项目路线图文档中的第三季度里程碑和负责人";
    render(<ItemTitle id="a" title={title} />);
    const element = screen.getByText(title);
    sizeOf(element, 420, 230);

    fireEvent.mouseEnter(element);

    expect(element).toHaveAttribute("title", title);
  });

  it("简述接在标题后面，被截断时提示里也有简述", () => {
    render(<ItemTitle id="a" title="服务器维护" brief="周六凌晨两点停机" />);
    const brief = screen.getByText("周六凌晨两点停机");
    const element = brief.parentElement as HTMLElement;
    expect(element).toHaveTextContent("服务器维护周六凌晨两点停机");
    sizeOf(element, 420, 230);

    fireEvent.mouseEnter(element);

    expect(element).toHaveAttribute("title", "服务器维护\n周六凌晨两点停机");
  });

  it("放得下的标题不出多余的提示", () => {
    render(<ItemTitle id="a" title="预约体检" />);
    const element = screen.getByText("预约体检");
    sizeOf(element, 64, 230);

    fireEvent.mouseEnter(element);

    expect(element.getAttribute("title") ?? "").toBe("");
  });
});
