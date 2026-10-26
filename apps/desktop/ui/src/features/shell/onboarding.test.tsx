import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MainShell } from "./MainShell";
import { useNavStore } from "./nav-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { ONBOARDING_STEPS } from "@/features/onboarding";

describe("首次运行引导", () => {
  it("全新安装时出现，已经看过的不再出现", async () => {
    useNavStore.setState({ view: "today" });
    const fresh = createMemoryIpc();
    fresh.showOnboarding();
    const view = renderWithProviders(<MainShell />, fresh);
    expect(await screen.findByRole("dialog", { name: "欢迎使用拾序" })).toBeInTheDocument();
    view.unmount();

    renderWithProviders(<MainShell />, createMemoryIpc());
    await screen.findByRole("region", { name: "今天" });
    expect(screen.queryByRole("dialog", { name: "欢迎使用拾序" })).not.toBeInTheDocument();
  });

  it("走完四步：下一步 / 上一步 / 指示点跳转，最后一步是「开始使用」并记为看过", async () => {
    const user = userEvent.setup();
    useNavStore.setState({ view: "today" });
    const ipc = createMemoryIpc();
    ipc.showOnboarding();
    renderWithProviders(<MainShell />, ipc);
    const dialog = await screen.findByRole("dialog", { name: "欢迎使用拾序" });

    expect(screen.getByRole("heading", { name: "欢迎使用拾序" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一步" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("heading", { name: "悬停看今天，点一下就添加" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByRole("heading", { name: "欢迎使用拾序" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "第 4 步" }));
    expect(screen.getByRole("heading", { name: "用说话的方式安排时间" })).toBeInTheDocument();
    // 快捷键取自真实绑定。
    expect(dialog).toHaveTextContent("Ctrl+Shift+Space");
    // 同时介绍全局搜索的快捷键。
    expect(dialog).toHaveTextContent("在任何应用里按：Ctrl+Alt+Space");
    expect(screen.queryByRole("button", { name: "跳过" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始使用" }));
    expect(screen.queryByRole("dialog", { name: "欢迎使用拾序" })).not.toBeInTheDocument();
    await waitFor(() => expect(ipc.appSettings.onboardingCompleted).toBe(true));
  });

  it("键盘：← → 切换步骤，Esc 跳过并记为看过；每步焦点都在主按钮上", async () => {
    useNavStore.setState({ view: "today" });
    const ipc = createMemoryIpc();
    ipc.showOnboarding();
    renderWithProviders(<MainShell />, ipc);
    const dialog = await screen.findByRole("dialog", { name: "欢迎使用拾序" });
    await waitFor(() => expect(screen.getByRole("button", { name: "下一步" })).toHaveFocus());

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "悬停看今天，点一下就添加" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "下一步" })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "欢迎使用拾序" })).toBeInTheDocument();
    // 在第一步再按 ← 不会越界。
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "欢迎使用拾序" })).toBeInTheDocument();
    for (let i = 0; i < ONBOARDING_STEPS + 2; i += 1)
      fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "用说话的方式安排时间" })).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "欢迎使用拾序" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(ipc.appSettings.onboardingCompleted).toBe(true));
  });

  it("「跳过」随时可用，设置页的「重新查看」让它再出现", async () => {
    const user = userEvent.setup();
    useNavStore.setState({ view: "settings" });
    const ipc = createMemoryIpc();
    renderWithProviders(<MainShell />, ipc);
    await screen.findByRole("region", { name: "设置" });
    expect(screen.queryByRole("dialog", { name: "欢迎使用拾序" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "重新查看" }));
    expect(await screen.findByRole("dialog", { name: "欢迎使用拾序" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "跳过" }));
    expect(screen.queryByRole("dialog", { name: "欢迎使用拾序" })).not.toBeInTheDocument();
    await waitFor(() => expect(ipc.appSettings.onboardingCompleted).toBe(true));
  });
});
