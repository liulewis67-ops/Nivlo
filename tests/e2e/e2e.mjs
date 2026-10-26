#!/usr/bin/env node
// 桌面端 E2E 关键路径（实施计划 7.1）：启动真实的发布版程序（临时数据目录），通过 WebView2 的调试端口
// （CDP）驱动界面与 IPC，覆盖：应用启动、Hover 悬浮窗、Quick Add、完成 Todo、拖入文件、排期，
// 以及搜索相关的优化：拼音首字母（迁移 0008）、最近使用（迁移 0007）、结果标签、快捷键停用 / 启用、
// 从命令打开主窗口的视图。
//
// 用法：node tests/e2e/e2e.mjs [--runs N] [--native]    需要先构建：pnpm tauri build --no-bundle（仅 Windows / WebView2）
// --native：额外用真实按键（SendInput）按全局快捷键，检查全局搜索框的原生行为（出现、拿到键盘焦点、位置、
// Esc 隐藏、再次出现时是干净的）。会向系统发送一次 Ctrl+Alt+Shift+F9（被测程序注册的组合，别的程序收不到），
// 所以默认不跑，CI 也不跑。
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
const NATIVE = process.argv.includes("--native");
/** --native 测得的唤出耗时（毫秒）：从按键发出到输入框拿到焦点。 */
const hotkeyTimings = { first: [], again: [] };

/**
 * 进程 `pid` 当前可见的顶层窗口数（Win32 EnumWindows + IsWindowVisible）。
 * WebView2 的 `document.visibilityState` 不会随窗口隐藏变化，所以隐藏与否要问系统。
 */
function visibleWindowCount(pid) {
  return Number(
    win32(
      `$count = 0; [E2E.Native]::EnumWindows({ param($h, $p) $owner = 0; [void][E2E.Native]::GetWindowThreadProcessId($h, [ref]$owner); if ($owner -eq ${pid} -and [E2E.Native]::IsWindowVisible($h)) { $script:count++ }; $true }, [System.IntPtr]::Zero) | Out-Null; $count`,
    ),
  );
}

/** 一段 PowerShell 共用的 Win32 声明。 */
const WIN32 = `Add-Type -Namespace E2E -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l); public delegate bool EnumProc(System.IntPtr h, System.IntPtr p); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }'`;

/** 运行一段带 Win32 声明的 PowerShell，返回去掉首尾空白的输出。 */
function win32(body) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${WIN32}; ${body}`], { encoding: "utf8" }).trim();
}

/** 当前前台窗口的句柄（数字）。 */
const foregroundWindow = () => win32("[E2E.Native]::GetForegroundWindow().ToInt64()");

/** PowerShell 片段：找出进程 `pid` 面积最大的可见窗口（主窗口），放进 `$best`。 */
const largestWindow = (pid) =>
  `$best = [System.IntPtr]::Zero; $area = 0; [E2E.Native]::EnumWindows({ param($h, $x) $owner = 0; [void][E2E.Native]::GetWindowThreadProcessId($h, [ref]$owner); if ($owner -eq ${pid} -and [E2E.Native]::IsWindowVisible($h)) { $r = New-Object E2E.Native+RECT; [void][E2E.Native]::GetWindowRect($h, [ref]$r); $a = ($r.Right - $r.Left) * ($r.Bottom - $r.Top); if ($a -gt $script:area) { $script:area = $a; $script:best = $h } }; $true }, [System.IntPtr]::Zero) | Out-Null`;

/** 像用户点「关闭」一样，给进程 `pid` 的主窗口发 WM_CLOSE；主窗口会把关闭变成隐藏。 */
function closeLargestWindow(pid) {
  win32(`${largestWindow(pid)}; [void][E2E.Native]::PostMessage($best, 0x10, [System.IntPtr]::Zero, [System.IntPtr]::Zero)`);
}

/**
 * 把焦点切到进程 `pid` 的主窗口（相当于用户点了别的窗口），返回它的句柄。
 * 先按一下 Alt：系统只允许「刚收到输入」的进程改前台窗口。
 */
function focusLargestWindow(pid) {
  return win32(
    `${largestWindow(pid)}; [E2E.Native]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero); [void][E2E.Native]::SetForegroundWindow($best); $best.ToInt64()`,
  );
}

/** 用 SendInput（keybd_event）按下并松开 Ctrl+Alt+Shift+F9——第 10 步把全局搜索绑到了这个组合。 */
function pressSearchHotkey() {
  const script = [
    "Add-Type -Namespace E2E -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'",
    "$keys = 0x11, 0x12, 0x10, 0x78",
    "foreach ($k in $keys) { [E2E.Keys]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }",
    "[array]::Reverse($keys)",
    "foreach ($k in $keys) { [E2E.Keys]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }",
    "[DateTimeOffset]::Now.ToUnixTimeMilliseconds()",
  ].join("; ");
  // 返回松开按键那一刻的时间（Unix 毫秒），计时从这里开始，不受 PowerShell 退出快慢影响。
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim());
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20000, every = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
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

/**
 * 被测程序（按完整路径）是否还有进程在运行。上一轮的进程没退干净时，新启动的程序会被单实例机制
 * 转交给它——而它的临时数据目录已经删掉了（表现为 STORAGE_UNAVAILABLE）。
 */
function testInstanceRunning() {
  // PowerShell 的单引号字符串里反斜杠不是转义符（JSON.stringify 的 \\ 会原样留下，永远匹配不上）。
  const quoted = `'${EXE.replaceAll("'", "''")}'`;
  const script = `@(Get-Process -Name nivlo-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${quoted} }).Count`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim()) > 0;
}

async function runOnce(index) {
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
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
      main.pageId = page.id;
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
      // 数据变化事件只发给主窗口与悬浮窗（emit_to）：悬浮窗要自己刷新——展开时列表里出现这一条，
      // 收起时（真实鼠标不在它上面就会收起）徽标上的剩余数等于后端的最新值。
      const remaining = (await main.invoke("get_today")).remainingCount;
      try {
        await until(
          () =>
            floating.evaluate(
              `(() => { const text = document.body.innerText; return text.includes(${JSON.stringify(title)}) || Number(text.trim()) === ${remaining}; })()`,
            ),
          "悬浮窗收到事件并刷新",
          8000,
        );
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

    // 11.5（--native）悬浮窗的 Quick Create（实施计划 1.5 的验收）：Enter 创建并排到 Today 末尾、
    // 结束后焦点还给之前的前台窗口；Esc 取消不创建任何数据，回到展开状态。
    if (NATIVE) {
      await step("悬浮窗 Quick Create（原生）", async () => {
        /** 让悬浮窗展开（指针移到徽标上），返回「+ 待办」按钮的中心点。 */
        const openAddButton = async () => {
          const centre = (selector) =>
            floating.evaluate(`(() => { const e = ${selector}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
          return until(async () => {
            const add = await centre("[...document.querySelectorAll('button')].find((b) => ['+ 待办', '+ To-do'].includes(b.textContent.trim()))");
            if (add) return add;
            const badge = await centre("document.querySelector('button')");
            if (badge) await floating.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: badge[0], y: badge[1] });
            return null;
          }, "悬浮窗展开出「+ 待办」");
        };
        const click = async ([x, y]) => {
          await floating.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await floating.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await floating.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        };
        const key = async (name, code) => {
          await floating.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code });
          await floating.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
        };
        const inputReady = "document.hasFocus() && ['标题', 'Title'].includes(document.activeElement?.getAttribute('aria-label')) && !document.activeElement.disabled";

        // Enter 创建。
        const before = foregroundWindow();
        await click(await openAddButton());
        await until(() => floating.evaluate(inputReady), "Quick Create 输入框拿到真实焦点");
        const quickTitle = `e2e-quick-${index}`;
        await floating.send("Input.insertText", { text: quickTitle });
        await key("Enter", 13);
        await until(async () => {
          const today = await main.invoke("get_today");
          return today.todos.at(-1)?.title === quickTitle;
        }, "新待办出现在 Today 末尾");
        await until(() => foregroundWindow() === before, "创建后焦点还给之前的前台窗口", 5000);
        if (await floating.evaluate("document.hasFocus()")) throw new Error("创建后焦点残留在悬浮窗");

        // Esc 取消：不创建任何数据，回到展开状态（底部又出现「+ 待办」）。
        const countBefore = (await main.invoke("get_today")).todos.length;
        await click(await openAddButton());
        await until(() => floating.evaluate(inputReady), "第二次 Quick Create 拿到焦点");
        await floating.send("Input.insertText", { text: "e2e-should-not-exist" });
        await key("Escape", 27);
        await until(() => floating.evaluate("!document.querySelector('[aria-label=标题],[aria-label=Title]')"), "Esc 之后输入框消失");
        await until(() => foregroundWindow() === before, "取消后焦点还给之前的前台窗口", 5000);
        const after = await main.invoke("get_today");
        if (after.todos.length !== countBefore) throw new Error("Esc 之后 Today 的待办数变了");
        if ((await main.invoke("search_items", { query: "e2e-should-not-exist" })).length > 0) throw new Error("Esc 之后仍然创建了条目");
      });
    }

    // 12.（--native）真实按下全局快捷键：搜索框出现、拿到键盘焦点、在工作区内居中，Esc 隐藏，再次出现时输入已清空。
    if (NATIVE) {
      await step("全局搜索快捷键（原生）", async () => {
        const previousForeground = foregroundWindow();
        // 计时从松开按键那一刻开始；第一次包含创建窗口、加载页面与 CDP 连接。
        const firstStarted = pressSearchHotkey();
        const page = await until(async () => (await listPages()).find((p) => p.id !== floating.pageId && p.id !== main.pageId), "搜索窗口页面", 8000).catch(async (e) => {
          throw new Error(`${e.message}；当前页面：${JSON.stringify((await listPages()).map((p) => p.url))}`);
        });
        const search = await connect(page.webSocketDebuggerUrl);
        try {
          const inputFocused = "['搜索关键词', 'Search keywords'].includes(document.activeElement?.getAttribute('aria-label'))";
          await until(() => search.evaluate(`document.visibilityState === 'visible' && document.hasFocus() && ${inputFocused}`), "搜索框可见且输入框拿到键盘焦点", 20000, 5);
          hotkeyTimings.first.push(Date.now() - firstStarted);
          const geometry = await search.evaluate("({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, left: screen.availLeft, top: screen.availTop, aw: screen.availWidth, ah: screen.availHeight })");
          const centre = geometry.x + geometry.w / 2 - (geometry.left + geometry.aw / 2);
          const inside = geometry.x >= geometry.left && geometry.y >= geometry.top && geometry.x + geometry.w <= geometry.left + geometry.aw && geometry.y + geometry.h <= geometry.top + geometry.ah;
          if (!inside || Math.abs(centre) > 24) throw new Error(`位置不对：${JSON.stringify(geometry)}`);

          // 输入一点内容，Esc 隐藏（隐藏要问系统：可见的顶层窗口少一个）。
          const shown = visibleWindowCount(child.pid);
          await search.send("Input.insertText", { text: "e2e" });
          await search.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await search.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await until(() => visibleWindowCount(child.pid) === shown - 1, "Esc 之后搜索框隐藏", 5000).catch((e) => {
            throw new Error(`${e.message}（可见窗口：之前 ${shown}，现在 ${visibleWindowCount(child.pid)}）`);
          });
          if (await search.evaluate("document.hasFocus()")) throw new Error("隐藏后搜索框仍然拿着焦点");
          await until(() => foregroundWindow() === previousForeground, "Esc 之后焦点回到原来的前台窗口", 5000);

          // 再按一次：出现时是干净的、焦点在输入框。
          const againStarted = pressSearchHotkey();
          await until(() => search.evaluate(`document.hasFocus() && document.activeElement?.value === '' && ${inputFocused}`), "再次出现时输入已清空并聚焦", 20000, 5);
          hotkeyTimings.again.push(Date.now() - againStarted);
          await until(() => visibleWindowCount(child.pid) === shown, "再次出现");

          /** 在搜索框里搜 `title` 并回车，等主窗口的详情面板显示它。 */
          const openFromSearch = async (what) => {
            await search.send("Input.insertText", { text: title });
            await until(() => search.evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.textContent.includes(${JSON.stringify(title)}))`), `${what}：结果出现`);
            await search.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await search.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await until(
              () => main.evaluate(`[...document.querySelectorAll('aside input, aside textarea')].some((e) => e.value === ${JSON.stringify(title)})`),
              `${what}：主窗口显示详情`,
            );
          };

          // ① 主窗口开着。
          await openFromSearch("主窗口开着");
          // 点到别处：焦点切到主窗口后搜索框隐藏，并且不会把焦点抢回来。
          const beforeAway = visibleWindowCount(child.pid);
          pressSearchHotkey();
          await until(() => search.evaluate(`document.hasFocus() && ${inputFocused}`), "点别处之前搜索框出现", 20000, 5);
          await until(() => visibleWindowCount(child.pid) === beforeAway + 1, "点别处之前搜索框可见");
          const mainHandle = focusLargestWindow(child.pid);
          await until(() => visibleWindowCount(child.pid) === beforeAway, "焦点离开后搜索框隐藏", 5000);
          await sleep(500);
          if (foregroundWindow() !== mainHandle) throw new Error("搜索框隐藏后焦点没有留在用户点的窗口上");

          // ② 主窗口被关掉（隐藏）：回车要把它重新显示出来。
          closeLargestWindow(child.pid);
          const withoutMain = await until(async () => {
            const n = visibleWindowCount(child.pid);
            return n < shown - 1 ? n : null;
          }, "主窗口被关掉");
          pressSearchHotkey();
          await until(() => search.evaluate(`document.hasFocus() && ${inputFocused}`), "主窗口隐藏时搜索框出现", 20000, 5);
          await openFromSearch("主窗口隐藏");
          // 主窗口回来（+1），搜索框已经隐藏（关掉主窗口时搜索框本来就是隐藏的）。
          await until(() => visibleWindowCount(child.pid) === withoutMain + 1, "主窗口重新显示、搜索框隐藏");
        } finally {
          search.close();
        }
      });
    }
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

/** 结束一个被测进程并等它退干净。 */
async function stopInstance(child) {
  child.kill();
  await sleep(800);
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } catch {
    /* 已退出 */
  }
  await until(() => !testInstanceRunning(), "被测进程退出", 15000);
}

/**
 * （--native）主窗口**从未创建**时在全局搜索框里回车：后端要先创建主窗口，再定位到详情。
 *
 * 同一个数据目录启动两次：第一次（借主窗口）把全局搜索改绑到测试专用的组合、建一条待办后退出；
 * 第二次启动时只有悬浮窗，按快捷键、搜索、回车，主窗口被创建出来并显示那一条。
 */
async function coldMainScenario() {
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-cold-"));
  const env = {
    ...process.env,
    NIVLO_DATA_DIR: join(data, "data"),
    NIVLO_SKIP_FIRST_RUN_PROMPTS: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  const title = "e2e-cold-main";
  try {
    // 第一次启动：准备数据。
    let child = spawn(EXE, [], { env, stdio: "ignore" });
    try {
      const [floatingPage] = await until(async () => {
        const pages = await listPages();
        return pages.length >= 1 ? pages : null;
      }, "悬浮窗页面");
      // 等悬浮窗渲染出来（应用启动完成）再启动第二个进程，单实例转交才会被处理。
      const floating = await connect(floatingPage.webSocketDebuggerUrl);
      await until(() => floating.evaluate("document.getElementById('root')?.children.length > 0"), "悬浮窗渲染");
      floating.close();
      spawn(EXE, [], { env, stdio: "ignore" }).on("error", () => {});
      const page = await until(async () => (await listPages()).find((x) => x.id !== floatingPage.id), "主窗口页面");
      const main = await connect(page.webSocketDebuggerUrl);
      await until(() => main.evaluate("!!window.__TAURI_INTERNALS__"), "主窗口就绪");
      await main.invoke("set_shortcut", { action: "search", accelerator: "Ctrl+Alt+Shift+F9" });
      await main.invoke("quick_create", { request: { itemType: "todo", title, scheduled: null } });
      main.close();
    } finally {
      await stopInstance(child);
    }

    // 第二次启动：只有悬浮窗。
    child = spawn(EXE, [], { env, stdio: "ignore" });
    try {
      const [floatingPage] = await until(async () => {
        const pages = await listPages();
        return pages.length >= 1 ? pages : null;
      }, "第二次启动的悬浮窗页面");
      await until(async () => (await listPages()).length === 1, "启动时只有悬浮窗");
      pressSearchHotkey();
      const searchPage = await until(async () => (await listPages()).find((x) => x.id !== floatingPage.id), "搜索窗口页面");
      const search = await connect(searchPage.webSocketDebuggerUrl);
      await until(() => search.evaluate("document.hasFocus() && document.activeElement?.getAttribute('role') === 'combobox'"), "搜索框拿到焦点", 20000, 5);
      await search.send("Input.insertText", { text: title });
      await until(() => search.evaluate(`[...document.querySelectorAll('[role=option]')].some((o) => o.textContent.includes(${JSON.stringify(title)}))`), "结果出现");
      await search.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await search.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      search.close();
      const mainPage = await until(async () => (await listPages()).find((x) => x.id !== floatingPage.id && x.id !== searchPage.id), "主窗口被创建");
      const main = await connect(mainPage.webSocketDebuggerUrl);
      await until(
        () => main.evaluate(`[...document.querySelectorAll('aside input, aside textarea')].some((e) => e.value === ${JSON.stringify(title)})`),
        "新建的主窗口显示详情",
      );
      main.close();
    } finally {
      await stopInstance(child);
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}

/** 进程 `pid` 及其全部子孙进程（WebView2 的浏览器与渲染进程）的工作集之和，MB。 */
function treeWorkingSetMb(pid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize; $ids = @(${pid}); $added = $true; while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }; [math]::Round((($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim());
}

/**
 * （--native）「预先准备全局搜索框」：开启后重启，启动约 10 秒后后台出现隐藏的搜索窗口；
 * 第一次按快捷键的耗时与多占的内存都记下来。
 */
async function prewarmScenario() {
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-prewarm-"));
  const env = {
    ...process.env,
    NIVLO_DATA_DIR: join(data, "data"),
    NIVLO_SKIP_FIRST_RUN_PROMPTS: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  try {
    let child = spawn(EXE, [], { env, stdio: "ignore" });
    try {
      const [floatingPage] = await until(async () => {
        const pages = await listPages();
        return pages.length >= 1 ? pages : null;
      }, "悬浮窗页面");
      const floating = await connect(floatingPage.webSocketDebuggerUrl);
      await until(() => floating.evaluate("document.getElementById('root')?.children.length > 0"), "悬浮窗渲染");
      floating.close();
      spawn(EXE, [], { env, stdio: "ignore" }).on("error", () => {});
      const page = await until(async () => (await listPages()).find((x) => x.id !== floatingPage.id), "主窗口页面");
      const main = await connect(page.webSocketDebuggerUrl);
      await until(() => main.evaluate("!!window.__TAURI_INTERNALS__"), "主窗口就绪");
      await main.invoke("set_shortcut", { action: "search", accelerator: "Ctrl+Alt+Shift+F9" });
      await main.invoke("set_search_prewarm", { enabled: true });
      main.close();
    } finally {
      await stopInstance(child);
    }

    child = spawn(EXE, [], { env, stdio: "ignore" });
    try {
      const [floatingPage] = await until(async () => {
        const pages = await listPages();
        return pages.length >= 1 ? pages : null;
      }, "第二次启动的悬浮窗页面");
      const floating = await connect(floatingPage.webSocketDebuggerUrl);
      await until(() => floating.evaluate("document.getElementById('root')?.children.length > 0"), "悬浮窗渲染");
      floating.close();
      await sleep(3000);
      const before = treeWorkingSetMb(child.pid);
      const visibleBefore = visibleWindowCount(child.pid);
      // 预先创建发生在启动后约 10 秒；窗口隐藏，所以可见窗口数不变。
      const searchPage = await until(async () => (await listPages()).find((x) => x.id !== floatingPage.id), "预先创建的搜索窗口", 30000);
      const search = await connect(searchPage.webSocketDebuggerUrl);
      await until(() => search.evaluate("document.getElementById('root')?.children.length > 0"), "搜索框页面加载完成");
      if (visibleWindowCount(child.pid) !== visibleBefore) throw new Error("预先创建的搜索窗口不应该显示出来");
      await sleep(3000);
      const after = treeWorkingSetMb(child.pid);

      const started = pressSearchHotkey();
      await until(
        () => search.evaluate("document.hasFocus() && document.activeElement?.getAttribute('role') === 'combobox'"),
        "按快捷键后预先创建的搜索框拿到焦点",
        20000,
        5,
      );
      const firstMs = Date.now() - started;
      search.close();
      return { firstMs, extraMb: after - before };
    } finally {
      await stopInstance(child);
    }
  } finally {
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
if (NATIVE) {
  try {
    await coldMainScenario();
    console.log("✓ 主窗口未创建时从全局搜索框回车打开结果");
  } catch (e) {
    failed += 1;
    console.error(`✗ 主窗口未创建时从全局搜索框回车打开结果：${e.message}`);
  }
}
if (NATIVE) {
  try {
    const { firstMs, extraMb } = await prewarmScenario();
    console.log(`✓ 预先准备全局搜索框：第一次唤出 ${firstMs} ms，进程树多占约 ${extraMb} MB`);
  } catch (e) {
    failed += 1;
    console.error(`✗ 预先准备全局搜索框：${e.message}`);
  }
}
if (NATIVE && hotkeyTimings.first.length > 0) {
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`全局搜索唤出（按键之后到输入框拿到焦点）：第一次 中位数 ${median(hotkeyTimings.first)} ms ${JSON.stringify(hotkeyTimings.first)}；之后 中位数 ${median(hotkeyTimings.again)} ms ${JSON.stringify(hotkeyTimings.again)}`);
}
process.exit(failed ? 1 : 0);
