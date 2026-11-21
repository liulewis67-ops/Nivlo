import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { useToastStore } from "@/stores/toast-store";
import { DevConsole } from "./DevConsole";

describe("DevConsole", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("创建 Item 后出现在列表中，并清空输入框（M0 演示链路）", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<DevConsole />, ipc);

    expect(await screen.findByText("还没有任何 Item，先创建一个吧。")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "标题" }), "  修复登录超时 ");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("修复登录超时")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("");
    expect(ipc.items).toHaveLength(1);
    expect(ipc.items[0]?.itemType).toBe("todo");
  });

  it("可以切换类型后再创建", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc();
    renderWithProviders(<DevConsole />, ipc);

    await user.click(screen.getByRole("radio", { name: "笔记" }));
    await user.type(screen.getByRole("textbox", { name: "标题" }), "想法");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(ipc.items).toHaveLength(1));
    expect(ipc.items[0]?.itemType).toBe("note");
  });

  it("后端返回错误时显示以错误码为 key 的中文提示，并保留输入", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DevConsole />);

    // 只有空白的标题：Mock 与后端一样返回 ITEM_TITLE_EMPTY。
    await user.type(screen.getByRole("textbox", { name: "标题" }), "   ");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("标题不能为空。");
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("   ");
  });

  it("未知错误显示通用提示，不暴露后端 message", async () => {
    const user = userEvent.setup();
    const ipc = createMemoryIpc({
      failNextCreateWith: new AppError("STORAGE_UNAVAILABLE", "sqlite busy: secret internals"),
    });
    renderWithProviders(<DevConsole />, ipc);

    await user.type(screen.getByRole("textbox", { name: "标题" }), "x");
    await user.click(screen.getByRole("button", { name: "创建" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("本地数据库暂时不可用。");
    expect(alert).not.toHaveTextContent("secret internals");
  });
});
