import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingApp } from "./FloatingApp";

describe("FloatingApp", () => {
  it("点击徽标请求打开主窗口", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingApp />, ipc);

    await user.click(screen.getByRole("button", { name: "打开拾序主窗口" }));

    expect(ipc.openMainCalls).toBe(1);
  });
});
