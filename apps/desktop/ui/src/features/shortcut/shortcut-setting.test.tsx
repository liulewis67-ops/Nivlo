import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { ShortcutSetting } from "./ShortcutSetting";

/** 在录入框里按下一个组合键。 */
function press(
  code: string,
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  fireEvent.keyDown(screen.getByLabelText("新的快捷键"), {
    code,
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  });
}

describe("ShortcutSetting", () => {
  it("显示当前绑定；默认收起，点击后展开录入框", async () => {
    renderWithProviders(<ShortcutSetting />, createMemoryIpc());
    const button = await screen.findByRole("button", { name: "快速创建：Ctrl+Shift+Space" });
    expect(screen.queryByLabelText("新的快捷键")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByLabelText("新的快捷键")).toBeInTheDocument();
  });

  it("按下组合键录入，保存后绑定更新并提示", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<ShortcutSetting />, ipc);
    fireEvent.click(await screen.findByRole("button", { name: /快速创建：/ }));

    press("KeyQ", "q", { ctrl: true, alt: true });
    expect(screen.getByLabelText("新的快捷键")).toHaveValue("Ctrl+Alt+Q");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("button", { name: "快速创建：Ctrl+Alt+Q" })).toBeInTheDocument();
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain("Ctrl+Alt+Q");
    expect(screen.queryByLabelText("新的快捷键")).not.toBeInTheDocument();
  });

  it("没有修饰键的按键不被录入，并说明原因", async () => {
    renderWithProviders(<ShortcutSetting />, createMemoryIpc());
    fireEvent.click(await screen.findByRole("button", { name: /快速创建：/ }));
    press("KeyA", "a");
    expect(screen.getByLabelText("新的快捷键")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent("需要至少一个修饰键");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("新的快捷键被占用：显示原因、保持编辑，原来的绑定不变", async () => {
    const ipc = createMemoryIpc();
    ipc.takenShortcuts.add("Ctrl+Alt+Q");
    renderWithProviders(<ShortcutSetting />, ipc);
    fireEvent.click(await screen.findByRole("button", { name: /快速创建：/ }));

    press("KeyQ", "q", { ctrl: true, alt: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已被其他程序占用");
    expect(screen.getByLabelText("新的快捷键")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "快速创建：Ctrl+Shift+Space" })).toBeInTheDocument();

    // 换一个就能保存。
    press("KeyW", "w", { ctrl: true, alt: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "快速创建：Ctrl+Alt+W" })).toBeInTheDocument(),
    );
  });

  it("启动时快捷键被占用：自动展开并提示换一个", async () => {
    const ipc = createMemoryIpc();
    ipc.setShortcutStatus({ accelerator: "Ctrl+Shift+Space", registered: false, conflict: true });
    renderWithProviders(<ShortcutSetting />, ipc);
    expect(await screen.findByText(/已被其他程序占用，暂时无法/)).toBeInTheDocument();
    expect(screen.getByLabelText("新的快捷键")).toBeInTheDocument();
  });

  it("Esc 取消录入", async () => {
    renderWithProviders(<ShortcutSetting />, createMemoryIpc());
    fireEvent.click(await screen.findByRole("button", { name: /快速创建：/ }));
    press("KeyQ", "q", { ctrl: true });
    fireEvent.keyDown(screen.getByLabelText("新的快捷键"), { key: "Escape", code: "Escape" });
    expect(screen.queryByLabelText("新的快捷键")).not.toBeInTheDocument();
  });
});

describe("ShortcutSetting（全局搜索）", () => {
  it("显示全局搜索的绑定，保存只改搜索的快捷键", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<ShortcutSetting action="search" />, ipc);
    fireEvent.click(await screen.findByRole("button", { name: "全局搜索：Ctrl+Alt+Space" }));

    press("KeyF", "f", { ctrl: true, alt: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("button", { name: "全局搜索：Ctrl+Alt+F" })).toBeInTheDocument();
    expect(await ipc.getShortcutStatus("quickCreate")).toMatchObject({
      accelerator: "Ctrl+Shift+Space",
    });
  });

  it("和 Quick Create 撞车时说明原因，原来的绑定不变", async () => {
    renderWithProviders(<ShortcutSetting action="search" />, createMemoryIpc());
    fireEvent.click(await screen.findByRole("button", { name: /全局搜索：/ }));

    press("Space", " ", { ctrl: true, shift: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全局搜索：Ctrl+Alt+Space" })).toBeInTheDocument();
  });
});
