import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { IntegrationsSetting } from "./IntegrationsSetting";

describe("设置页 · 集成", () => {
  it("连接 GitHub：令牌写入凭据库，输入框清空，之后只显示已连接", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<IntegrationsSetting />, ipc);

    const token = await screen.findByLabelText("个人访问令牌");
    await userEvent.type(token, "ghp_secret123");
    await userEvent.click(
      within(screen.getByRole("group", { name: "GitHub" })).getByRole("button", { name: "连接" }),
    );

    await waitFor(() =>
      expect(ipc.integrationSecrets.get("github:github.com")).toBe("ghp_secret123"),
    );
    // 连接后表单消失（GitHub 只有一个账号），页面上读不回令牌。
    expect(await screen.findByText("GitHub 账号")).toBeInTheDocument();
    expect(screen.queryByLabelText("个人访问令牌")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ghp_secret123");
  });

  it("连接 Jira Cloud 需要邮箱，凭据按「邮箱:API Token」保存；自托管只要令牌", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<IntegrationsSetting />, ipc);

    const address = await screen.findByLabelText("Jira 地址");
    await userEvent.type(address, "https://acme.atlassian.net");
    await userEvent.type(await screen.findByLabelText("账号邮箱"), "me@acme.com");
    await userEvent.type(screen.getByLabelText("API Token"), "tok123");
    const group = screen.getByRole("group", { name: "Jira" });
    await userEvent.click(within(group).getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(ipc.integrationSecrets.get("jira:acme.atlassian.net")).toBe("me@acme.com:tok123"),
    );

    // 自托管：没有邮箱框。
    await userEvent.type(await screen.findByLabelText("Jira 地址"), "jira.corp.local:8080");
    expect(screen.queryByLabelText("账号邮箱")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("个人访问令牌（PAT）"), "pat-1");
    await userEvent.click(
      within(screen.getByRole("group", { name: "Jira" })).getAllByRole("button", {
        name: "连接",
      })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(ipc.integrationSecrets.get("jira:jira.corp.local:8080")).toBe("pat-1"),
    );
  });

  it("测试连接：分别提示认证失败、权限不足、网络问题，成功时显示账号", async () => {
    const ipc = createMemoryIpc();
    await ipc.connectIntegration("github", "", "ghp_x");
    renderWithProviders(<IntegrationsSetting />, ipc);

    const cases: [Parameters<typeof ipc.scriptIntegrationTest>[0], string, RegExp][] = [
      ["authFailed", "", /认证失败/],
      ["permissionDenied", "Token 有效，但权限不足", /令牌有效，但权限不足/],
      ["network", "无法连接", /连不上服务：无法连接/],
      ["ok", "octocat", /已连接，账号：octocat/],
    ];
    for (const [status, message, expected] of cases) {
      ipc.scriptIntegrationTest(status, message);
      await userEvent.click(await screen.findByRole("button", { name: "测试连接" }));
      expect(await screen.findByText(expected)).toBeInTheDocument();
    }
  });

  it("断开：二次确认后凭据被删除", async () => {
    const ipc = createMemoryIpc();
    await ipc.connectIntegration("github", "", "ghp_x");
    renderWithProviders(<IntegrationsSetting />, ipc);

    await userEvent.click(await screen.findByRole("button", { name: "断开" }));
    await userEvent.click(screen.getByRole("button", { name: "确定断开？" }));
    await waitFor(() => expect(ipc.integrationSecrets.size).toBe(0));
    expect(await screen.findByLabelText("个人访问令牌")).toBeInTheDocument();
  });

  it("上一次测试失败的原因会在重新打开设置页时显示", async () => {
    const ipc = createMemoryIpc();
    await ipc.connectIntegration("github", "", "ghp_x");
    ipc.scriptIntegrationTest("authFailed", "认证失败：Token 无效或已过期");
    await ipc.testIntegration("github", "github.com");
    renderWithProviders(<IntegrationsSetting />, ipc);
    expect(await screen.findByText(/最近一次检查失败：认证失败/)).toBeInTheDocument();
  });
});
