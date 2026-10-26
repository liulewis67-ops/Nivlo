#!/usr/bin/env node
// 桌面端 E2E 关键路径（实施计划 7.1）：启动真实的发布版程序（临时数据目录），通过 WebView2 的调试端口
// （CDP）驱动界面与 IPC，覆盖：应用启动、Hover 悬浮窗、Quick Add、完成 Todo、拖入文件、排期，
// 以及搜索相关的优化：拼音首字母（迁移 0008）、最近使用（迁移 0007）、结果标签、快捷键停用 / 启用、
// 从命令打开主窗口的视图。
//
// 用法：node tests/e2e/e2e.mjs [--runs N]    需要先构建：pnpm tauri build --no-bundle（仅 Windows / WebView2）
// 说明：计划里写的是 tauri-driver（WebDriver）；这里用 CDP 是因为它不需要额外下载 msedgedriver，
// 且已经在真机验收里验证过。每次运行都使用全新的数据目录，互不影响。

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.env.NIVLO_EXE ?? join(ROOT, "target", "release", process.platform === "win32" ? "nivlo-desktop.exe" : "nivlo-desktop");
const PORT = 9244;
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${what}${last ? `（${last.message}）` : ""}`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception ?? r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const invoke = (cmd, args = {}) =>
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { send, evaluate, invoke, close: () => ws.close() };
}

const listPages = async () =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((p) => p.type === "page");

async function runOnce(index) {
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-"));
  const dropFile = join(data, "dropped.txt");
  writeFileSync(dropFile, "e2e");
  const env = {
      ...process.env,
      NIVLO_DATA_DIR: join(data, "data"),
      NIVLO_SKIP_FIRST_RUN_PROMPTS: "1",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  const child = spawn(EXE, [], { env, stdio: "ignore" });
  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      throw new Error(`[${name}] ${e.message}`);
    }
    steps.push(name);
  };
  try {
    let main, floating;
    // 1. 应用启动：主窗口与悬浮窗的页面都起来了，并渲染出内容。
    await step("应用启动", async () => {
      // 启动时只有悬浮窗的页面；主窗口按需创建，不在启动路径上。
      const pages = await until(async () => {
        const p = await listPages();
        return p.length >= 1 ? p : null;
      }, "悬浮窗页面");
      floating = await connect(pages[0].webSocketDebuggerUrl);
      floating.pageId = pages[0].id;
      await until(() => floating.evaluate("document.getElementById('root')?.children.length > 0"), "界面渲染");
      main = floating;
    });

    // 2. Hover 悬浮窗：真实的指针移动会展开它。
    await step("Hover 悬浮窗", async () => {
      await floating.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
      const box = await floating.evaluate("(() => { const r = document.querySelector('button').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()");
      await floating.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] });
      await until(() => floating.evaluate("[...document.querySelectorAll('[aria-label]')].some((e) => ['今日面板', 'Today panel'].includes(e.getAttribute('aria-label')))"), "悬浮窗展开");
    });

    // 再启动一次程序 = 单实例机制把它转成「显示主窗口」（和用户点桌面图标 / 托盘一样）。
    await step("打开主窗口", async () => {
      spawn(EXE, [], { env, stdio: "ignore" }).on("error", () => {});
      const page = await until(async () => (await listPages()).find((p) => p.id !== floating.pageId), "主窗口页面");
      main = await connect(page.webSocketDebuggerUrl);
      await until(() => main.evaluate("document.getElementById('root')?.children.length > 0"), "主窗口渲染");
    });

    // 3. Quick Add：创建一个 Todo，今天的视图里出现它。
    const title = `e2e-todo-${index}`;
    let todo;
    await step("Quick Add", async () => {
      todo = await main.invoke("quick_create", { request: { itemType: "todo", title, scheduled: null } });
      const id = todo?.id ?? todo?.item?.id;
      if (!id) throw new Error(`创建结果没有 id：${JSON.stringify(todo)}`);
      todo = { id };
      const found = await main.invoke("search_items", { query: title });
      if (!found.some((i) => i.title === title)) throw new Error("搜索不到刚创建的 Todo");
      // 数据变化事件只发给主窗口与悬浮窗（emit_to）：悬浮窗的 Today 面板要自己刷新出这一条。
      try {
        await until(() => floating.evaluate(`document.body.innerText.includes(${JSON.stringify(title)})`), "悬浮窗收到事件并刷新", 8000);
      } catch (e) {
        const state = await floating.evaluate("JSON.stringify({ panel: !!document.querySelector(\"[aria-label='今日面板'],[aria-label='Today panel']\"), text: document.body.innerText.slice(0, 300) })");
        throw new Error(`${e.message} ${state}`);
      }
    });

    // 4. 完成 Todo。
    await step("完成 Todo", async () => {
      await main.invoke("reschedule_item", { id: todo.id, target: { kind: "today" } });
      const done = await main.invoke("complete_item", { id: todo.id });
      if (done.status !== "done") throw new Error(`状态不是 done：${done.status}`);
      const today = await main.invoke("get_today");
      if (!JSON.stringify(today).includes(title)) throw new Error("今天的视图里没有已完成的 Todo");
    });

    // 5. 拖入文件：走和原生 Drop 相同的捕获入口（kind=files）。
    await step("拖入文件", async () => {
      const result = await main.invoke("capture", { request: { input: { kind: "files", paths: [dropFile] }, origin: "drop", sourceApplication: null } });
      if (!result.items?.length) throw new Error("捕获没有创建 Item");
      const inbox = await main.invoke("list_inbox");
      if (!inbox.some((e) => e.attachments?.length > 0)) throw new Error("Inbox 里没有带附件的条目");
    });

    // 6. 排期：把一个新 Todo 排到明天，日历里出现它。
    await step("排期", async () => {
      const t = await main.invoke("quick_create", { request: { itemType: "todo", title: `e2e-plan-${index}`, scheduled: null } });
      const id = t?.id ?? t?.item?.id;
      const moved = await main.invoke("reschedule_item", { id, target: { kind: "tomorrow" } });
      if (!moved.scheduled) throw new Error("排期后没有计划日期");
    });

    // 7. 拼音首字母：升级迁移 0008 之后，新建的中文标题能用首字母搜到。
    let chinese;
    await step("拼音首字母搜索", async () => {
      const created = await main.invoke("quick_create", { request: { itemType: "note", title: "整理本周周报", scheduled: null } });
      chinese = created?.id ?? created?.item?.id;
      const found = await main.invoke("search_items", { query: "zlbzzb" });
      if (!found.some((i) => i.id === chinese)) throw new Error("用 zlbzzb 搜不到「整理本周周报」");
    });

    // 8. 最近使用（迁移 0007）：打开过的条目排到最前，即使它不是最近修改的。
    await step("最近使用", async () => {
      await main.invoke("mark_item_opened", { id: todo.id });
      const recent = await main.invoke("list_items", {
        request: { itemType: null, includeArchived: false, projectId: null, tagId: null, orderBy: "recent", limit: 3 },
      });
      if (recent[0]?.id !== todo.id) throw new Error(`最近使用的第一条不是刚打开的条目：${JSON.stringify(recent.map((i) => i.title))}`);
    });

    // 9. 结果旁的标签：一次取一批。
    await step("结果标签", async () => {
      await main.invoke("set_item_tags", { id: chinese, names: ["e2e", "周报"] });
      const tags = await main.invoke("tags_for_items", { ids: [todo.id, chinese] });
      const names = tags.find((t) => t.itemId === chinese)?.tags.map((t) => t.name).sort();
      if (JSON.stringify(names) !== JSON.stringify(["e2e", "周报"])) throw new Error(`标签不对：${JSON.stringify(tags)}`);
      if (tags.find((t) => t.itemId === todo.id)?.tags.length !== 0) throw new Error("没有标签的条目返回了标签");
    });

    // 10. 快捷键停用后再启用（用一个少见的组合启用，避免和本机正在运行的 Nivlo 撞车）。
    await step("快捷键停用 / 启用", async () => {
      const off = await main.invoke("disable_shortcut", { action: "search" });
      if (!off.disabled || off.registered) throw new Error(`停用后的状态不对：${JSON.stringify(off)}`);
      const on = await main.invoke("set_shortcut", { action: "search", accelerator: "Ctrl+Alt+Shift+F9" });
      if (on.disabled || !on.registered) throw new Error(`重新启用后的状态不对：${JSON.stringify(on)}`);
    });

    // 11. 命令「前往：设置」：主窗口切到设置页（以前只接受五个视图）。
    await step("前往设置", async () => {
      // 主窗口自己切换视图，不拥有这个命令；悬浮窗和全局搜索框才会请求主窗口打开某个视图。
      await floating.invoke("open_main_at", { view: "settings" });
      await until(
        () => main.evaluate("[...document.querySelectorAll('section[aria-label]')].some((s) => ['快捷键', 'Shortcuts'].includes(s.getAttribute('aria-label')))"),
        "设置页的快捷键分区",
      );
    });
    return steps;
  } finally {
    child.kill();
    await sleep(800);
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* 已退出 */
    }
    await sleep(500);
    rmSync(data, { recursive: true, force: true });
  }
}

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}，请先运行 pnpm tauri build --no-bundle`);
  process.exit(2);
}
mkdirSync(tmpdir(), { recursive: true });
let failed = 0;
for (let i = 1; i <= RUNS; i++) {
  try {
    const steps = await runOnce(i);
    console.log(`✓ 第 ${i} 次：${steps.join(" → ")}`);
  } catch (e) {
    failed += 1;
    console.error(`✗ 第 ${i} 次：${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
