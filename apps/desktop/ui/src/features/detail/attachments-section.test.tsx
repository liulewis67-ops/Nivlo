import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { AttachmentPreviewDto } from "@/lib/ipc";
import { createMemoryIpc } from "@/test/ipc-mock";
import { renderWithProviders } from "@/test/render";
import { AttachmentsSection } from "./AttachmentsSection";
import { ItemDetailPanel } from "./ItemDetailPanel";

/** 一个文本引用、一张托管截图和一个丢失的引用。 */
async function fixture() {
  const ipc = createMemoryIpc();
  const item = await ipc.quickCreate("todo", "查看资料");
  const detail = await ipc.getItemDetail(item.id);
  detail.attachments = [
    {
      kind: "reference",
      path: "C:/files/notes.txt",
      name: "notes.txt",
      mime: "text/plain",
      sizeBytes: 10,
      exists: true,
    },
    {
      kind: "stored",
      path: "capture.png",
      name: "capture.png",
      mime: "image/png",
      sizeBytes: 100,
      exists: true,
    },
    {
      kind: "reference",
      path: "C:/files/missing.pdf",
      name: "missing.pdf",
      mime: null,
      sizeBytes: null,
      exists: false,
    },
  ];
  return { ipc, detail };
}

describe("关联文件只读查看", () => {
  it("详情页列出全部附件；点击后才读取，文本按原样展示且没有文件编辑操作", async () => {
    const { ipc, detail } = await fixture();
    vi.spyOn(ipc, "getItemDetail").mockResolvedValue(detail);
    const preview = vi
      .spyOn(ipc, "previewItemAttachment")
      .mockResolvedValue({ kind: "text", content: "<script>这只是文本</script>" });
    const update = vi.spyOn(ipc, "updateItem");
    renderWithProviders(<ItemDetailPanel id={detail.item.id} onClose={() => undefined} />, ipc);
    const view = await screen.findByRole("button", { name: "查看「notes.txt」" });
    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "查看「capture.png」" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "查看「missing.pdf」" })).toBeDisabled();
    fireEvent.click(view);
    expect(await screen.findByText("<script>这只是文本</script>")).toHaveProperty("tagName", "PRE");
    expect(screen.getByText("只读预览")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith(detail.item.id, 0);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("region", { name: "预览「notes.txt」" })).not.toBeInTheDocument();
  });

  it("切换到图片后旧的文本请求不会覆盖当前图片，并可定位指定附件", async () => {
    const { ipc, detail } = await fixture();
    let resolveText: (value: AttachmentPreviewDto) => void = () => undefined;
    const preview = vi
      .spyOn(ipc, "previewItemAttachment")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveText = resolve;
          }),
      )
      .mockResolvedValueOnce({ kind: "image", url: "data:image/png;base64,aGVsbG8=" });
    const reveal = vi.spyOn(ipc, "revealItemAttachment");
    renderWithProviders(<AttachmentsSection detail={detail} />, ipc);
    fireEvent.click(screen.getByRole("button", { name: "查看「notes.txt」" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "查看「capture.png」" }));
    expect(await screen.findByRole("img", { name: "capture.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8=",
    );
    await act(async () => resolveText({ kind: "text", content: "旧文件内容" }));
    expect(screen.queryByText("旧文件内容")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在文件夹中显示「capture.png」" }));
    expect(reveal).toHaveBeenCalledWith(detail.item.id, 1);
  });

  it("读取失败可以重试，不支持的文件给出查看方式", async () => {
    const { ipc, detail } = await fixture();
    const preview = vi
      .spyOn(ipc, "previewItemAttachment")
      .mockRejectedValueOnce(new AppError("SOURCE_FILE_MISSING", "gone"))
      .mockResolvedValueOnce({ kind: "unavailable" });
    renderWithProviders(<AttachmentsSection detail={detail} />, ipc);
    fireEvent.click(screen.getByRole("button", { name: "查看「notes.txt」" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/此格式或大小暂不支持内置预览/)).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(2);
  });
});
