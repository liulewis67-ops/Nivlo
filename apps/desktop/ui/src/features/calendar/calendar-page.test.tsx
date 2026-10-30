import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMemoryIpc } from "@/test/ipc-mock";
import type { MemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { CalendarPage } from "./CalendarPage";

/** 内存 IPC 的「今天」是 2026-10-10（周六）。 */

/** 创建一个条目。 */
async function seed(
  ipc: MemoryIpc,
  options: {
    title: string;
    itemType?: "todo" | "note" | "tip";
    scheduled?: { date: string; time: string | null };
    due?: { date: string; time: string | null };
  },
): Promise<string> {
  const item = await ipc.createItem({
    itemType: options.itemType ?? "todo",
    title: options.title,
    content: null,
    contentFormat: "plain",
    priority: null,
    scheduled: options.scheduled ?? null,
    due: options.due ?? null,
    reminderAt: null,
    projectId: null,
  });
  return item.id;
}

/** 某一天的格子。 */
function cell(label: string): HTMLElement {
  return screen.getByRole("gridcell", { name: label });
}

describe("CalendarPage 月视图", () => {
  it("显示当月的整周网格：标题、周一起始的表头、今天高亮", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());

    expect(await screen.findByRole("heading", { name: "2026年10月" })).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
    // 10 月在周一起始下是 5 周 = 35 格，从 9 月 28 日到 11 月 1 日。
    expect(screen.getAllByRole("gridcell")).toHaveLength(35);
    expect(cell("9月28日 星期一")).toBeInTheDocument();
    expect(cell("11月1日 星期日")).toBeInTheDocument();
    expect(cell("10月10日 星期六")).toHaveAttribute("aria-current", "date");
  });

  it("计划条目出现在各自的日期；已完成的划线；提示带 💡；截止标记与计划条目明确区分", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, {
      title: "写周报",
      scheduled: { date: "2026-10-14", time: null },
      due: { date: "2026-10-16", time: null },
    });
    const doneId = await seed(ipc, {
      title: "已做完",
      scheduled: { date: "2026-10-14", time: null },
    });
    await ipc.completeItem(doneId);
    await seed(ipc, {
      title: "站会",
      itemType: "tip",
      scheduled: { date: "2026-10-14", time: "10:00:00" },
    });
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    const wednesday = await waitFor(() => {
      const c = cell("10月14日 星期三");
      expect(within(c).getByText("写周报")).toBeInTheDocument();
      return c;
    });
    expect(within(wednesday).getByText("已做完")).toHaveClass("line-through");
    expect(within(wednesday).getByText("💡")).toBeInTheDocument();
    expect(within(wednesday).getByText("站会")).toBeInTheDocument();

    // 16 号只有截止标记：虚线框 + 「截止」。
    const friday = cell("10月16日 星期五");
    const dueChip = within(friday).getByRole("button", { name: "「写周报」的截止日期" });
    expect(dueChip).toHaveTextContent("截止");
    expect(dueChip).toHaveClass("border-dashed");
    // 计划条目没有这种样式。
    expect(within(wednesday).getByRole("button", { name: "写周报" })).not.toHaveClass(
      "border-dashed",
    );
  });

  it("完成的待办不再有截止标记", async () => {
    const ipc = createMemoryIpc();
    const id = await seed(ipc, {
      title: "已交付",
      scheduled: { date: "2026-10-14", time: null },
      due: { date: "2026-10-16", time: null },
    });
    await ipc.completeItem(id);
    renderWithProviders(<CalendarPage />, ipc);
    await waitFor(() =>
      expect(within(cell("10月14日 星期三")).getByText("已交付")).toBeInTheDocument(),
    );
    expect(within(cell("10月16日 星期五")).queryByText("已交付")).not.toBeInTheDocument();
  });

  it("上一页 / 下一页 / 回到今天", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());
    await screen.findByRole("heading", { name: "2026年10月" });

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("heading", { name: "2026年11月" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("heading", { name: "2026年12月" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(await screen.findByRole("heading", { name: "2026年11月" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(await screen.findByRole("heading", { name: "2026年10月" })).toBeInTheDocument();
  });

  it("键盘：J / K 翻页，T 回到今天，W / M 切换视图；在输入框里不响应", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());
    await screen.findByRole("heading", { name: "2026年10月" });

    fireEvent.keyDown(document.body, { key: "j" });
    expect(await screen.findByRole("heading", { name: "2026年11月" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "K" });
    fireEvent.keyDown(document.body, { key: "k" });
    expect(await screen.findByRole("heading", { name: "2026年9月" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "t" });
    expect(await screen.findByRole("heading", { name: "2026年10月" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "w" });
    expect(await screen.findByRole("heading", { name: "10月5日 – 10月11日" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "m" });
    expect(await screen.findByRole("heading", { name: "2026年10月" })).toBeInTheDocument();

    // 带修饰键或在输入框里：只是普通按键。
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "j" });
    input.remove();
    expect(screen.getByRole("heading", { name: "2026年10月" })).toBeInTheDocument();
  });

  it("网格里用方向键在各天之间移动：左右一天、上下一周，到边上停住", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());
    await screen.findByRole("heading", { name: "2026年10月" });
    const add = (day: string) => screen.getByRole("button", { name: `在10月${day}日添加待办` });

    add("10").focus();
    fireEvent.keyDown(add("10"), { key: "ArrowRight" });
    expect(add("11")).toHaveFocus();
    fireEvent.keyDown(add("11"), { key: "ArrowDown" });
    expect(add("18")).toHaveFocus();
    fireEvent.keyDown(add("18"), { key: "ArrowUp" });
    fireEvent.keyDown(add("11"), { key: "ArrowLeft" });
    expect(add("10")).toHaveFocus();

    // Enter 原地写一条待办。
    fireEvent.click(add("10"));
    expect(screen.getByRole("textbox", { name: "新待办" })).toHaveFocus();
  });

  it("Ctrl+N 在今天原地写一条待办；翻到别的月份时在那个月里", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());
    await screen.findByRole("heading", { name: "2026年10月" });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "新待办" });
    expect(input).toHaveFocus();
    expect(input.closest("[role=gridcell]")).toHaveAccessibleName(/10月10日/);
    fireEvent.keyDown(input, { key: "Escape" });

    fireEvent.keyDown(document.body, { key: "j" });
    await screen.findByRole("heading", { name: "2026年11月" });
    // 标题先变，网格等新的一页数据到了才换：等 11 月的格子出现。
    await screen.findByRole("gridcell", { name: /11月30日/ });
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    const next = await screen.findByRole("textbox", { name: "新待办" });
    expect(next.closest("[role=gridcell]")).toHaveAccessibleName(/11月/);
  });

  it("翻页后新一页加载完之前，网格标为忙（仍是上一页），到了再恢复", async () => {
    renderWithProviders(<CalendarPage />, createMemoryIpc());
    await screen.findByRole("heading", { name: "2026年10月" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    await screen.findByRole("gridcell", { name: /11月30日/ });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "false");
  });

  it("一周起始日设置为周日时，表头与网格跟着变", async () => {
    const ipc = createMemoryIpc();
    await ipc.setWeekStart("sunday");
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("周日");
    expect(cell("9月27日 星期日")).toBeInTheDocument();
    expect(cell("10月31日 星期六")).toBeInTheDocument();
  });

  it("一天的条目多于 3 条时折叠，点「还有 N 项」切到周视图看全部", async () => {
    const ipc = createMemoryIpc();
    for (const n of [1, 2, 3, 4, 5]) {
      await seed(ipc, { title: `任务${n}`, scheduled: { date: "2026-10-14", time: null } });
    }
    renderWithProviders(<CalendarPage />, ipc);
    const busy = await waitFor(() => {
      const c = cell("10月14日 星期三");
      expect(within(c).getByText("任务1")).toBeInTheDocument();
      return c;
    });
    expect(within(busy).queryByText("任务4")).not.toBeInTheDocument();

    fireEvent.click(within(busy).getByRole("button", { name: "还有 2 项" }));
    expect(await screen.findByRole("heading", { name: "10月12日 – 10月18日" })).toBeInTheDocument();
    const week = await waitFor(() => {
      const c = cell("10月14日 星期三");
      expect(within(c).getByText("任务5")).toBeInTheDocument();
      return c;
    });
    expect(within(week).getByText("任务4")).toBeInTheDocument();
  });
});

describe("CalendarPage 周视图", () => {
  it("只显示一周，条目带时间前缀", async () => {
    const ipc = createMemoryIpc();
    await seed(ipc, {
      title: "评审会",
      itemType: "tip",
      scheduled: { date: "2026-10-08", time: "15:30:00" },
    });
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(await screen.findByRole("heading", { name: "10月5日 – 10月11日" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);
    const thursday = await waitFor(() => {
      const c = cell("10月8日 星期四");
      expect(within(c).getByText("评审会")).toBeInTheDocument();
      return c;
    });
    expect(within(thursday).getByText("15:30")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("heading", { name: "10月12日 – 10月18日" })).toBeInTheDocument();
  });
});

describe("CalendarPage 添加与待安排", () => {
  it("点格子上的「+」原地写下一条待办，回车后计划在那一天；Esc 取消", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    fireEvent.click(screen.getByRole("button", { name: "在10月14日添加待办" }));
    const input = screen.getByLabelText("新待办");
    fireEvent.change(input, { target: { value: "  订机票 " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(ipc.items).toHaveLength(1));
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-14", time: null });
    expect(ipc.items[0]?.title).toBe("订机票");
    await waitFor(() =>
      expect(within(cell("10月14日 星期三")).getByText("订机票")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "在10月15日添加待办" }));
    fireEvent.keyDown(screen.getByLabelText("新待办"), { key: "Escape" });
    expect(screen.queryByLabelText("新待办")).not.toBeInTheDocument();
    expect(ipc.items).toHaveLength(1);
  });

  it("在某一天里写的时间就是那天的时间（「下午3点 开会」→ 15:00），日期仍由格子决定", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<CalendarPage />, ipc);
    await screen.findByRole("heading", { name: "2026年10月" });

    fireEvent.click(screen.getByRole("button", { name: "在10月14日添加待办" }));
    const input = screen.getByLabelText("新待办");
    fireEvent.change(input, { target: { value: "下午3点 开会" } });
    // 格子里提示认出的时间。
    expect(screen.getByText("🕒 15:00")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(ipc.items).toHaveLength(1));
    expect(ipc.items[0]?.scheduled).toEqual({ date: "2026-10-14", time: "15:00" });
    expect(ipc.items[0]?.title).toBe("开会");

    // 写了别的日期：不挪到那天，原样记在这一格（格子才是用户选的日期）。
    fireEvent.click(screen.getByRole("button", { name: "在10月15日添加待办" }));
    const second = screen.getByLabelText("新待办");
    fireEvent.change(second, { target: { value: "明天 交报告" } });
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() => expect(ipc.items).toHaveLength(2));
    expect(ipc.items.find((item) => item.title === "明天 交报告")?.scheduled).toEqual({
      date: "2026-10-15",
      time: null,
    });
  });

  it("「待安排」列出还没有日期的待办；没有时给出提示", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<CalendarPage />, ipc);
    const side = await screen.findByRole("complementary", { name: "待安排" });
    expect(await within(side).findByText("没有待安排的待办 🎉")).toBeInTheDocument();

    await seed(ipc, { title: "还没安排的事" });
    await seed(ipc, { title: "笔记不算", itemType: "note" });
    await waitFor(() => expect(within(side).getByText("还没安排的事")).toBeInTheDocument());
    expect(within(side).queryByText("笔记不算")).not.toBeInTheDocument();
  });
});
