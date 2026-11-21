import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterInput } from "@/components";

/** 受控的筛选框，带一个列表外的按钮用来放焦点。 */
function Host({
  onMoveDown,
  findShortcut,
}: {
  onMoveDown?: () => boolean;
  findShortcut?: boolean | (() => boolean);
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <button type="button">{"elsewhere"}</button>
      <FilterInput
        value={value}
        onValueChange={setValue}
        label="筛选"
        onMoveDown={onMoveDown}
        findShortcut={findShortcut}
      />
    </>
  );
}

describe("FilterInput", () => {
  it("Esc 清空；↓ / Enter 交给 onMoveDown；输入法选字时的 Enter 不算", () => {
    const onMoveDown = vi.fn(() => true);
    render(<Host onMoveDown={onMoveDown} />);
    const box = screen.getByRole("searchbox", { name: "筛选" });
    fireEvent.change(box, { target: { value: "周报" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");

    expect(fireEvent.keyDown(box, { key: "ArrowDown" })).toBe(false);
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onMoveDown).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+F 跳到筛选框；条件不满足、没开启或有对话框时不响应", () => {
    let allowed = false;
    const { rerender } = render(<Host findShortcut={() => allowed} />);
    const box = screen.getByRole("searchbox", { name: "筛选" });
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });

    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "f", ctrlKey: true });
    expect(elsewhere).toHaveFocus();
    allowed = true;
    fireEvent.keyDown(elsewhere, { key: "f", ctrlKey: true });
    expect(box).toHaveFocus();

    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "f", ctrlKey: true });
    expect(elsewhere).toHaveFocus();
    dialog.remove();

    rerender(<Host />);
    expect(box).not.toHaveAttribute("aria-keyshortcuts");
    fireEvent.keyDown(elsewhere, { key: "f", ctrlKey: true });
    expect(elsewhere).toHaveFocus();
  });
});
