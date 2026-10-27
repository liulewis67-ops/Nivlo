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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** Quick Create 从点「+ 待办」/ 按快捷键到输入框可以打字（毫秒），实施计划 1.5「Hover → Enter 3 秒内」里系统自己的那部分。 */
const quickCreateTimings = { click: [], hotkey: [] };

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
const WIN32 = `Add-Type -Namespace E2E -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, System.UIntPtr extra); public struct POINT { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l); public delegate bool EnumProc(System.IntPtr h, System.IntPtr p); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }'`;

/** 运行一段带 Win32 声明的 PowerShell，返回去掉首尾空白的输出。 */
function win32(body) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${WIN32}; ${body}`], { encoding: "utf8", timeout: 30000 }).trim();
}

/** 真实光标的位置（物理像素）。 */
function cursorPosition() {
  const [x, y] = win32("[void][E2E.Native]::SetProcessDPIAware(); $p = New-Object E2E.Native+POINT; [void][E2E.Native]::GetCursorPos([ref]$p); \"$($p.X),$($p.Y)\"")
    .split(",")
    .map(Number);
  return [x, y];
}

/** 把真实光标移到 (x, y)（物理像素），可选再按一下左键。 */
function realMouse(x, y, click = false) {
  const down = click ? "; [E2E.Native]::mouse_event(0x2, 0, 0, 0, [System.UIntPtr]::Zero); [E2E.Native]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)" : "";
  win32(`[void][E2E.Native]::SetProcessDPIAware(); [void][E2E.Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})${down}`);
}

/**
 * 用真实鼠标从 `from` 拖到 `to`（物理像素）：按下、分 12 步移动、停一下再松开。
 * 整个过程在一次 PowerShell 里完成（每次启动 PowerShell 约 2 秒，分开调用会让拖动停顿太久）。
 */
function realDrag(from, to) {
  const steps = 12;
  const moves = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return `[void][E2E.Native]::SetCursorPos(${Math.round(from[0] + (to[0] - from[0]) * t)}, ${Math.round(from[1] + (to[1] - from[1]) * t)}); Start-Sleep -Milliseconds 40`;
  }).join("; ");
  win32(
    `[void][E2E.Native]::SetProcessDPIAware(); [void][E2E.Native]::SetCursorPos(${Math.round(from[0])}, ${Math.round(from[1])}); [E2E.Native]::mouse_event(0x2, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 150; ${moves}; Start-Sleep -Milliseconds 250; [E2E.Native]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)`,
  );
}

/** 前台窗口所属的进程与标题（诊断用）。 */
const foregroundOwner = () =>
  win32("$h = [E2E.Native]::GetForegroundWindow(); $id = 0; [void][E2E.Native]::GetWindowThreadProcessId($h, [ref]$id); $p = Get-Process -Id $id -ErrorAction SilentlyContinue; \"$id $($p.ProcessName) $($p.MainWindowTitle)\"");

/** 把窗口 `handle` 设为前台（先按一下 Alt：系统只允许刚收到输入的进程切换前台）。 */
const focusWindow = (handle) =>
  win32(`[E2E.Native]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero); [void][E2E.Native]::SetForegroundWindow([System.IntPtr]${handle})`);

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

/** 用 keybd_event 依次按下 `keys`（虚拟键码）再倒序松开；返回松开那一刻的时间（Unix 毫秒）。 */
function pressHotkey(keys) {
  const script = [
    `$keys = ${keys.map((k) => "0x" + k.toString(16)).join(", ")}`,
    "foreach ($k in $keys) { [E2E.Native]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }",
    "[array]::Reverse($keys)",
    "foreach ($k in $keys) { [E2E.Native]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }",
    "[DateTimeOffset]::Now.ToUnixTimeMilliseconds()",
  ].join("; ");
  return Number(win32(script));
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
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000 }).trim());
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

/** 单个 CDP 请求最多等多久（毫秒）。 */
const CDP_TIMEOUT_MS = 15000;

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
  // 每个请求都有超时：页面卡住（例如 alert、渲染进程挂起）时报出是哪个请求，而不是整轮测试无声地挂起。
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++n;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`CDP 请求超时：${method} ${JSON.stringify(params).slice(0, 120)}`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, (d) => {
        clearTimeout(timer);
        res(d);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      const details = r.result.exceptionDetails;
      throw new Error((details.exception?.description ?? JSON.stringify(details.exception ?? details)).slice(0, 600));
    }
    return r.result?.result?.value;
  };
  const invoke = (cmd, args = {}) =>
    // 后端错误是对象：转成 JSON 字符串再抛出，失败信息里能看到完整的 code 与 message。
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).catch((e) => { throw new Error(${JSON.stringify(cmd)} + ": " + JSON.stringify(e)); })`);
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
  // 正在退出的进程可能读不到路径：读不到的也算在运行，宁可多等一会儿。
  const quoted = `'${EXE.replaceAll("'", "''")}'`;
  const script = `@(Get-Process -Name nivlo-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${quoted} -or -not $_.Path }).Count`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000 }).trim()) > 0;
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
    // 进度写到 stderr：管道里只看最后的 ✓ / ✗，卡住时日志里能看出停在哪一步。
    console.error(`  … ${index} ${name}`);
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
        const addButton = await openAddButton();
        const clicked = Date.now();
        await click(addButton);
        await until(() => floating.evaluate(inputReady), "Quick Create 输入框拿到真实焦点", 20000, 5);
        quickCreateTimings.click.push(Date.now() - clicked);
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

    // 11.6（--native）Quick Create 的全局快捷键（实施计划 2.6）：其他应用在前台时按下，输入、回车，
    // 创建后焦点回到之前的应用。改绑到测试专用组合，避免和本机正在用的 Nivlo 冲突。
    if (NATIVE) {
      await step("Quick Create 快捷键（原生）", async () => {
        await main.invoke("set_shortcut", { action: "quickCreate", accelerator: "Ctrl+Alt+Shift+F8" });
        const before = foregroundWindow();
        const pressed = pressHotkey([0x11, 0x12, 0x10, 0x77]);
        const inputReady = "document.hasFocus() && ['标题', 'Title'].includes(document.activeElement?.getAttribute('aria-label')) && !document.activeElement.disabled";
        await until(() => floating.evaluate(inputReady), "快捷键呼出的 Quick Create 拿到焦点", 20000, 5);
        quickCreateTimings.hotkey.push(Date.now() - pressed);
        const viaHotkey = `e2e-hotkey-${index}`;
        await floating.send("Input.insertText", { text: viaHotkey });
        await floating.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await floating.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await until(async () => (await main.invoke("get_today")).todos.at(-1)?.title === viaHotkey, "快捷键创建的待办出现在 Today 末尾");
        await until(() => foregroundWindow() === before, "创建后焦点回到之前的应用", 5000);
      });

      // 11.7（--native）真实鼠标（实施计划 10.2）：悬停展开、点面板标题、点 Today 项的完成框，都不抢焦点。
      await step("悬浮窗不抢焦点（真实鼠标）", async () => {
        const original = cursorPosition();
        try {
          // 真实用户点悬浮窗时，前台是别的应用；悬浮窗只会把焦点还给「其他进程」的窗口。
          // 所以先切回测试开始时用户所在的窗口（像用户回到自己的应用一样）。
          const alive = async (when) => {
            for (const [name, page] of [["主窗口", main], ["悬浮窗", floating]]) {
              await page.evaluate("1").catch((e) => {
                throw new Error(`${when}${name}不响应（前台 ${foregroundOwner()}，USER_FOREGROUND ${USER_FOREGROUND}）：${e.message.slice(0, 60)}`);
              });
            }
          };
          await alive("切换前台之前");
          focusWindow(USER_FOREGROUND);
          await until(() => foregroundWindow() === USER_FOREGROUND, "前台回到测试开始时的应用", 5000);
          await alive("切换前台之后");
          const before = foregroundWindow();
          /** 元素中心的屏幕物理坐标。 */
          const screenPoint = (selector) =>
            floating.evaluate(`(() => { const e = ${selector}; if (!e) return null; const r = e.getBoundingClientRect(); const k = window.devicePixelRatio; return [(window.screenX + r.x + r.width / 2) * k, (window.screenY + r.y + r.height / 2) * k]; })()`);
          /** 真实光标移到元素上，并确认浏览器认为它在悬停（坐标换算错了会在这里发现）。 */
          const hover = async (selector, what) => {
            const point = await until(() => screenPoint(selector), `${what}：找到元素`);
            realMouse(point[0], point[1]);
            await until(() => floating.evaluate(`(${selector})?.matches(':hover')`), `${what}：光标在元素上`, 5000);
            return point;
          };
          const panel = "document.querySelector(\"[aria-label='今日面板'],[aria-label='Today panel']\")";
          // 诊断：悬浮窗页面不再响应 CDP 时，记下当时的窗口、主窗口是否还响应、过一会儿会不会恢复，以及应用日志。
          const panelOpen = await floating.evaluate(`!!${panel}`).catch(async (e) => {
            const mainAlive = await main.evaluate("1").then(() => "是", (err) => err.message.slice(0, 40));
            await sleep(10000);
            const later = await floating.evaluate("1").then(() => "恢复了", (err) => err.message.slice(0, 40));
            const logs = readdirSync(join(data, "data", "logs")).map((f) => readFileSync(join(data, "data", "logs", f), "utf8")).join("\n");
            const tail = logs.split("\n").filter((l) => /floating|focus|foreground|WARN|ERROR/.test(l)).slice(-10).join(" | ");
            throw new Error(`${e.message}；可见窗口 ${visibleWindowCount(child.pid)}，前台 ${foregroundOwner()}，主窗口响应：${mainAlive}，10 秒后悬浮窗：${later}；日志：${tail}`);
          });
          if (!panelOpen) {
            await hover("document.querySelector('button')", "徽标");
            await until(() => floating.evaluate(`!!${panel}`), "真实悬停展开面板", 5000);
          }
          const title = `${panel}?.querySelector('h2')`;
          const titlePoint = await hover(title, "面板标题");
          realMouse(titlePoint[0], titlePoint[1], true);
          await sleep(500);
          if (foregroundWindow() !== before) {
            const logs = readdirSync(join(data, "data", "logs")).map((f) => readFileSync(join(data, "data", "logs", f), "utf8")).join("\n");
            const relevant = logs.split("\n").filter((l) => /floating_focus|foreground/.test(l)).slice(-8).join(" | ");
            throw new Error(`点面板标题抢走了焦点：现在的前台是 ${foregroundOwner()}（被测进程 ${child.pid}，悬浮窗有焦点：${await floating.evaluate("document.hasFocus()")}；之前的前台是 ${before}）日志：${relevant || "（没有相关日志）"}`);
          }

          // 用真实鼠标打开「更多操作」菜单：焦点被还回去之后菜单仍然开着，点「推迟到明天」照样生效。
          const quick = `e2e-quick-${index}`;
          const more = `[...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").includes(${JSON.stringify(quick)}) && /更多操作|More actions/.test(b.getAttribute("aria-label")))`;
          // 记录点击前后页面收到的事件：菜单被关掉时据此判断是谁关的。
          const recordEvents = () => {
            const events = [];
            const t0 = performance.now();
            const name = (t) => (t === window ? "window" : t === document ? "document" : (t?.getAttribute?.("role") ?? t?.tagName ?? "?"));
            const log = (text) => events.push(`${Math.round(performance.now() - t0)} ${text}`);
            for (const type of ["blur", "focus", "focusin", "focusout", "pointerdown", "pointerup", "keydown", "pointerleave", "visibilitychange"]) {
              window.addEventListener(type, (e) => log(`${type} ${name(e.target)}`), { capture: true });
            }
            let open = false;
            new MutationObserver(() => {
              const now = !!document.querySelector("[role=menu]");
              if (now !== open) log(`menu ${(open = now)}`);
            }).observe(document.body, { childList: true, subtree: true });
            window.__e2eEvents = events;
          };
          await floating.evaluate(`(${recordEvents})()`);
          const morePoint = await hover(more, "更多操作按钮");
          realMouse(morePoint[0], morePoint[1], true);
          await until(() => floating.evaluate("!!document.querySelector('[role=menu]')"), "菜单打开", 5000);
          await sleep(500);
          if (!(await floating.evaluate("!!document.querySelector('[role=menu]')"))) {
            throw new Error(`焦点还回去之后菜单被关掉了；事件：${await floating.evaluate("window.__e2eEvents.join(' | ')")}`);
          }
          if (foregroundWindow() !== before) throw new Error("打开菜单抢走了焦点");
          const tomorrow = "[...document.querySelectorAll('[role=menuitem]')].find((m) => /推迟到明天|Tomorrow/.test(m.textContent))";
          const tomorrowPoint = await hover(tomorrow, "「推迟到明天」");
          realMouse(tomorrowPoint[0], tomorrowPoint[1], true);
          await until(async () => !(await main.invoke("get_today")).todos.some((i) => i.title === quick), "点菜单项把待办推迟到明天");
          if (foregroundWindow() !== before) throw new Error("点菜单项抢走了焦点");

          const target = `e2e-hotkey-${index}`;
          const box = `[...document.querySelectorAll('[role=checkbox]')].find((b) => (b.getAttribute('aria-label') ?? '').includes(${JSON.stringify(target)}))`;
          const boxPoint = await hover(box, "完成框");
          realMouse(boxPoint[0], boxPoint[1], true);
          await until(async () => (await main.invoke("get_today")).completed.some((i) => i.title === target), "点完成框完成了待办");
          await sleep(300);
          if (foregroundWindow() !== before) throw new Error("点完成框抢走了焦点");

          // 拖动排序：按下时 WebView2 会激活悬浮窗，60ms 后前台被还回去——此时左键还按着，
          // 拖动不能因此被取消（失去前台可能让指针捕获失效、收到 pointercancel）。
          const first = `e2e-drag-a-${index}`;
          const second = `e2e-drag-b-${index}`;
          for (const dragTitle of [first, second]) {
            await main.invoke("quick_create", { request: { itemType: "todo", title: dragTitle, scheduled: null } });
          }
          const handle = (dragTitle) => `[...document.querySelectorAll("[aria-label]")].find((e) => /拖动以调整|Drag to reorder/.test(e.getAttribute("aria-label")) && e.getAttribute("aria-label").includes(${JSON.stringify(dragTitle)}))`;
          const from = await hover(handle(second), "第二条的拖动手柄");
          const to = await until(() => screenPoint(handle(first)), "第一条的拖动手柄");
          realDrag(from, [to[0], to[1] - 6]);
          await until(async () => {
            const titles = (await main.invoke("get_today")).todos.map((i) => i.title);
            return titles.indexOf(second) >= 0 && titles.indexOf(second) < titles.indexOf(first);
          }, "拖动把第二条排到第一条前面", 8000).catch(async (e) => {
            throw new Error(`${e.message}（Today：${JSON.stringify((await main.invoke("get_today")).todos.map((i) => i.title))}）`);
          });
          if (foregroundWindow() !== before) throw new Error("拖动排序抢走了焦点");
        } finally {
          realMouse(original[0], original[1]);
        }
      });

      // 11.8（--native）资源管理器式拖放（实施计划 10.1 / 发布阻塞项 A2）：真实的 OLE 拖放把两个文件
      // （CF_HDROP，资源管理器拖文件用的格式）放到悬浮窗上，页面拿到磁盘路径，各建一条带文件附件的条目。
      await step("拖入文件（真实 OLE 拖放）", async () => {
        const original = cursorPosition();
        try {
          // 一个普通文件、一个带中文与空格的文件、一个文件夹（拖放矩阵里文件夹一项此前未验证）。
          const names = [`e2e-ole-a-${index}.txt`, `e2e-ole-b-${index} 中文 名.txt`, `e2e-ole-dir-${index}`];
          const paths = names.map((name) => join(data, name));
          writeFileSync(paths[0], "ole drop");
          writeFileSync(paths[1], "ole drop");
          mkdirSync(paths[2]);
          const target = await until(
            () => floating.evaluate("(() => { const k = window.devicePixelRatio; return [(window.screenX + window.innerWidth / 2) * k, (window.screenY + window.innerHeight / 2) * k]; })()"),
            "悬浮窗的位置",
          );
          // 从悬浮窗左边（放不下就右边）开始拖。
          const from = [target[0] > 400 ? target[0] - 300 : target[0] + 300, target[1]];
          const quote = (text) => `'${text.replaceAll("'", "''")}'`;
          /** 用 ole-drag.ps1 做一次真实拖放；`payload` 是它的数据参数（如 `-Files 'a','b'`）。 */
          const oleDrag = (payload) => {
            const result = execFileSync(
              "powershell",
              [
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                `& ${quote(join(ROOT, "tests", "e2e", "ole-drag.ps1"))} ${payload} -FromX ${Math.round(from[0])} -FromY ${Math.round(from[1])} -ToX ${Math.round(target[0])} -ToY ${Math.round(target[1])}`,
              ],
              { encoding: "utf8", timeout: 30000 },
            ).trim();
            if (result === "None" || result === "NotStarted") throw new Error(`拖放没有被接受（${payload}）：${result}`);
          };
          oleDrag(`-Files ${paths.map(quote).join(",")}`);
          // 每一项都建成条目，并且附件引用的是磁盘上的真实路径（不是只拿到了文件名）。
          for (const [i, name] of names.entries()) {
            const key = name.split(" ")[0].replace(".txt", "");
            const item = await until(async () => (await main.invoke("search_items", { query: key }))[0], `拖入的 ${name} 建成了条目`, 10000);
            const detail = await main.invoke("get_item_detail", { id: item.id });
            const attached = detail.attachments.map((a) => a.path.toLowerCase());
            if (!attached.includes(paths[i].toLowerCase())) {
              throw new Error(`${name} 的附件路径不对：${JSON.stringify(detail.attachments.map((a) => a.path))}，应为 ${paths[i]}`);
            }
          }

          // 编辑器里拖选中的文字（CF_UNICODETEXT）→ 待办；浏览器拖链接（UniformResourceLocatorW）→ 笔记。
          const text = `e2eoletext${index} 回复邮件`;
          oleDrag(`-Text ${quote(text)}`);
          const todo = await until(async () => (await main.invoke("search_items", { query: `e2eoletext${index}` }))[0], "拖入的文字建成了条目", 10000);
          if (todo.itemType !== "todo" || todo.title !== text) throw new Error(`拖入的文字应建成同名待办：${JSON.stringify([todo.itemType, todo.title])}`);
          const url = `https://example.com/e2eolelink${index}`;
          oleDrag(`-Url ${quote(url)}`);
          const note = await until(async () => (await main.invoke("search_items", { query: `e2eolelink${index}` }))[0], "拖入的链接建成了条目", 10000);
          if (note.itemType !== "note") throw new Error(`拖入的链接应建成笔记：${JSON.stringify([note.itemType, note.title])}`);
        } finally {
          realMouse(original[0], original[1]);
        }
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

          // Ctrl+D（P1.3）：在搜索框里直接完成选中的待办，窗口不关；提示还在时 Ctrl+Z 撤销。
          // 走真实的 search.json 权限，缺了 complete_item / reopen_item 会在这里失败。
          const doneTitle = `e2e-search-done-${index}`;
          await main.invoke("quick_create", { request: { itemType: "todo", title: doneTitle, scheduled: null } });
          await search.send("Input.insertText", { text: doneTitle });
          await until(() => search.evaluate(`[...document.querySelectorAll("[role=option]")].some((o) => o.textContent.includes(${JSON.stringify(doneTitle)}))`), "Ctrl+D：结果出现");
          /** Ctrl + 字母（CDP 的 modifiers 2 是 Ctrl）。 */
          const ctrlLetter = async (letter) => {
            const event = { key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers: 2 };
            await search.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
            await search.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
          };
          const doneStatus = async () => (await main.invoke("search_items", { query: doneTitle })).find((i) => i.title === doneTitle)?.status;
          await ctrlLetter("d");
          // 撤销提示只留 5 秒（DONE_UNDO_MS）：出现之后立刻按 Ctrl+Z，慢的 Win32 检查（每次约 2 秒）放到后面。
          await until(() => search.evaluate("document.body.innerText.includes('Ctrl+Z')"), "Ctrl+D 之后出现撤销");
          if ((await doneStatus()) !== "done") throw new Error("出现了撤销提示，但待办没有完成");
          await ctrlLetter("z");
          await until(async () => (await doneStatus()) !== "done", "Ctrl+Z 撤销了完成", 5000).catch(async (e) => {
            const page = await search.evaluate("JSON.stringify({ focus: document.hasFocus(), footer: document.querySelector('footer')?.innerText, input: document.activeElement?.value ?? document.activeElement?.tagName })");
            throw new Error(`${e.message}；搜索框：${page}；状态：${await doneStatus()}`);
          });
          if (visibleWindowCount(child.pid) !== shown) throw new Error("Ctrl+D / Ctrl+Z 之后搜索框被关掉了");
          // 选中输入框里的文字，下面的 openFromSearch 输入时直接替换掉。
          await search.evaluate("document.activeElement.select()");

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
    // 等进程真正退出再删数据目录：退出中的进程仍持有单实例锁，下一轮的启动会被转交给它。
    await stopInstance(child);
    rmSync(data, { recursive: true, force: true });
  }
}

/** 结束一个被测进程并等它退干净。 */
async function stopInstance(child) {
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await sleep(800);
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  } catch {
    /* 已退出 */
  }
  await Promise.race([exited, sleep(15000)]);
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
      // 重启后条目仍在（实施计划 1.5）：上一次是被强制结束的（taskkill /F），Today 里照样有它。
      const restarted = await connect(floatingPage.webSocketDebuggerUrl);
      await until(async () => (await restarted.invoke("get_today")).todos.some((i) => i.title === title), "强制结束再启动后 Today 里仍有这条待办");
      restarted.close();
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
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000 }).trim());
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

/** 测试开始时用户所在的前台窗口（属于别的进程）。 */
const USER_FOREGROUND = NATIVE ? foregroundWindow() : "0";

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
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
if (NATIVE && quickCreateTimings.click.length > 0) {
  console.log(`Quick Create 输入就绪：点「+ 待办」中位数 ${median(quickCreateTimings.click)} ms ${JSON.stringify(quickCreateTimings.click)}；快捷键 中位数 ${median(quickCreateTimings.hotkey)} ms ${JSON.stringify(quickCreateTimings.hotkey)}`);
}
if (NATIVE && hotkeyTimings.first.length > 0) {
  console.log(`全局搜索唤出（按键之后到输入框拿到焦点）：第一次 中位数 ${median(hotkeyTimings.first)} ms ${JSON.stringify(hotkeyTimings.first)}；之后 中位数 ${median(hotkeyTimings.again)} ms ${JSON.stringify(hotkeyTimings.again)}`);
}
process.exit(failed ? 1 : 0);
