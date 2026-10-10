import type { IpcClient } from "@/lib/ipc";

/**
 * 给浏览器预览（`pnpm dev:ui`）填一些示例数据，方便不启动 Rust 就能看到有内容的界面：
 * 今天的待办与提示，以及几条不同来源的收集箱内容。只在浏览器预览里使用，发布版本与测试不用。
 *
 * @param ipc 内存版 IPC。
 */
export async function seedDemoData(ipc: IpcClient): Promise<void> {
  await ipc.quickCreate("todo", "回复产品评审的邮件");
  await ipc.quickCreate("todo", "整理本周周报");
  await ipc.quickCreate("tip", "下午三点：站会");
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
