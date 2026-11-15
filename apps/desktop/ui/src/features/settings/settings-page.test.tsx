import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "@/i18n";
import { formatDate } from "@/lib/date-format";
import { AppError } from "@/lib/errors";
import { useThemeStore } from "@/stores/theme-store";
import { useSkinStore } from "@/stores/skin-store";
import { useToastStore } from "@/stores/toast-store";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { SettingsPage } from "./SettingsPage";

describe("设置页", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    useThemeStore.setState({ preference: "system" });
  });

  it("皮肤写入失败时保留选择，并能从设置页重试", async () => {
    const ipc = createMemoryIpc();
    vi.spyOn(ipc, "setUiPref").mockRejectedValueOnce(new Error("offline"));
    renderWithProviders(<SettingsPage />, ipc);

    const mechanic = screen.getByRole("button", { name: "机修" });
    fireEvent.click(mechanic);
    expect(mechanic).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("外观保存失败，请重试。")).toHaveAttribute("role", "alert");
    const appearance = screen.getByRole("region", { name: "悬浮窗外观" });
    fireEvent.click(within(appearance).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(useSkinStore.getState().saveStatus).toBe("idle"));
    expect(await ipc.getUiPref("skin")).toContain('"robot":"relay"');
    useSkinStore.getState().hydrate(null);
  });

  it("显示当前设置：自启关闭、置顶开启、稍后默认下周一", async () => {
    renderWithProviders(<SettingsPage />, createMemoryIpc());

    const autostart = await screen.findByRole("switch", { name: "开机自动启动" });
    await waitFor(() => expect(autostart).toBeEnabled());
    expect(autostart).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "悬浮窗置顶" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "下周一" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "3 天后" })).toHaveAttribute("aria-checked", "false");
  });

  it("页首列出各个分组，点一下滚到那一组", async () => {
    renderWithProviders(<SettingsPage />, createMemoryIpc());
    const nav = await screen.findByRole("navigation", { name: "跳到设置分组" });
    const links = within(nav).getAllByRole("button");
    expect(links).toHaveLength(10);
    const section = screen.getByRole("region", { name: "快捷键" });
    const scrolled: Element[] = [];
    section.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    fireEvent.click(within(nav).getByRole("button", { name: "快捷键" }));
    expect(scrolled).toEqual([section]);
    expect(within(section).getByRole("heading", { name: "快捷键" })).toHaveFocus();
    expect(within(nav).getByRole("button", { name: "快捷键" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("开关立即生效并保存；重新打开设置页仍是新值", async () => {
    const ipc = createMemoryIpc();
    const view = renderWithProviders(<SettingsPage />, ipc);
    const autostart = await screen.findByRole("switch", { name: "开机自动启动" });
    await waitFor(() => expect(autostart).toBeEnabled());

    fireEvent.click(autostart);
    await waitFor(() => expect(autostart).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(ipc.appSettings.autostart).toBe(true));

    fireEvent.click(screen.getByRole("switch", { name: "悬浮窗置顶" }));
    await waitFor(() => expect(ipc.appSettings.floatingAlwaysOnTop).toBe(false));

    view.unmount();
    renderWithProviders(<SettingsPage />, ipc);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "开机自动启动" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(screen.getByRole("switch", { name: "悬浮窗置顶" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("系统拒绝修改时回滚并提示原因", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    const autostart = await screen.findByRole("switch", { name: "开机自动启动" });
    await waitFor(() => expect(autostart).toBeEnabled());

    ipc.failNextSettingWith(new AppError("SYSTEM_SETTING_FAILED", "denied"));
    fireEvent.click(autostart);
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.message).toContain("系统没有允许"),
    );
    await waitFor(() => expect(autostart).toHaveAttribute("aria-checked", "false"));
    expect(ipc.appSettings.autostart).toBe(false);
  });

  it("选择「稍后」的规则会保存", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    const week = await screen.findByRole("radio", { name: "7 天后" });
    await waitFor(() => expect(week).toBeEnabled());

    fireEvent.click(week);
    await waitFor(() => expect(week).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(ipc.appSettings.laterRule).toBe("inOneWeek"));
    expect(screen.getByRole("radio", { name: "下周一" })).toHaveAttribute("aria-checked", "false");
  });

  it("主题切换立即生效；语言目前只有简体中文", async () => {
    renderWithProviders(<SettingsPage />, createMemoryIpc());
    await screen.findByRole("switch", { name: "开机自动启动" });

    fireEvent.click(screen.getByRole("button", { name: "深色" }));
    expect(useThemeStore.getState().preference).toBe("dark");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");

    const language = screen.getByRole("combobox", { name: "语言" });
    expect(language).toHaveValue("zh-CN");
    expect(screen.getAllByRole("option", { name: "简体中文" })).toHaveLength(1);
  });

  it("暂停通知的开关会保存（与托盘同一个开关）", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    const pause = await screen.findByRole("switch", { name: "暂停通知" });
    await waitFor(() => expect(pause).toBeEnabled());
    expect(pause).toHaveAttribute("aria-checked", "false");

    fireEvent.click(pause);
    await waitFor(() => expect(ipc.appSettings.notificationsPaused).toBe(true));
    await waitFor(() => expect(pause).toHaveAttribute("aria-checked", "true"));
  });
});

describe("设置页：数据与诊断", () => {
  it("导出诊断信息后提示文件位置", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "导出诊断信息" }));
    await waitFor(() => expect(ipc.calls).toContain("exportDiagnostics"));
    expect(await screen.findByText(/诊断包已导出/)).toBeInTheDocument();
  });
});

describe("设置页：导出、备份与恢复", () => {
  it("按所选格式导出，并提示条数与位置", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    await userEvent.selectOptions(await screen.findByLabelText("导出格式"), "markdown");
    await userEvent.click(screen.getByRole("button", { name: "导出笔记和待办" }));
    await waitFor(() => expect(ipc.calls).toContain("exportData:markdown"));
    expect(await screen.findByText(/已导出 0 条/)).toBeInTheDocument();
  });

  it("创建备份后提示位置", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "创建备份" }));
    expect(await screen.findByText(/备份已创建/)).toBeInTheDocument();
    expect(ipc.calls).toContain("createBackupFile");
  });

  it("选了备份后显示已先备份当前数据，点「立即重启」才重启；取消选择什么都不发生", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    ipc.chooseRestoreFile(false);
    await userEvent.click(await screen.findByRole("button", { name: "选择备份…" }));
    await waitFor(() => expect(ipc.calls).toContain("restoreBackup"));
    expect(screen.queryByText("备份已准备好")).not.toBeInTheDocument();

    ipc.chooseRestoreFile(true);
    await userEvent.click(screen.getByRole("button", { name: "选择备份…" }));
    expect(await screen.findByText("备份已准备好")).toBeInTheDocument();
    expect(screen.getByText(/nivlo-before-restore-test\.zip/)).toBeInTheDocument();
    expect(ipc.calls).not.toContain("restartApp");
    await userEvent.click(screen.getByRole("button", { name: "立即重启" }));
    await waitFor(() => expect(ipc.calls).toContain("restartApp"));
  });

  it("恢复失败时提示导出失败的原因，不显示「已准备好」", async () => {
    const ipc = createMemoryIpc();
    ipc.restoreBackup = () => Promise.reject(new AppError("EXPORT_FAILED", "bad"));
    renderWithProviders(<SettingsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "选择备份…" }));
    expect(await screen.findByText(/导出失败/)).toBeInTheDocument();
    expect(screen.queryByText("备份已准备好")).not.toBeInTheDocument();
  });

  it("删除所有数据要点两次；之后提示备份位置，点「立即重启」才重启", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    await userEvent.click(await screen.findByRole("button", { name: "删除所有数据…" }));
    expect(ipc.calls).not.toContain("resetAllData");
    await userEvent.click(screen.getByRole("button", { name: "再点一次确认删除" }));
    expect(await screen.findByText("重启后将删除数据")).toBeInTheDocument();
    expect(screen.getByText(/nivlo-before-reset-test\.zip/)).toBeInTheDocument();
    expect(ipc.calls).toContain("resetAllData");
    expect(ipc.calls).not.toContain("restartApp");
    await userEvent.click(screen.getByRole("button", { name: "立即重启" }));
    await waitFor(() => expect(ipc.calls).toContain("restartApp"));
  });
});

describe("设置页：语言", () => {
  afterEach(async () => {
    await setLanguage("zh-CN");
  });

  it("切换到 English 后界面文案和日期格式立即变化", async () => {
    renderWithProviders(<SettingsPage />, createMemoryIpc());
    await userEvent.selectOptions(await screen.findByLabelText("语言"), "en");
    expect(
      await screen.findByRole("heading", { name: "Data and diagnostics" }),
    ).toBeInTheDocument();
    expect(formatDate(new Date(2026, 9, 14), "monthDayWeekday")).toBe("Wednesday, Oct 14");
    expect(window.localStorage.getItem("nivlo.language")).toBe("en");
    await setLanguage("zh-CN");
    expect(formatDate(new Date(2026, 9, 14), "monthDayWeekday")).toBe("10月14日 星期三");
  });

  it("「预先准备全局搜索框」默认关闭，打开后立即生效并保存", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<SettingsPage />, ipc);
    const toggle = await screen.findByRole("switch", { name: "预先准备全局搜索框" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    await waitFor(() => expect(ipc.appSettings.searchPrewarm).toBe(true));
    expect(ipc.calls).toContain("setSearchPrewarm");
  });
});
