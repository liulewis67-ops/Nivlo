import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { Tooltip } from "./Tooltip";

it("Escape 先关闭焦点提示，再次 Escape 才关闭父模态", async () => {
  const close = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="父表面"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <Tooltip content="完整标题">
        <button>条目</button>
      </Tooltip>
    </div>,
  );
  await user.tab();
  expect(await screen.findByRole("tooltip")).toHaveTextContent("完整标题");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
});
