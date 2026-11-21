import type { IpcClient } from "@/lib/ipc";

/**
 * 给浏览器预览（`pnpm dev:ui`）填一些示例数据，方便不启动 Rust 就能看到有内容的界面：
 * 今天的待办与提示，以及几条不同来源的收集箱内容。只在浏览器预览里使用，发布版本与测试不用。
 *
 * @param ipc 内存版 IPC。
 */
export async function seedDemoData(ipc: IpcClient): Promise<void> {
  const review = await ipc.quickCreate("todo", "回复产品评审的邮件");
  const report = await ipc.quickCreate("todo", "整理本周周报");
  const launch = await ipc.createProject("新版本发布");
  const growth = await ipc.createProject("增长实验");
  await ipc.updateItem(review.id, {
    priority: "high",
    projectId: { kind: "set", value: launch.id },
  });
  await ipc.updateItem(report.id, { projectId: { kind: "set", value: growth.id } });
  await ipc.setItemTags(review.id, ["沟通", "产品"]);
  await ipc.setItemTags(report.id, ["沟通"]);
  await ipc.quickCreate("tip", "下午三点：站会");
  // 日历演示：本月与下月的计划、截止与一个待安排的待办。
  const demo = async (
    itemType: "todo" | "tip" | "note",
    title: string,
    scheduled: { date: string; time: string | null } | null,
    due: { date: string; time: string | null } | null = null,
  ) =>
    ipc.createItem({
      itemType,
      title,
      content: null,
      contentFormat: "plain",
      priority: null,
      scheduled,
      due,
      reminderAt: null,
      projectId: null,
    });
  await demo(
    "todo",
    "季度复盘材料",
    { date: "2026-10-13", time: null },
    { date: "2026-10-16", time: null },
  );
  await demo("tip", "产品评审会", { date: "2026-10-13", time: "15:00:00" });
  await demo("todo", "预约牙医", { date: "2026-10-15", time: null });
  await demo("note", "读书笔记：Local-first", { date: "2026-10-15", time: null });
  await demo(
    "todo",
    "提交报销",
    { date: "2026-10-20", time: null },
    { date: "2026-10-23", time: null },
  );
  await demo("todo", "整理照片", null);
  await demo("todo", "给爸妈打电话", null);
  await ipc.capture({
    input: { kind: "text", text: "https://www.example.com/blog/local-first-software" },
    origin: "drop",
    sourceApplication: "Chrome",
  });
  await ipc.capture({
    input: { kind: "text", text: "记得给新来的同事开通测试环境的权限\n顺便问下他需不需要显示器" },
    origin: "drop",
    sourceApplication: "VS Code",
  });
  await ipc.capture({
    input: { kind: "files", paths: ["C:/资料/季度 报告 final.pdf"] },
    origin: "paste",
    sourceApplication: null,
  });
}
