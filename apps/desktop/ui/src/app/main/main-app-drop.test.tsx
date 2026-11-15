import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MainApp } from "./MainApp";

vi.mock("@/features/shell", () => ({
  MainShell: () => (
    <main>
      <textarea aria-label="Description" />
      <input type="file" aria-label="Attachment" />
    </main>
  ),
}));

/** 派发拖放并返回是否保留了浏览器的默认行为。 */
function drop(target: HTMLElement, types: string[]): boolean {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types } });
  return fireEvent(target, event);
}

it("阻止未处理的文件和链接导航，保留编辑输入和文件控件", () => {
  render(<MainApp />);
  const main = screen.getByRole("main");
  expect(drop(main, ["Files"])).toBe(false);
  expect(drop(main, ["text/uri-list", "text/plain"])).toBe(false);
  expect(drop(screen.getByLabelText("Description"), ["text/uri-list", "text/plain"])).toBe(true);
  expect(drop(screen.getByLabelText("Attachment"), ["Files"])).toBe(true);
});
