import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateConfiguration } from "@/features/quick-create";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { FloatingRoot } from "./FloatingRoot";

/** 悬浮窗根元素。 */
function root(): HTMLElement {
  return screen.getByRole("group", { name: "拾序悬浮窗" });
}

/** 推进虚拟时间并让挂起的 Promise 完成。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 构造一个拖放用的 dataTransfer。 */
function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (format: string) => data[format] ?? "",
    files: [],
    dropEffect: "none",
  };
}

/** 拖入悬浮窗并松在「新建事项」区。 */
async function dropOnCreate(dataTransfer: ReturnType<typeof transfer>): Promise<void> {
  fireEvent.dragEnter(root(), { dataTransfer });
  await advance(0);
  const zone = screen.getByText("新建事项…").closest("[data-drop-zone]");
  if (zone === null) throw new Error("没有新建事项放置区");
  fireEvent.drop(zone, { dataTransfer });
  await advance(0);
}

/** 浏览器地址栏拖出的页面。 */
const page = transfer({
  "text/uri-list": "https://example.com/guide",
  "text/plain": "https://example.com/guide",
  "text/html": '<a href="https://example.com/guide">使用指南</a>',
});

describe("拖放新建事项（悬浮窗）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("网页松在「新建事项」：打开预填的配置页，创建时网页作为来源一起保存", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnCreate(page);

    expect(ipc.captures).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "新增事项" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "笔记" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("标题")).toHaveValue("使用指南");
    const links = screen.getByRole("region", { name: "关联资料（1）" });
    expect(within(links).getByText("example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await advance(0);
    expect(ipc.items[0]).toMatchObject({ itemType: "note", title: "使用指南" });
    const detail = await ipc.getItemDetail(ipc.items[0]?.id ?? "");
    expect(detail.sources).toEqual([
      expect.objectContaining({
        sourceType: "web",
        sourceUrl: "https://example.com/guide",
        originalTitle: "使用指南",
      }),
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("选中的文字：预填为待办，不带关联资料", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    await dropOnCreate(transfer({ "text/plain": "给客户回电话\n上午十点前" }));

    expect(screen.getByRole("radio", { name: "待办" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("标题")).toHaveValue("给客户回电话");
    expect(screen.getByLabelText("描述")).toHaveValue("给客户回电话\n上午十点前");
    expect(screen.queryByRole("region", { name: /关联资料/ })).not.toBeInTheDocument();
  });

  it("配置页已打开时再拖入：追加关联资料、不覆盖已填标题、不重复", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "我的标题" } });

    // 整页都是放置区，拖入时提示「添加为关联资料」。
    fireEvent.dragEnter(root(), { dataTransfer: page });
    expect(screen.getByText("松手添加为关联资料")).toBeInTheDocument();
    fireEvent.drop(screen.getByRole("dialog"), { dataTransfer: page });
    await advance(0);
    fireEvent.drop(screen.getByRole("dialog"), { dataTransfer: page });
    await advance(0);

    expect(screen.getByRole("radio", { name: "待办" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("标题")).toHaveValue("我的标题");
    expect(screen.getByRole("region", { name: "关联资料（1）" })).toBeInTheDocument();
  });

  it("拖到配置页的输入框上的文字交给输入框，不被拦截", async () => {
    const ipc = createMemoryIpc();
    renderWithProviders(<FloatingRoot />, ipc);
    act(() => ipc.emitQuickAddRequested());
    await advance(0);
    const content = screen.getByLabelText("描述");
    const dataTransfer = transfer({ "text/plain": "插入的文字" });
    fireEvent.dragEnter(content, { dataTransfer });
    expect(screen.queryByText("松手添加为关联资料")).not.toBeInTheDocument();
    expect(fireEvent.drop(content, { dataTransfer })).toBe(true);
    await advance(0);
    expect(screen.queryByRole("region", { name: /关联资料/ })).not.toBeInTheDocument();
  });
});

describe("配置页里的本地文件引用", () => {
  it("显示文件与所在文件夹、说明只记录位置；可以移除；创建时只传路径", async () => {
    const ipc = createMemoryIpc();
    const onDone = vi.fn();
    renderWithProviders(
      <CreateConfiguration
        kind="todo"
        onDone={onDone}
        seed={{
          id: 1,
          draft: {
            kind: "note",
            title: null,
            content: "",
            links: [
              { kind: "file", path: "D:\\资料\\报告.pdf", name: "报告.pdf" },
              { kind: "file", path: "D:\\资料\\素材", name: "素材" },
            ],
          },
        }}
      />,
      ipc,
    );
    await act(async () => {});

    expect(screen.getByLabelText("标题")).toHaveValue("报告.pdf 等 2 项");
    expect(screen.getAllByText("D:\\资料\\")).toHaveLength(2);
    expect(screen.getByText(/文件只记录位置，不会复制/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "移除关联资料「素材」" }));
    expect(screen.getByRole("region", { name: "关联资料（1）" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await act(async () => {});
    const detail = await ipc.getItemDetail(ipc.items[0]?.id ?? "");
    expect(detail.attachments).toEqual([
      expect.objectContaining({ kind: "reference", path: "D:\\资料\\报告.pdf" }),
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("带着拖入内容取消：先确认放弃", async () => {
    const onDone = vi.fn();
    renderWithProviders(
      <CreateConfiguration
        kind="todo"
        onDone={onDone}
        seed={{
          id: 1,
          draft: {
            kind: "note",
            title: null,
            content: "",
            links: [{ kind: "web", url: "https://a.com", title: null }],
          },
        }}
      />,
      createMemoryIpc(),
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("放弃这次填写的内容？")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
