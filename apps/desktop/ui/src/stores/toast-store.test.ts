import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "./toast-store";

describe("useToastStore.undoLatest", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("执行最新一条撤销并关闭它；不是撤销的操作（如安装更新）不会被执行", () => {
    const calls: string[] = [];
    const { push, undoLatest } = useToastStore.getState();
    push("success", "完成了 A", 5000, {
      label: "撤销",
      undo: true,
      onClick: () => calls.push("A"),
    });
    push("success", "完成了 B", 5000, {
      label: "撤销",
      undo: true,
      onClick: () => calls.push("B"),
    });
    push("info", "有新版本", 5000, { label: "安装", onClick: () => calls.push("install") });

    expect(undoLatest()).toBe(true);
    expect(calls).toEqual(["B"]);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "完成了 A",
      "有新版本",
    ]);
    expect(undoLatest()).toBe(true);
    expect(undoLatest()).toBe(false);
    expect(calls).toEqual(["B", "A"]);
  });
});
