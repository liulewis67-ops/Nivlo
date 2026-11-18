#!/usr/bin/env node
// 桌面端 E2E 关键路径（实施计划 7.1）：启动真实的发布版程序（临时数据目录），通过 WebView2 的调试端口
// （CDP）驱动界面与 IPC，覆盖：应用启动、Hover 悬浮窗、Quick Add、完成 Todo、拖入文件、排期，
// 以及搜索相关的优化：拼音首字母（迁移 0008）、最近使用（迁移 0007）、结果标签、快捷键停用 / 启用、
// 从命令打开主窗口的视图。
//
// 用法：node tests/e2e/e2e.mjs [--runs N] [--native]    需要先构建：pnpm tauri build --no-bundle（仅 Windows / WebView2）
// M4 evidence: --native --runs 3 --warm-runs 20 --zoom --badge-matrix
// Saves native screenshots, source/executable hashes and timings under tests/visual/stages/m4/native.
// Focused native repros: --native --zoom-only / --ole-only / --badge-only / --context-create-only.
// App-specific native checks: --native --browser-drop-only / --explorer-drop-only / --ime-only.
// Floating panel drag with a real mouse: --panel-drag-only.
// --native：额外用真实按键（SendInput）按全局快捷键，检查全局搜索框的原生行为（出现、拿到键盘焦点、位置、
// Esc 隐藏、再次出现时是干净的）。会向系统发送一次 Ctrl+Alt+Shift+F9（被测程序注册的组合，别的程序收不到），
// 所以默认不跑，CI 也不跑。
// 说明：计划里写的是 tauri-driver（WebDriver）；这里用 CDP 是因为它不需要额外下载 msedgedriver，
// 且已经在真机验收里验证过。每次运行都使用全新的数据目录，互不影响。

import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.env.NIVLO_EXE ?? join(ROOT, "target", "release", process.platform === "win32" ? "nivlo-desktop.exe" : "nivlo-desktop");
const PORT = 9244;
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 1;
const NATIVE = process.argv.includes("--native");
const CONTEXT_CREATE_ONLY = process.argv.includes("--context-create-only");
const BROWSER_DROP_ONLY = process.argv.includes("--browser-drop-only");
const EXPLORER_DROP_ONLY = process.argv.includes("--explorer-drop-only");
const IME_ONLY = process.argv.includes("--ime-only");
if (CONTEXT_CREATE_ONLY && !NATIVE) throw Error("--context-create-only requires --native");
if (BROWSER_DROP_ONLY && !NATIVE) throw Error("--browser-drop-only requires --native");
if (EXPLORER_DROP_ONLY && !NATIVE) throw Error("--explorer-drop-only requires --native");
if (IME_ONLY && !NATIVE) throw Error("--ime-only requires --native");
const WARM_RUNS = process.argv.includes("--warm-runs") ? Math.max(0,Number(process.argv[process.argv.indexOf("--warm-runs")+1])||0) : 0;
const PANEL_DRAG_ONLY = process.argv.includes("--panel-drag-only");
const DRAG_ONLY = process.argv.includes("--drag-only") || PANEL_DRAG_ONLY;
const DRAG_STEPS = process.argv.includes("--drag-steps") ? Math.max(1,Number(process.argv[process.argv.indexOf("--drag-steps")+1])||6) : 6;
const SEARCH_ZOOM_ONLY = process.argv.includes("--search-zoom-only");
const OLE_ONLY = process.argv.includes("--ole-only");
const BADGE_ONLY = process.argv.includes("--badge-only");
const ZOOM_ONLY = process.argv.includes("--zoom-only");
const CHECK_ZOOM = process.argv.includes("--zoom") || ZOOM_ONLY;
const BADGE_MATRIX = process.argv.includes("--badge-matrix") || BADGE_ONLY;
const FOCUSED_RUN = ZOOM_ONLY || OLE_ONLY || BADGE_ONLY || SEARCH_ZOOM_ONLY || DRAG_ONLY || CONTEXT_CREATE_ONLY || BROWSER_DROP_ONLY || EXPLORER_DROP_ONLY || IME_ONLY;
const badgeScaleFlag = process.argv.indexOf("--badge-scale");
const badgeScale = badgeScaleFlag < 0 ? null : Number(process.argv[badgeScaleFlag + 1]);
if (badgeScale !== null && (!NATIVE || !BADGE_MATRIX || ![100, 125].includes(badgeScale))) {
  throw Error("--badge-scale requires --native and --badge-only or --badge-matrix, with 100 or 125");
}
const warmActivations = [];
const zoomRecords = [];
const badgeRecords = [];
const runtimeEnvironments = [];
const EVIDENCE_STAGE = process.argv.includes('--evidence-stage') ? process.argv[process.argv.indexOf('--evidence-stage')+1] : 'm4';
if(!['m4','m5'].includes(EVIDENCE_STAGE))throw Error('Evidence stage must be m4 or m5');
const EVIDENCE = process.env.NIVLO_E2E_EVIDENCE_DIR ?? join(ROOT,'tests','visual','stages',EVIDENCE_STAGE,'native');
if (CHECK_ZOOM || WARM_RUNS || BADGE_MATRIX || SEARCH_ZOOM_ONLY) mkdirSync(EVIDENCE,{recursive:true});
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

/**
 * 运行一段带 Win32 声明的 PowerShell，返回去掉首尾空白的输出。
 *
 * 所有 PowerShell 都以 `windowsHide` 启动：否则它的控制台窗口会短暂抢到前台，关掉之后系统把前台交给
 * 启动测试的那个应用——被测程序自己的窗口在前台时，焦点相关的断言就会被测试本身破坏。
 */
function win32(body) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `${WIN32}; ${body}`], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
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

/** 长按选中徽标要按住的时间（毫秒）：比 UI 的 LONG_PRESS_MS（400）多留余量。 */
const LONG_PRESS_HOLD_MS = 650;

/**
 * 用真实鼠标从 `from` 拖到 `to`（物理像素）：默认分 12 步；快速拖动复现用 6 步。
 * 按下后先按住 `holdMs` 再移动：徽标要长按选中才能拖动，默认按长按处理。
 * 整个过程在一次 PowerShell 里完成（每次启动 PowerShell 约 2 秒，分开调用会让拖动停顿太久）。
 */
function realDrag(from, to, steps = 12, holdMs = LONG_PRESS_HOLD_MS) {
  const moves = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return `[void][E2E.Native]::SetCursorPos(${Math.round(from[0] + (to[0] - from[0]) * t)}, ${Math.round(from[1] + (to[1] - from[1]) * t)}); Start-Sleep -Milliseconds 40`;
  }).join("; ");
  win32(
    `[void][E2E.Native]::SetProcessDPIAware(); [void][E2E.Native]::SetCursorPos(${Math.round(from[0])}, ${Math.round(from[1])}); [E2E.Native]::mouse_event(0x2, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds ${holdMs}; ${moves}; Start-Sleep -Milliseconds 250; [E2E.Native]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)`,
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
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim());
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
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim()) > 0;
}

/**
 * 别处的 Nivlo（用户自己装的、正在用的那个）有没有在运行：路径能读到、但不是被测程序。
 *
 * Nivlo 只允许一个实例，测试启动的程序会被转交给已经在运行的那个——测试就会在**用户真实的数据**里
 * 建条目、改快捷键。发现时直接停下，而不是继续。
 *
 * @returns 那个进程的路径；没有时为 `null`。
 */
function foreignInstance() {
  const quoted = `'${EXE.replaceAll("'", "''")}'`;
  const script = `(Get-Process -Name nivlo-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -ne ${quoted} } | Select-Object -First 1).Path`;
  const path = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
  return path === "" ? null : path;
}

/** 有别处的 Nivlo 在运行时拒绝启动被测程序（见 [`foreignInstance`]）。 */
function ensureNoForeignInstance() {
  const other = foreignInstance();
  if (other !== null) {
    throw new Error(`另一个 Nivlo 正在运行（${other}）：测试启动的程序会被转交给它、写进它的数据。请先退出它再运行 E2E。`);
  }
}

async function checkNativeSearchZoom({main,floating,index}) {
  await main.invoke('quick_create',{request:{itemType:'todo',title:'zoom-search-fixture',scheduled:null}});
  await main.invoke('set_shortcut',{action:'search',accelerator:'Ctrl+Alt+Shift+F9'});
  pressSearchHotkey();
  const target=await until(async()=>(await listPages()).find(p=>p.id!==main.pageId&&p.id!==floating.pageId),'search zoom page');
  const search=await connect(target.webSocketDebuggerUrl);
  try {
    await until(()=>search.evaluate('document.hasFocus() && document.activeElement?.getAttribute("role")==="combobox"'),'search zoom focus');
    await search.send('Input.insertText',{text:'zoom-search-fixture'});
    await until(()=>search.evaluate('!!document.querySelector("[role=option]")'),'search zoom result');
    const before=await search.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    win32('for($n=0;$n -lt 5;$n++){ [E2E.Native]::keybd_event(0x11,0,0,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x6B,0,0,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x6B,0,2,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x11,0,2,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 100 }');
    await until(()=>search.evaluate('devicePixelRatio >= '+before.dpr*1.99),'search native 200% zoom');
    await sleep(600);
    const frames=[];
    for(let i=0;i<10;i++){frames.push(await search.evaluate(`(() => {const row=document.querySelector('[role=option][aria-selected=true]');const r=row.getBoundingClientRect();const viewport=row.closest('.nv-scroll-hover').getBoundingClientRect();return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,input:document.querySelector('input').getBoundingClientRect().bottom,footer:document.querySelector('footer').getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>innerWidth,focus:document.activeElement===document.querySelector('input'),value:document.querySelector('input').value,row:{top:r.top,bottom:r.bottom},list:{top:viewport.top,bottom:viewport.bottom}}})()`));await sleep(100);}
    const screenshot=await search.send('Page.captureScreenshot',{format:'png'});
    const screenshotFile=`search-200pct-${index}.png`;
    const screenshotBytes=Buffer.from(screenshot.result.data,'base64');
    writeFileSync(join(EVIDENCE,screenshotFile),screenshotBytes);
    const after=frames.at(-1);
    if(after.row.top<after.list.top-1||after.row.bottom>after.list.bottom+1||after.overflow||after.footer>after.height+1||after.input>after.height+1||!after.focus||after.value!=='zoom-search-fixture'||new Set(frames.slice(-5).map(f=>f.height)).size!==1)throw Error('Search zoom clipping/focus/fitting: '+JSON.stringify({before,frames}));
    zoomRecords.push({surface:'search',before,frames,screenshotFile,screenshotSha256:createHash('sha256').update(screenshotBytes).digest('hex')});
  } finally {pressHotkey([0x11,0x30]);await search.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});search.close();}
}

async function checkNativeBadgeDrag({main,floating,child,index}) {
        const original = cursorPosition();
        try {
          /** 悬浮窗与工作区的物理像素几何。 */
          const geometry = () =>
            floating.evaluate("(() => { const k = devicePixelRatio; return { scale:k, x: screenX * k, y: screenY * k, w: outerWidth * k, h: outerHeight * k, right: (screen.availLeft + screen.availWidth) * k, panel: !!document.querySelector(\"[aria-label='今日面板'],[aria-label='Today panel']\") }; })()");
          /** 指针移到远处，等面板收起回徽标大小（松手时指针停在徽标上，面板会展开），再读几何。 */
          const collapsed = async (what) => {
            realMouse(200, 200);
            return until(async () => {
              const g = await geometry();
              return !g.panel && g.w < 200 ? g : null;
            }, `${what}：面板收起`, 8000);
          };
          // 先拖离边缘 300px（远超吸附范围）：徽标落在松手的位置（按下的那一点始终在光标下），不被吸回去。
          const start = await collapsed("开始之前");
          const scale = start.scale;
          await floating.evaluate(`(() => { window.__dragTrace=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel']) window.addEventListener(type,e=>{window.__dragTrace.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,target:e.target.tagName});window.__dragTrace=window.__dragTrace.slice(-30)},true); })()`);
          const center = [start.x + start.w / 2, start.y + start.h / 2];
          // 没有长按就拖：徽标不动，也不打开主窗口（防止点击时手一滑把徽标挪走）。
          realDrag(center, [center[0] - 300 * scale, center[1]], DRAG_ONLY ? DRAG_STEPS : 12, 120);
          await sleep(800);
          const unmoved = await collapsed("没长按就拖之后");
          if (Math.abs(unmoved.x - start.x) > 1 || Math.abs(unmoved.y - start.y) > 1) {
            throw new Error(`没有长按就拖动了徽标：开始 ${JSON.stringify(start)}，现在 ${JSON.stringify(unmoved)}`);
          }
          // 按住到长按时间：徽标进入选中态（data-selected），松开后取消选中。
          win32(`[void][E2E.Native]::SetProcessDPIAware(); [void][E2E.Native]::SetCursorPos(${Math.round(center[0])}, ${Math.round(center[1])}); [E2E.Native]::mouse_event(0x2, 0, 0, 0, [System.UIntPtr]::Zero)`);
          try {
            await until(() => floating.evaluate("!!document.querySelector('.nv-badge[data-selected]')"), "长按后徽标进入选中态", 3000);
          } finally {
            win32("[E2E.Native]::mouse_event(0x4, 0, 0, 0, [System.UIntPtr]::Zero)");
          }
          await until(() => floating.evaluate("!document.querySelector('.nv-badge[data-selected]')"), "长按后松开取消选中", 3000);
          // 长按后拖离边缘 300px：徽标落在松手的位置（按下的那一点始终在光标下）。
          realDrag(center, [center[0] - 300 * scale, center[1]], DRAG_ONLY ? DRAG_STEPS : 12);
          await sleep(800);
          const before = await collapsed("拖离边缘之后");
          if (Math.abs(before.x - (start.x - 300 * scale)) > 3 * scale) {
            throw new Error(`徽标没有落在松手的位置：开始 ${JSON.stringify(start)}，现在 ${JSON.stringify(before)}（应移动 ${300 * scale}px）；指针记录 ${JSON.stringify(await floating.evaluate('window.__dragTrace'))}`);
          }
          if (Math.abs(before.x + before.w - before.right) <= 1) throw new Error("拖离 300px 之后仍贴在右边缘");
          // 再拖到离右边 10px 处：不吸附，就停在松手的地方。
          const grab = [before.x + before.w / 2, before.y + before.h / 2];
          realDrag(grab, [grab[0] + (before.right - 10 * scale - (before.x + before.w)), grab[1]]);
          await sleep(800);
          const near = await collapsed("拖近边缘之后");
          if (Math.abs(near.right - (near.x + near.w) - 10 * scale) > 2 * scale || Math.abs(near.y - before.y) > 2 * scale) {
            throw new Error(`拖到离右边 10px 处之后没有停在松手的位置：拖之前 ${JSON.stringify(before)}，现在 ${JSON.stringify(near)}`);
          }
          // 拖出右边缘 20px：拉回屏幕内，贴住右边缘、竖直位置不变。
          const grab2 = [near.x + near.w / 2, near.y + near.h / 2];
          realDrag(grab2, [grab2[0] + 30 * scale, grab2[1]]);
          await sleep(800);
          const after = await collapsed("拖出边缘之后");
          if (Math.abs(after.x + after.w - after.right) > 1 || Math.abs(after.y - before.y) > 2 * scale) {
            throw new Error(`拖出屏幕后没有拉回贴住右边缘：拖之前 ${JSON.stringify(near)}，现在 ${JSON.stringify(after)}`);
          }

          if (DRAG_ONLY) return;
          // 单击收起的徽标（按下后没有移动）：打开主窗口并把它放到前台——这是用户要去的地方。
          focusWindow(USER_FOREGROUND);
          await until(() => foregroundWindow() === USER_FOREGROUND, "点击之前前台在别的应用", 5000);
          realMouse(after.x + after.w / 2, after.y + after.h / 2, true);
          await until(() => foregroundOwner().startsWith(`${child.pid} `), "单击徽标后主窗口到了前台", 5000).catch((e) => {
            throw new Error(`${e.message}（现在的前台：${foregroundOwner()}）`);
          });
          await until(() => main.evaluate("document.hasFocus()"), "主窗口拿到焦点", 5000);

          // 在拾序自己的主窗口里按 Quick Create 快捷键：记下的「原来的窗口」是主窗口，Enter 之后焦点回到主窗口
          // （此前只测过别的应用在前台的情况）。
          const mainHandle = foregroundWindow();
          pressHotkey([0x11, 0x12, 0x10, 0x77]);
          await until(() => floating.evaluate("document.hasFocus() && ['标题', 'Title'].includes(document.activeElement?.getAttribute('aria-label')) && !document.activeElement.disabled"), "主窗口里按快捷键呼出 Quick Create", 10000);
          const fromMain = `e2e-from-main-${index}`;
          await floating.send("Input.insertText", { text: fromMain });
          await floating.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await floating.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await until(async () => (await main.invoke("get_today")).todos.some((i) => i.title === fromMain), "从主窗口快捷键创建了待办");
          await until(() => foregroundWindow() === mainHandle, "创建后焦点回到主窗口", 5000).catch(() => {
            throw new Error(`创建后焦点没有回到主窗口：应为 ${mainHandle}，现在 ${foregroundWindow()}（${foregroundOwner()}）`);
          });
        } finally {
          realMouse(original[0], original[1]);
        }
}

async function checkNativePanelDrag(floating) {
  const original = cursorPosition();
  const geometry = () => floating.evaluate(`(() => {
    const scale = devicePixelRatio;
    return { scale, x: screenX * scale, y: screenY * scale, w: outerWidth * scale, h: outerHeight * scale,
      panel: !!document.querySelector('section.nv-panel-in') };
  })()`);
  const collapsed = () => until(async () => {
    const g = await geometry();
    return !g.panel && g.w < 200 ? g : null;
  }, "徽标收起");
  try {
    realMouse(200, 200);
    const badge = await collapsed();
    const { scale } = badge;
    realMouse(badge.x + badge.w / 2, badge.y + badge.h / 2);
    const panel = await until(async () => {
      const g = await geometry();
      return g.panel && g.w >= 300 * scale - 1 ? g : null;
    }, "拖动前悬停展开面板");
    // 从标题左侧长按拖动，第一次移动就越过面板边缘。
    const grab = [panel.x + 18 * scale, panel.y + 16 * scale];
    const offset = 120 * scale;
    realDrag(grab, [grab[0] - offset, grab[1]], 4);
    realMouse(200, 200);
    const placed = await collapsed();
    if (Math.abs(placed.x - (badge.x - offset)) > 3 * scale || Math.abs(placed.y - badge.y) > 3 * scale) {
      throw new Error(`收起后徽标没有跟随面板：拖之前 ${JSON.stringify(badge)}，现在 ${JSON.stringify(placed)}`);
    }
  } finally {
    realMouse(original[0], original[1]);
  }
}

async function checkNativeOle({main,floating,data,index}) {
        const original = cursorPosition();
        try {
          await floating.evaluate(`(() => {window.__oleTrace=[];for(const type of ['dragenter','dragover','drop','dragleave'])window.addEventListener(type,e=>{window.__oleTrace.push({type,x:e.clientX,y:e.clientY,types:[...e.dataTransfer.types],target:e.target.tagName});window.__oleTrace=window.__oleTrace.slice(-12)},true)})()`);
          // 一个普通文件、一个带中文与空格的文件、一个文件夹（拖放矩阵里文件夹一项此前未验证）。
          const names = [`e2e-ole-a-${index}.txt`, `e2e-ole-b-${index} 中文 名.txt`, `e2e-ole-dir-${index}`];
          const paths = names.map((name) => join(data, name));
          writeFileSync(paths[0], "ole drop");
          writeFileSync(paths[1], "ole drop");
          mkdirSync(paths[2]);
          realMouse(200,200);
          await until(()=>floating.evaluate(`innerWidth < 200 && !document.querySelector('[aria-label="今日面板"],[aria-label="Today panel"]')`),'stable collapsed OLE target',8000);
          const target = await until(
            () => floating.evaluate("(() => { const k = window.devicePixelRatio; return [(window.screenX + window.innerWidth / 2) * k, (window.screenY + window.innerHeight / 2) * k]; })()"),
            "悬浮窗的位置",
          );
          // 从悬浮窗左边（放不下就右边）开始拖。
          const from = [target[0] > 400 ? target[0] - 300 : target[0] + 300, target[1]];
          const quote = (text) => `'${text.replaceAll("'", "''")}'`;
          /** 用 ole-drag.ps1 做一次真实拖放；`payload` 是它的数据参数（如 `-Files 'a','b'`）。 */
          let drops = 0;
          const oleDrag = async (payload, zone = "inbox") => {
            // The previous accepted drop expands the panel over the helper's
            // source point. Collapse before every new drag, not just the first.
            realMouse(200,200);
            await until(()=>floating.evaluate(`innerWidth < 200 && !document.querySelector('[aria-label="今日面板"],[aria-label="Today panel"]')`),'OLE helper source is outside the collapsed target',8000);
            const landingFile = join(data, `ole-landing-${drops++}.json`);
            const dragProcess = promisify(execFile)(
              "powershell",
              [
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                `& ${quote(join(ROOT, "tests", "e2e", "ole-drag.ps1"))} ${payload} -FromX ${Math.round(from[0])} -FromY ${Math.round(from[1])} -ToX ${Math.round(target[0])} -ToY ${Math.round(target[1])} -LandingFile ${quote(landingFile)}`,
              ],
              { encoding: "utf8", timeout: 30000, windowsHide: true },
            );
            const locate = until(() => floating.evaluate(`(() => {
              const node = document.querySelector('[data-drop-zone="${zone}"]');
              if (!node || innerWidth < 200) return null;
              const bounds = node.getBoundingClientRect();
              return {
                x: Math.round((screenX + bounds.left + bounds.width / 2) * devicePixelRatio),
                y: Math.round((screenY + bounds.top + bounds.height / 2) * devicePixelRatio),
              };
            })()`), `悬浮窗拖放区 ${zone}`, 6500).then((point) => {
              const pendingFile = landingFile + ".tmp";
              writeFileSync(pendingFile, JSON.stringify(point));
              renameSync(pendingFile, landingFile);
            });
            const [drag, located] = await Promise.allSettled([dragProcess, locate]);
            if (drag.status === "rejected") throw drag.reason;
            const result = drag.value.stdout.trim();
            if (result === "None" || result === "NotStarted") {
              throw new Error(`拖放没有被接受（${zone}）：${result} ${drag.value.stderr.trim()}`);
            }
            if (located.status === "rejected") throw located.reason;
          };
          await oleDrag(`-Files ${paths.map(quote).join(",")}`);
          // 每一项都建成条目，并且附件引用的是磁盘上的真实路径（不是只拿到了文件名）。
          for (const [i, name] of names.entries()) {
            const key = name.split(" ")[0].replace(".txt", "");
            const item = await until(async () => (await main.invoke("search_items", { query: key }))[0], `拖入的 ${name} 建成了条目`, 10000).catch(async error=>{throw Error(error.message+' '+JSON.stringify({target,state:await floating.evaluate(`({x:screenX,y:screenY,w:innerWidth,h:innerHeight,dpr:devicePixelRatio,text:document.body.innerText.slice(-200),events:window.__oleTrace})`)}));});
            const detail = await main.invoke("get_item_detail", { id: item.id });
            const attached = detail.attachments.map((a) => a.path.toLowerCase());
            if (!attached.includes(paths[i].toLowerCase())) {
              throw new Error(`${name} 的附件路径不对：${JSON.stringify(detail.attachments.map((a) => a.path))}，应为 ${paths[i]}`);
            }
          }

          // 编辑器里拖选中的文字（CF_UNICODETEXT）→ 待办；浏览器拖链接（UniformResourceLocatorW）→ 笔记。
          const text = `e2eoletext${index} 回复邮件`;
          await oleDrag(`-Text ${quote(text)}`);
          const todo = await until(async () => (await main.invoke("search_items", { query: `e2eoletext${index}` }))[0], "拖入的文字建成了条目", 10000);
          if (todo.itemType !== "todo" || todo.title !== text) throw new Error(`拖入的文字应建成同名待办：${JSON.stringify([todo.itemType, todo.title])}`);
          await until(() => floating.evaluate(`(() => {
            const undo = [...document.querySelectorAll('button')].find(
              button => ['撤销', 'Undo'].includes(button.textContent.trim())
            );
            if (!undo) return false;
            undo.click();
            return true;
          })()`), "从悬浮窗撤销这次捕获");
          await until(async () => !(await main.invoke("search_items", { query: `e2eoletext${index}` })).length,
            "撤销后无法搜到这条待办");
          const url = `https://example.com/e2eolelink${index}`;
          await oleDrag(`-Url ${quote(url)}`);
          const note = await until(async () => (await main.invoke("search_items", { query: `e2eolelink${index}` }))[0], "拖入的链接建成了条目", 10000);
          if (note.itemType !== "note") throw new Error(`拖入的链接应建成笔记：${JSON.stringify([note.itemType, note.title])}`);

          const prefill = `e2e-ole-prefill-${index}`;
          await oleDrag(`-Text ${quote(prefill)}`, "create");
          await until(() => floating.evaluate(`document.querySelector('form input[required]')?.value === ${JSON.stringify(prefill)}`), "真实拖放预填标题");
          if ((await main.invoke("search_items", { query: prefill })).length) {
            throw new Error("拖放到预填区时提前创建了事项");
          }
          await floating.evaluate(`[...document.querySelectorAll('form button')].find(
            button => ['取消', 'Cancel'].includes(button.textContent.trim())
          ).click()`);
          await floating.evaluate(`[...document.querySelectorAll('form button')].find(
            button => ['放弃内容', 'Discard'].includes(button.textContent.trim())
          )?.click()`);
          await until(() => floating.evaluate("!document.querySelector('form input[required]')"),
            "关闭悬浮窗预填");

          await floating.invoke("open_main_at", { view: "calendar" });
          await main.evaluate(`(() => {
            window.__calendarDropTrace = [];
            window.__calendarPointer = null;
            document.addEventListener('pointermove', event => {
              window.__calendarPointer = { x: event.clientX, y: event.clientY };
            });
            for (const type of ['dragenter', 'drop']) document.addEventListener(type, event => {
              const cell = event.target.closest?.('[data-calendar-day]');
              window.__calendarDropTrace.push({ type, date: cell?.dataset.calendarDay, x: event.clientX,
                y: event.clientY, formats: [...event.dataTransfer.types] });
              window.__calendarDropTrace = window.__calendarDropTrace.slice(-8);
            }, true);
          })()`);
          const { date, approxX, approxY, centerX, centerY, dpr } = await until(() => main.evaluate(`(() => {
            const cells = [...document.querySelectorAll('[data-calendar-day]')];
            const cell = cells[Math.floor(cells.length / 2)];
            if (!cell) return null;
            const bounds = cell.getBoundingClientRect();
            const centerX = bounds.left + bounds.width / 2;
            const centerY = bounds.top + bounds.height / 2;
            return {
              date: cell.dataset.calendarDay,
              centerX, centerY, dpr: devicePixelRatio,
              approxX: Math.round((screenX + centerX) * devicePixelRatio),
              approxY: Math.round((screenY + centerY) * devicePixelRatio),
            };
          })()`), "日历落点");
          // 主窗口的原生标题栏和边框让 screenX/Y 与实际 WebView 客户区的原点有偏移。
          realMouse(approxX, approxY);
          const pointer = await until(() => main.evaluate("window.__calendarPointer"), "主窗口接收到真实指针");
          const x = Math.round(approxX + (centerX - pointer.x) * dpr);
          const y = Math.round(approxY + (centerY - pointer.y) * dpr);
          const calendarTitle = `e2e-ole-calendar-${index}`;
          const calendarText = `${calendarTitle}\n保留讨论记录`;
          const calendarDrop = await promisify(execFile)("powershell", [
            "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command",
            `& ${quote(join(ROOT, "tests", "e2e", "ole-drag.ps1"))} -Text ${quote(calendarText)} -FromX ${x - 180} -FromY ${y} -ToX ${x} -ToY ${y}`,
          ], { encoding: "utf8", timeout: 30000, windowsHide: true });
          if (["None", "NotStarted"].includes(calendarDrop.stdout.trim())) {
            const trace = await main.evaluate("window.__calendarDropTrace");
            throw new Error(`日历未接收 OLE 拖放：${calendarDrop.stdout} ${calendarDrop.stderr} ${JSON.stringify({ date, x, y, trace })}`);
          }
          await until(() => main.evaluate(`(() => {
            const form = document.querySelector('dialog[open] form');
            return form?.querySelector('input[required]')?.value === ${JSON.stringify(calendarTitle)}
              && form.querySelector('[data-scheduled-date]')?.value === ${JSON.stringify(date)};
          })()`), "日历拖放预填标题和落点日期", 5000).catch(async (error) => {
            const result = await main.evaluate(`({
              trace: window.__calendarDropTrace,
              date: document.querySelector('dialog[open] [data-scheduled-date]')?.value,
              title: document.querySelector('dialog[open] input[required]')?.value,
            })`);
            throw new Error(`${error.message} ${JSON.stringify({ date, x, y, result })}`);
          });
          if ((await main.invoke("search_items", { query: calendarTitle })).length) {
            throw new Error("日历预填确认前写入了事项");
          }
          await main.evaluate("document.querySelector('dialog[open] form button[type=submit]').click()");
          const planned = await until(async () => (await main.invoke("search_items", { query: calendarTitle }))[0], "保存日历预填");
          const { item: calendarItem } = await main.invoke("get_item_detail", { id: planned.id });
          if (calendarItem.scheduled?.date !== date || calendarItem.content?.replace(/\r\n/g, "\n") !== calendarText || calendarItem.inInbox) {
            throw new Error("日历拖放保存后的计划日期、原文或收集箱状态不符");
          }
          await until(() => main.evaluate(`document.hasFocus() && !document.querySelector('dialog[open]')
            && [...document.querySelectorAll('button')].some(button => ['撤销', 'Undo'].includes(button.textContent.trim()))`),
          "日历关闭草稿并显示撤销");
          await main.evaluate(`document.querySelector('[data-calendar-day="${date}"] [data-day-add]').focus()`);
          pressHotkey([0x11, 0x5a]);
          await until(async () => (await main.invoke("list_trash")).some(
            (entry) => entry.item.id === planned.id
          ), "键盘撤销日历新建");
        } finally {
          realMouse(original[0], original[1]);
        }

}

/** 用独立 Chrome 窗口中的真实网页链接验证跨应用拖入预填区。 */
async function checkNativeBrowserDrop({ main, floating, data, index }) {
  const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(chrome)) throw new Error("找不到 Chrome，可用 CHROME 指定路径");
  const profile = join(data, "chrome-drop-profile");
  const fixture = join(data, "drag-source.html");
  const title = `e2e-chrome-link-${index}`;
  const url = `https://example.test/${title}`;
  writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><title>Drag fixture</title>
    <a style="display:inline-block;margin:80px;font:24px sans-serif" href="${url}">${title}</a>`);
  const original = cursorPosition();
  const browser = spawn(chrome, [
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--window-position=80,180", "--window-size=480,360", `--app=${pathToFileURL(fixture).href}`,
  ], { stdio: "ignore" });
  let page;
  try {
    const target = await until(() => floating.evaluate(`innerWidth < 200 ? [
      (screenX + innerWidth / 2) * devicePixelRatio, (screenY + innerHeight / 2) * devicePixelRatio
    ] : null`), "收起的悬浮徽标");
    const pageInfo = await until(async () => {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return pages.find((entry) => entry.url === pathToFileURL(fixture).href);
    }, "独立 Chrome 测试页面");
    page = await connect(pageInfo.webSocketDebuggerUrl);
    const version = await page.send("Browser.getVersion");
    await until(() => page.evaluate("Boolean(document.querySelector('a'))"), "Chrome 夹具链接加载");
    const source = await page.evaluate(`(() => {
      const bounds = document.querySelector('a').getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      document.addEventListener('pointermove', event => {
        window.__browserDropPointer = { x: event.clientX, y: event.clientY };
      });
      return { centerX, centerY, dpr: devicePixelRatio,
        x: (screenX + centerX) * devicePixelRatio, y: (screenY + centerY) * devicePixelRatio };
    })()`);
    realMouse(source.x, source.y);
    const pointer = await until(() => page.evaluate("window.__browserDropPointer"), "Chrome 收到真实指针");
    const from = [
      source.x + (source.centerX - pointer.x) * source.dpr,
      source.y + (source.centerY - pointer.y) * source.dpr,
    ];
    realDrag(from, target, 24, 150);
    const prefill = await until(() => floating.evaluate(`(() => {
      const form = document.querySelector('form');
      const link = form?.querySelector(${JSON.stringify(`[title="${url}"]`)});
      return link ? form.querySelector('input[required]')?.value : null;
    })()`), "Chrome 链接预填为来源");
    if ((await main.invoke("search_items", { query: title })).length) {
      throw new Error("确认之前写入了浏览器链接");
    }
    await floating.evaluate(`[...document.querySelectorAll('form button[role=radio]')].find(
      button => ['待办', 'To-do'].includes(button.textContent.trim())
    ).click()`);
    await until(() => floating.evaluate(`(() => {
      const todo = document.querySelector('form button[role=radio][aria-checked=true]');
      return ['待办', 'To-do'].includes(todo?.textContent.trim())
        && !!document.querySelector(${JSON.stringify(`form [title="${url}"]`)});
    })()`), "切换到待办后保留网页来源");
    await floating.evaluate("document.querySelector('form button[type=submit]').click()");
    const item = await until(async () => (await main.invoke("search_items", { query: title }))
      .find((entry) => entry.title === prefill), "保存浏览器预填");
    const detail = await main.invoke("get_item_detail", { id: item.id });
    if (item.itemType !== "todo" || !detail.sources.some((source) => source.sourceUrl === url)) {
      throw new Error("保存后的 Chrome 链接来源不符");
    }
    console.log(`  ${version.result?.product ?? "Chrome"}：按住网页链接拖放，预填、切换类型与保存来源通过`);
  } finally {
    page?.close();
    if (browser.pid && browser.exitCode === null) {
      try { execFileSync("taskkill", ["/F", "/T", "/PID", String(browser.pid)], { stdio: "ignore", windowsHide: true }); }
      catch { browser.kill(); }
    }
    realMouse(original[0], original[1]);
  }
}

/** 用资源管理器新窗口拖入测试文件，验证保留原文件位置。 */
async function checkNativeExplorerDrop({ main, floating, data, index }) {
  const folder = join(data, "explorer-drop");
  mkdirSync(folder);
  const title = `e2e-explorer 中文文件 ${index}`;
  const filename = `${title}.txt`;
  const file = join(folder, filename);
  writeFileSync(file, "Nivlo synthetic Explorer drag fixture");
  const original = cursorPosition();
  const existing = new Set(win32(`
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in $shell.Windows()) { $window.HWND }
  `).split(/\r?\n/));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const fixtureWindow = `
    $shell = New-Object -ComObject Shell.Application
    $fixture = $null
    foreach ($window in $shell.Windows()) {
      try {
        if ($window.Document.Folder.Self.Path -eq ${quote(folder)}) { $fixture = $window; break }
      } catch { }
    }
  `;
  let source;
  try {
    spawn("explorer.exe", [`/n,${folder}`], { stdio: "ignore" });
    const target = await until(() => floating.evaluate(`innerWidth < 200 ? [
      (screenX + innerWidth / 2) * devicePixelRatio, (screenY + innerHeight / 2) * devicePixelRatio
    ] : null`), "收起的悬浮徽标");
    const handle = await until(() => win32(`${fixtureWindow}
      if ($null -ne $fixture) { $fixture.HWND }
    `) || null, "资源管理器打开独立测试目录");
    if (existing.has(handle)) throw new Error("资源管理器复用了已有窗口");
    source = handle;
    focusWindow(source);
    const from = await until(() => {
      const point = win32(`
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${source})
        foreach ($name in @(${quote(filename)}, ${quote(title)})) {
          $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name
          )
          $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
          if ($null -ne $element -and -not $element.Current.IsOffscreen) {
            $bounds = $element.Current.BoundingRectangle
            if ($bounds.Width -gt 0 -and $bounds.Height -gt 0) {
              @(($bounds.Left + [Math]::Min(60.0, $bounds.Width / 2)), ($bounds.Top + $bounds.Height / 2)) |
                ConvertTo-Json -Compress
              break
            }
          }
        }
      `);
      return point ? JSON.parse(point) : null;
    }, "资源管理器中的测试文件位置");
    await floating.evaluate(`(() => {
      window.__explorerDropTrace = [];
      for (const type of ['dragenter', 'drop']) document.addEventListener(type, event => {
        window.__explorerDropTrace.push({ type, formats: [...event.dataTransfer.types] });
      }, true);
    })()`);
    realDrag(from, target, 24, 150);
    const prefilledTitle = await until(() => floating.evaluate(`(() => {
      const form = document.querySelector('form');
      const submit = form?.querySelector('button[type=submit]');
      if (!submit || submit.disabled) return null;
      const referenced = [...form.querySelectorAll('[title]')].some(
        element => element.title.toLowerCase() === ${JSON.stringify(file.toLowerCase())}
      );
      return referenced ? form.querySelector('input[required]')?.value : null;
    })()`), "资源管理器文件路径进入预填", 5000).catch(async (error) => {
      const state = await floating.evaluate(`({
        trace: window.__explorerDropTrace,
        title: document.querySelector('form input[required]')?.value,
        window: [screenX, screenY, innerWidth, innerHeight]
      })`);
      throw new Error(`${error.message} ${JSON.stringify({ from, target, state })}`);
    });
    if ((await main.invoke("search_items", { query: "e2e-explorer" })).length) {
      throw new Error("确认前已写入资源管理器文件");
    }
    await floating.evaluate("document.querySelector('form button[type=submit]').click()");
    const item = await until(async () => (await main.invoke("search_items", { query: "e2e-explorer" }))
      .find((entry) => entry.title === prefilledTitle),
      "保存资源管理器预填", 7000).catch(async (error) => {
        const message = await floating.evaluate("document.querySelector('form [role=alert]')?.textContent");
        throw new Error(`${error.message} ${JSON.stringify({ prefilledTitle, message })}`);
      });
    const detail = await main.invoke("get_item_detail", { id: item.id });
    if (!detail.attachments.some((attachment) => attachment.kind === "reference" &&
      attachment.path.toLowerCase() === file.toLowerCase()) || !existsSync(file)) {
      throw new Error("资源管理器文件没有保存为原路径引用");
    }
    const version = win32("(Get-Item -LiteralPath (Join-Path $env:windir 'explorer.exe')).VersionInfo.FileVersion");
    console.log(`  资源管理器 ${version}：文件预填、保存原路径引用和保留原文件通过`);
  } finally {
    if (source) win32(`${fixtureWindow}
      if ($null -ne $fixture -and $fixture.HWND -eq ${source}) { $fixture.Quit() }
    `);
    realMouse(original[0], original[1]);
  }
}

/** 键盘创建后，检查真正的 NVDA 通知并用 Ctrl+Z 撤销。 */
async function checkNvdaCalendarFeedback({ main, floating, speechLog }) {
  const title = "e2e-nvda-calendar-feedback";
  await floating.invoke("open_main_at", { view: "calendar" });
  const day = await until(() => main.evaluate(`(() => {
    if (!document.hasFocus()) return null;
    const cells = [...document.querySelectorAll('[data-calendar-day]')];
    return cells[Math.floor(cells.length / 2)]?.dataset.calendarDay;
  })()`), "键盘验收使用的日历日期");
  const add = `document.querySelector('[data-calendar-day="${day}"] [data-day-add]')`;
  await main.evaluate(`${add}.focus()`);
  pressHotkey([0x0d]);
  await until(() => main.evaluate(`document.activeElement instanceof HTMLInputElement &&
    document.activeElement.closest('[data-calendar-day]')?.dataset.calendarDay === ${JSON.stringify(day)}`),
  "键盘打开当日新待办");
  await main.send("Input.insertText", { text: title });
  const speechOffset = readFileSync(speechLog).length;
  pressHotkey([0x0d]);
  const item = await until(async () => (await main.invoke("search_items", { query: title }))[0],
    "键盘保存日历新待办");
  await until(() => readFileSync(speechLog).subarray(speechOffset).toString("utf8")
    .split(/\r?\n/).some((line) => line.includes("Speaking") && line.includes(title) && /已创建|Created/.test(line)),
  "NVDA 朗读日历创建成功反馈", 3500);
  await main.evaluate(`${add}.focus()`);
  pressHotkey([0x11, 0x5a]);
  await until(async () => (await main.invoke("list_trash")).some((entry) => entry.item.id === item.id),
    "启用 NVDA 时 Ctrl+Z 撤销日历新建");
  console.log("  NVDA 朗读了日历创建成功提示，键盘撤销通过");
}

/** 用已启用的 Windows 中文输入法验证组字和主动提交。 */
async function checkNativeIme({ main, floating }) {
  await main.invoke("set_shortcut", { action: "quickCreate", accelerator: "Ctrl+Alt+Shift+F8" });
  const before = (await main.invoke("get_today")).todos.map((item) => item.id);
  pressHotkey([0x11, 0x12, 0x10, 0x77]);
  await until(() => floating.evaluate(`document.hasFocus()
    && document.activeElement === document.querySelector('form input[required]')
    && !document.activeElement.disabled`), "输入法测试的标题取得焦点");
  await floating.evaluate(`(() => {
    window.__imeTrace = [];
    for (const type of ['compositionstart', 'compositionend', 'keydown']) {
      document.querySelector('form input[required]').addEventListener(type, (event) => {
        window.__imeTrace.push({ type, key: event.key, code: event.keyCode, composing: event.isComposing });
      });
    }
  })()`);
  /** 向 Windows 输入法输入真实的 n i h a o 按键。 */
  const typePinyin = () => win32(`
    foreach ($key in 0x4e,0x49,0x48,0x41,0x4f) {
      [E2E.Native]::keybd_event($key,0,0,[System.UIntPtr]::Zero)
      [E2E.Native]::keybd_event($key,0,2,[System.UIntPtr]::Zero)
      Start-Sleep -Milliseconds 70
    }
  `);
  const composing = "window.__imeTrace.some(event => event.type === 'compositionstart')";
  let switched = false;
  try {
    typePinyin();
    if (!await floating.evaluate(composing)) {
      pressHotkey([0x11, 0x41]);
      pressHotkey([0x08]);
      pressHotkey([0x10]);
      switched = true;
      typePinyin();
    }
    await until(() => floating.evaluate(composing), "微软拼音产生真实 compositionstart", 3500);
    pressHotkey([0x1b]);
    await until(() => floating.evaluate(`window.__imeTrace.some(event => event.type === 'compositionend')
      && document.activeElement === document.querySelector('form input[required]')`),
    "Esc 取消组字但保留弹窗和焦点", 5000);
    await floating.evaluate("window.__imeTrace.length = 0");
    typePinyin();
    await until(() => floating.evaluate(composing), "再次进入微软拼音组字", 3500);
    pressHotkey([0x0d]);
    const title = await until(() => floating.evaluate(`window.__imeTrace.some(event => event.type === 'compositionend')
      && document.querySelector('form input[required]')?.value`), "Enter 结束组字且保留标题", 5000);
    if (JSON.stringify((await main.invoke("get_today")).todos.map((item) => item.id)) !== JSON.stringify(before)) {
      throw Error("结束组字时创建了事项");
    }
    if (switched) {
      pressHotkey([0x10]);
      switched = false;
    }
    pressHotkey([0x11, 0x0d]);
    await until(async () => {
      const created = (await main.invoke("get_today")).todos.filter((item) => !before.includes(item.id));
      return created.length === 1 && created[0].title === title;
    }, "主动 Ctrl+Enter 只创建一条事项");
  } finally {
    if (switched) pressHotkey([0x10]);
  }
}

async function checkNativeContextCreate({ main, floating }) {
  const fixture = spawn("powershell", [
    "-NoProfile", "-NonInteractive", "-STA", "-Command", `
    Add-Type -AssemblyName PresentationFramework
    $window = New-Object Windows.Window
    $window.Title = 'Nivlo context selection fixture'
    $window.Width = 440
    $window.Height = 160
    $input = New-Object Windows.Controls.TextBox
    $input.AcceptsReturn = $true
    $input.Text = "e2e-context-selection" + [Environment]::NewLine + "second line"
    $window.Content = $input
    $window.Add_ContentRendered({
      param($sender, $eventArgs)
      [void]$sender.Content.Focus()
      $sender.Content.SelectAll()
    })
    [void]$window.ShowDialog()
  `], { windowsHide: true, stdio: ["ignore", "ignore", "inherit"] });
  try {
    const binding = await main.invoke("get_shortcut_status", { action: "contextCreate" });
    const defaultReady = binding.registered && binding.accelerator === "Ctrl+Alt+Shift+Space";
    if (!defaultReady) {
      await main.invoke("set_shortcut", { action: "contextCreate", accelerator: "Ctrl+Alt+Shift+F10" });
    }
    const hotkey = [0x11, 0x12, 0x10, defaultReady ? 0x20 : 0x79];
    const source = await until(() => {
      const handle = win32(`${largestWindow(fixture.pid)}; $best.ToInt64()`);
      return handle !== "0" ? handle : null;
    }, "UI Automation text fixture");
    focusWindow(source);
    await until(() => foregroundWindow() === source, "selection fixture in foreground");
    pressHotkey([0x11, 0x41]);
    const clipboardSequence = () => win32(`
      Add-Type -Namespace E2E -Name Clipboard -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
      [E2E.Clipboard]::GetClipboardSequenceNumber()
    `);
    const clipboardBefore = clipboardSequence();
    const speechLog = process.env.NIVLO_NVDA_LOG;
    const speechOffset = speechLog ? readFileSync(speechLog).length : 0;
    pressHotkey(hotkey);
    await until(() => floating.evaluate(`
      document.hasFocus() &&
      document.activeElement?.value === "e2e-context-selection" &&
      ["来自当前选区", "From the current selection"].some(text => document.body.innerText.includes(text))
    `), "选区预填到新增弹窗", 10000);
    if (speechLog) {
      await until(() => readFileSync(speechLog).subarray(speechOffset).toString("utf8")
        .split(/\r?\n/).some((line) =>
          line.includes("Speaking") && line.includes("e2e-context-selection") && /标题|Title/.test(line)),
      "NVDA 朗读预填标题控件及其内容", 5000);
      console.log("  NVDA 朗读了预填标题控件及其内容");
    }
    if ((await main.invoke("search_items", { query: "e2e-context-selection" })).length > 0) {
      throw Error("用户确认之前创建了事项");
    }
    if (clipboardSequence() !== clipboardBefore) throw Error("预填选区时改动了系统剪贴板");
    if (speechLog) {
      // NVDA 可以先消费 Escape 退出焦点模式。用正常的键盘导航完成同一个取消动作。
      let cancelFocused = false;
      for (let attempt = 0; attempt < 10 && !cancelFocused; attempt++) {
        pressHotkey([0x10, 0x09]);
        cancelFocused = await floating.evaluate(`
          ['取消', 'Cancel'].includes(document.activeElement?.textContent.trim())
        `);
      }
      if (!cancelFocused) throw new Error("启用 NVDA 时无法通过键盘聚焦取消按钮");
      await until(() => readFileSync(speechLog).subarray(speechOffset).toString("utf8")
        .split(/\r?\n/).some((line) => line.includes("Speaking") && /取消.*按钮|Cancel.*button/i.test(line)),
      "NVDA 朗读取消按钮", 5000);
      pressHotkey([0x0d]);
    } else {
      pressHotkey([0x1b]);
    }
    await until(() => foregroundWindow() === source, "取消后焦点回到选区所在的应用");

    pressHotkey([0x11, 0x41]);
    pressHotkey(hotkey);
    await until(() => floating.evaluate(
      'document.hasFocus() && document.activeElement?.value === "e2e-context-selection"'
    ), "再次读取选区");
    await floating.evaluate("document.querySelector('form button[type=submit]').click()");
    const created = await until(async () => {
      const inbox = await main.invoke("list_inbox");
      return inbox.find(({ item }) => item.title === "e2e-context-selection");
    }, "预填事项写入收集箱");
    if (created.item.scheduled || !created.item.content?.includes("second line") ||
      !created.sources.some((entry) => entry.sourceType === "selection")) {
      throw Error("收集箱条目缺少原文或来源，或意外写入了计划日期");
    }
    await until(() => floating.evaluate(`
      Boolean([...document.querySelectorAll('button')].find(button => ['撤销', 'Undo'].includes(button.textContent.trim())))
    `), "悬浮窗显示创建撤销");
    await floating.evaluate(`
      [...document.querySelectorAll('button')].find(button => ['撤销', 'Undo'].includes(button.textContent.trim())).click()
    `);
    await until(async () => (await main.invoke("list_trash")).some(
      (entry) => entry.item.id === created.item.id
    ), "撤销创建后事项移入回收站");
    if (speechLog) await checkNvdaCalendarFeedback({ main, floating, speechLog });
  } finally {
    fixture.kill();
  }
}

async function runOnce(index) {
  ensureNoForeignInstance();
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-"));
  const dropFile = join(data, "dropped.txt");
  writeFileSync(dropFile, "e2e");
  const env = {
      ...process.env,
      NIVLO_DATA_DIR: join(data, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview-profile"),
      NIVLO_SKIP_FIRST_RUN_PROMPTS: "1",
      // 前台记忆 / 还原的调试日志：焦点相关的失败可以从日志里看出记住了谁、还给了谁。
      NIVLO_LOG: "info,nivlo_platform::foreground=debug,nivlo_desktop_lib::windows=debug",
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
      if (!existsSync(env.WEBVIEW2_USER_DATA_FOLDER)) throw Error('WebView2 did not create the isolated fixture profile');
      if (await floating.evaluate(`localStorage.getItem('nivlo.skin') !== null`)) throw Error('Fresh fixture unexpectedly inherited a skin preference');
      const browserVersion=await floating.send('Browser.getVersion');
      runtimeEnvironments.push({run:index,browserVersion:browserVersion.result,...await floating.evaluate(`({userAgent:navigator.userAgent,platform:navigator.platform,dpr:devicePixelRatio,screen:{width:screen.width,height:screen.height,availableWidth:screen.availWidth,availableHeight:screen.availHeight}})`) });
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
      const centerOffset = win32(`
        [void][E2E.Native]::SetProcessDPIAware()
        Add-Type -AssemblyName System.Windows.Forms
        ${largestWindow(child.pid)}
        $frame = New-Object E2E.Native+RECT
        [void][E2E.Native]::GetWindowRect($best, [ref]$frame)
        $work = [System.Windows.Forms.Screen]::FromHandle($best).WorkingArea
        @(
          ($frame.Left + $frame.Right - $work.Left - $work.Right) / 2
          ($frame.Top + $frame.Bottom - $work.Top - $work.Bottom) / 2
        ) | ConvertTo-Json -Compress
      `);
      // Tauri 居中时会扣除 DWM 的不可见边框，GetWindowRect 包含这部分。
      if (JSON.parse(centerOffset).some((axis) => Math.abs(axis) > 8)) {
        throw new Error(`主窗口没有在工作区居中，偏移量为 ${centerOffset} px`);
      }
      // A fresh native profile owns focus in onboarding. Dismiss it through the
      // visible UI before exercising the workspace, rather than clicking inert
      // background controls programmatically and mistaking them for user access.
      const skip = await until(() => main.evaluate(`(() => {const b=[...document.querySelectorAll('[role=dialog] button')].find(b=>['跳过','Skip'].includes(b.textContent.trim()));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), 'first-run Skip action');
      await main.send('Input.dispatchMouseEvent',{type:'mousePressed',...skip,button:'left',clickCount:1});
      await main.send('Input.dispatchMouseEvent',{type:'mouseReleased',...skip,button:'left',clickCount:1});
      await until(()=>main.evaluate(`!document.querySelector('[role=dialog]')`),'onboarding dismissed');
    });

    if (!FOCUSED_RUN) {
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

    // 6.5 提醒按时触发（实施计划 4.6 / 4.7）：几秒后的提醒到点由 Scheduler 发出系统通知（release 构建、真实时钟）。
    // 只看日志里的 `notification_sent`（不记标题）：通知本身会在桌面上短暂出现。
    await step("提醒按时触发", async () => {
      const remindAt = new Date(Date.now() + 4000).toISOString();
      await main.invoke("create_item", {
        request: {
          itemType: "todo",
          title: `e2e-remind-${index}`,
          content: null,
          contentFormat: null,
          priority: null,
          scheduled: null,
          due: null,
          reminderAt: remindAt,
          projectId: null,
        },
      });
      const sentCount = () =>
        readdirSync(join(data, "data", "logs"))
          .map((f) => readFileSync(join(data, "data", "logs", f), "utf8"))
          .join("\n")
          .split("\n")
          .filter((l) => l.includes("event=\"notification_sent\"")).length;
      await until(() => sentCount() > 0, "到点后发出提醒通知", 20000, 250);

      // 暂停通知期间到点的提醒不发，也不丢：恢复后补上（托盘与设置里的「暂停通知」）。
      const before = sentCount();
      await main.invoke("set_notifications_paused", { paused: true });
      await main.invoke("create_item", {
        request: {
          itemType: "todo",
          title: `e2e-paused-${index}`,
          content: null,
          contentFormat: null,
          priority: null,
          scheduled: null,
          due: null,
          reminderAt: new Date(Date.now() + 2000).toISOString(),
          projectId: null,
        },
      });
      await sleep(5000);
      if (sentCount() !== before) throw new Error("暂停通知期间仍然发出了提醒");
      await main.invoke("set_notifications_paused", { paused: false });
      await until(() => sentCount() > before, "恢复通知后补发暂停期间到点的提醒", 20000, 250);
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

        // 普通 Enter 保留标题草稿，Ctrl+Enter 创建。
        const before = foregroundWindow();
        const addButton = await openAddButton();
        const clicked = Date.now();
        await click(addButton);
        await until(() => floating.evaluate(inputReady), "Quick Create 输入框拿到真实焦点", 20000, 5);
        quickCreateTimings.click.push(Date.now() - clicked);
        const quickTitle = `e2e-quick-${index}`;
        await floating.send("Input.insertText", { text: quickTitle });
        await key("Enter", 13);
        if (await floating.evaluate("document.activeElement?.value") !== quickTitle)
          throw new Error("普通 Enter 没有保留标题草稿");
        if ((await main.invoke("get_today")).todos.some((item) => item.title === quickTitle))
          throw new Error("普通 Enter 意外创建了待办");
        pressHotkey([0x11, 0x0d]);
        await until(async () => {
          const today = await main.invoke("get_today");
          return today.todos.at(-1)?.title === quickTitle &&
            today.todos.filter((item) => item.title === quickTitle).length === 1;
        }, "新待办出现在 Today 末尾");
        await until(() => foregroundWindow() === before, "创建后焦点还给之前的前台窗口", 5000);
        if (await floating.evaluate("document.hasFocus()")) throw new Error("创建后焦点残留在悬浮窗");

        // 用全局快捷键打开后续草稿，避免 CDP 光标和真实光标在窗口缩放后争夺悬停。
        const countBefore = (await main.invoke("get_today")).todos.length;
        await main.invoke("set_shortcut", { action: "quickCreate", accelerator: "Ctrl+Alt+Shift+F8" });
        await until(() => foregroundWindow() === before, "再次打开前焦点已恢复");
        pressHotkey([0x11, 0x12, 0x10, 0x77]);
        await until(() => floating.evaluate(inputReady), "空白草稿拿到焦点");
        await key("Escape", 27);
        await until(() => floating.evaluate("!document.querySelector('[aria-label=标题],[aria-label=Title]')"), "空白草稿直接关闭");
        await until(() => foregroundWindow() === before, "空白草稿取消后焦点已恢复");
        pressHotkey([0x11, 0x12, 0x10, 0x77]);
        await until(() => floating.evaluate(inputReady), "第二次 Quick Create 拿到焦点");
        await floating.send("Input.insertText", { text: "e2e-should-not-exist" });
        await key("Escape", 27);
        const discard = await until(() => floating.evaluate(`(() => {
          const button = document.querySelector('form button[data-variant=danger]')
            ?? [...document.querySelectorAll('form button')].find((b) => ['放弃内容', 'Discard'].includes(b.textContent.trim()));
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return [rect.x + rect.width / 2, rect.y + rect.height / 2];
        })()`), "非空草稿显示放弃确认");
        await click(discard);
        await until(() => floating.evaluate("!document.querySelector('[aria-label=标题],[aria-label=Title]')"), "Esc 之后输入框消失");
        await until(() => foregroundWindow() === before, "取消后焦点还给之前的前台窗口", 5000);
        const after = await main.invoke("get_today");
        if (after.todos.length !== countBefore) throw new Error("Esc 之后 Today 的待办数变了");
        if ((await main.invoke("search_items", { query: "e2e-should-not-exist" })).length > 0) throw new Error("Esc 之后仍然创建了条目");
      });
    }

    // 11.6（--native）Quick Create 的全局快捷键：其他应用在前台时按下，输入后点击创建，
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
        await floating.evaluate("document.querySelector('form button[type=submit]').click()");
        await until(async () => {
          const today = await main.invoke("get_today");
          return today.todos.at(-1)?.title === viaHotkey &&
            today.todos.filter((item) => item.title === viaHotkey).length === 1;
        }, "创建按钮只创建一条待办");
        await until(() => foregroundWindow() === before, "创建后焦点回到之前的应用", 5000);
      });
      await step("全局快捷键预填真实选区", () => checkNativeContextCreate({ main, floating }));

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
          realDrag(from, [to[0], to[1] - 6], 12, 150);
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
      await step("拖入文件（真实 OLE 拖放）", () => checkNativeOle({ main, floating, data, index }));

      // 11.9（--native）拖动徽标并吸附（产品文档 §28「拖动、吸附」）：真实鼠标把收起的徽标拖到离工作区右边
      // 10px 处松开，窗口贴到右边缘、竖直位置不变。
      await step("拖动徽标吸附到边缘（真实鼠标）",()=>checkNativeBadgeDrag({main,floating,child,index}));
      await step("长按拖动悬停展开的面板（真实鼠标）",()=>checkNativePanelDrag(floating));
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
          await until(() => foregroundWindow() === previousForeground, "Esc 之后焦点回到原来的前台窗口", 5000).catch(() => {
            const logs = readdirSync(join(data, "data", "logs")).map((f) => readFileSync(join(data, "data", "logs", f), "utf8")).join("\n");
            const trace = logs.split("\n").filter((l) => /foreground_|search_focus/.test(l)).slice(-6).map((l) => l.replace(/^\S+\s+/, "").slice(0, 200)).join(" | ");
            throw new Error(`Esc 之后焦点没有回到原来的前台窗口：原来 ${previousForeground}，现在 ${foregroundWindow()}（${foregroundOwner()}，被测进程 ${child.pid}）；日志：${trace || "无"}`);
          });

          // 再按一次：出现时是干净的、焦点在输入框。
          const againStarted = pressSearchHotkey();
          await until(() => search.evaluate(`document.hasFocus() && document.activeElement?.value === '' && ${inputFocused}`), "再次出现时输入已清空并聚焦", 20000, 5);
          hotkeyTimings.again.push(Date.now() - againStarted);
          await until(() => visibleWindowCount(child.pid) === shown, "再次出现");
          if (warmActivations.length === 0 && WARM_RUNS > 0) {
            for (let attempt=0;attempt<WARM_RUNS;attempt++) {
              await search.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
              await search.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
              await until(()=>search.evaluate('!document.hasFocus()'),'warm activation: previous app focus',5000,5);
              const started=pressSearchHotkey();
              await until(()=>search.evaluate(`document.hasFocus() && ${inputFocused}`),'warm activation input focus',5000,5);
              warmActivations.push(Date.now()-started);
              await sleep(150);
            }
          }

          // Ctrl+D（P1.3）：在搜索框里直接完成选中的待办，窗口不关；提示还在时 Ctrl+Z 撤销。
          // 走真实的 search.json 权限，缺了 complete_item / reopen_item 会在这里失败。
          const doneTitle = `e2e-search-done-${index}`;
          await main.invoke("quick_create", { request: { itemType: "todo", title: doneTitle, scheduled: null } });
          await search.send("Input.insertText", { text: doneTitle });
          await until(() => search.evaluate(`document.hasFocus() && document.activeElement===document.querySelector('input') && document.querySelector('[role=option][aria-selected=true]')?.textContent.includes(${JSON.stringify(doneTitle)}) && [...document.querySelectorAll('footer button')].some(b=>!b.disabled && b.textContent.includes('Ctrl+D'))`), "Ctrl+D：当前结果与完成操作就绪");
          /** Ctrl + 字母（CDP 的 modifiers 2 是 Ctrl）。 */
          const ctrlLetter = async (letter) => {
            const event = { key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers: 2 };
            await search.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
            await search.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
          };
          const doneStatus = async () => (await main.invoke("search_items", { query: doneTitle })).find((i) => i.title === doneTitle)?.status;
          await ctrlLetter("d");
          // 撤销提示只留 5 秒（DONE_UNDO_MS）：出现之后立刻按 Ctrl+Z，慢的 Win32 检查（每次约 2 秒）放到后面。
          await until(() => search.evaluate("document.body.innerText.includes('Ctrl+Z')"), "Ctrl+D 之后出现撤销").catch(async error=>{throw Error(error.message+' '+JSON.stringify({status:await doneStatus(),ui:await search.evaluate(`({focus:document.hasFocus(),active:document.activeElement?.outerHTML,footer:document.querySelector('footer')?.innerText,error:document.querySelector('[role=alert]')?.innerText})`)}));});
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
    }
    if (NATIVE && (SEARCH_ZOOM_ONLY || CHECK_ZOOM)) await step("200% search zoom and stable fitting",()=>checkNativeSearchZoom({main,floating,index}));
    if (PANEL_DRAG_ONLY) await step("isolated native panel drag",()=>checkNativePanelDrag(floating));
    else if (DRAG_ONLY) await step("isolated native badge drag",()=>checkNativeBadgeDrag({main,floating,child,index}));
    if (OLE_ONLY) await step("isolated native OLE drop",()=>checkNativeOle({main,floating,data,index}));
    if (BROWSER_DROP_ONLY) await step("Chrome 网页链接真实拖放", () => checkNativeBrowserDrop({ main, floating, data, index }));
    if (EXPLORER_DROP_ONLY) await step("资源管理器文件真实拖放", () => checkNativeExplorerDrop({ main, floating, data, index }));
    if (IME_ONLY) await step("微软拼音组字与快捷提交", () => checkNativeIme({ main, floating }));
    if (CONTEXT_CREATE_ONLY) await step("全局快捷键预填真实选区", () => checkNativeContextCreate({ main, floating }));
    if (ZOOM_ONLY) await main.invoke('quick_create',{request:{itemType:'todo',title:'zoom fixture',scheduled:null}});
    if (NATIVE && CHECK_ZOOM) await step('200% WebView2 content zoom',async()=>{
      await floating.invoke('open_main_at',{view:'today'});
      focusLargestWindow(child.pid);
      const before=await main.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
      const floatingDprBefore=await floating.evaluate('devicePixelRatio');
      await main.evaluate(`document.querySelector('main li button.text-left').click()`);
      await until(()=>main.evaluate('!!document.querySelector(".nv-detail-panel input")'),'item editor before zoom');
      await main.evaluate(`(() => {window.__zoomInput=document.querySelector('.nv-detail-panel input');window.__zoomTitle=window.__zoomInput.value;window.__zoomInput.focus();window.__zoomInput.setSelectionRange(1,2)})()`);
      try {
        win32(`for($n=0;$n -lt 5;$n++){ [E2E.Native]::keybd_event(0x11,0,0,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x6B,0,0,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x6B,0,2,[System.UIntPtr]::Zero); [E2E.Native]::keybd_event(0x11,0,2,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 100 }`);
        await until(()=>main.evaluate(`devicePixelRatio >= ${before.dpr*1.99}`),'WebView2 zoom reaches 200%',5000);
        const after=await main.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth})');
        if(after.overflow||Math.abs(after.width*2-before.width)>4)throw Error('Zoom did not reflow: '+JSON.stringify({before,after}));
        const editor=await main.evaluate(`(() => {const panel=document.querySelector('.nv-detail-panel');const input=panel.querySelector('input');return {modal:panel.getAttribute('aria-modal'),title:input.value,stable:input===window.__zoomInput&&input.value===window.__zoomTitle,selection:[input.selectionStart,input.selectionEnd],focus:document.activeElement===input,dates:panel.querySelectorAll('input[type=date]').length}})()`);
        const floatingDprAfter=await floating.evaluate('devicePixelRatio');
        if(editor.modal!=='true'||!editor.focus||!editor.stable||editor.dates!==2||floatingDprAfter!==floatingDprBefore)throw Error('Zoomed editor/badge lost its state: '+JSON.stringify({before,after,editor,floatingDprBefore,floatingDprAfter,dialog:await main.evaluate("[...document.querySelectorAll('[role=dialog]')].map(e=>({name:e.getAttribute('aria-label'),text:e.innerText.slice(0,120)}))")}));
        const screenshot=await main.send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(EVIDENCE,`main-200pct-${index}.png`),Buffer.from(screenshot.result.data,'base64'));
        zoomRecords.push({run:index,before,after,editor,floatingDprBefore,floatingDprAfter,screenshotSha256:createHash('sha256').update(Buffer.from(screenshot.result.data,'base64')).digest('hex'),method:'Real Win32 Ctrl+NumpadAdd; DOM viewport/DPR measured, not a resized browser mock'});
      } finally {
        pressHotkey([0x11,0x30]);
      }
    });
    if (NATIVE && BADGE_MATRIX && index===1) await step('Native badge size matrix',async()=>{
      const original=cursorPosition();
      try {
        await floating.invoke('open_main_at',{view:'settings'});
        await until(()=>main.evaluate('!!document.querySelector("#settings-appearance")'),'appearance settings');
        const cases=[
          {name:'robot',mode:['机器人','Robot'],width:80,height:40},
          {name:'pill',mode:['经典徽标','Classic badge'],label:['胶囊','Pill'],width:64,height:32},
          {name:'circle',label:['数字','Number'],width:36,height:36},
          {name:'dot',label:['圆点','Dot'],width:28,height:28},
          {name:'skin',mode:['自定义图片','Custom images'],width:88,height:40},
        ];
        const clickAppearanceOption = (labels) => main.evaluate(`(() => {
          const section = document.querySelector('#settings-appearance');
          const button = [...section.querySelectorAll('button')].find(
            (option) => ${JSON.stringify(labels)}.includes(option.textContent.trim()),
          );
          if (!button) throw Error('Missing appearance option');
          button.click();
        })()`);
        for (const entry of cases) {
          if (entry.mode) await clickAppearanceOption(entry.mode);
          if(entry.name==='skin') {
            const path=join(data,'fixture-pixel.png');
            const pixel=new PNG({width:4,height:4});pixel.data.fill(255);
            writeFileSync(path,PNG.sync.write(pixel));
            const doc=await main.send('DOM.getDocument');
            const field=await main.send('DOM.querySelector',{nodeId:doc.result.root.nodeId,selector:'#settings-appearance input[type=file]'});
            await main.send('DOM.setFileInputFiles',{nodeId:field.result.nodeId,files:[path]});
          } else if (entry.label) await clickAppearanceOption(entry.label);
          realMouse(200,200);
          const measured=await until(()=>floating.evaluate(`(() => {if(document.querySelector('[aria-label="今日面板"],[aria-label="Today panel"]'))return null;return innerWidth===${entry.width}&&innerHeight===${entry.height}?{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,outerWidth,outerHeight,button:(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()}:null})()`),'native '+entry.name+' bounds',10000).catch(async error=>{throw Error(error.message+' '+JSON.stringify(await floating.evaluate(`({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,text:document.body.innerText.slice(-300),focused:document.hasFocus()})`)))});
          if(Math.abs(measured.button.width-entry.width)>1||Math.abs(measured.button.height-entry.height)>1)throw Error('Invisible badge hit area: '+JSON.stringify(measured));
          if (badgeScale !== null && Math.abs(measured.dpr * 100 - badgeScale) > 0.1) {
            throw Error(`Expected Windows display scale ${badgeScale}%, measured ${measured.dpr * 100}%`);
          }
          if (entry.name === 'robot') {
            const countBounds = await floating.evaluate(`(() => {
              const counter = document.querySelector('.nv-robot-counter');
              const figure = document.querySelector('.nv-robot-figure');
              const original = counter.innerHTML;
              try {
                return ['0', '9', '99', '99+'].map(value => {
                  counter.textContent = value;
                  const bounds = counter.getBoundingClientRect();
                  return {value, left:bounds.left, right:bounds.right, bottom:bounds.bottom,
                    figureRight:figure.getBoundingClientRect().right, fontSize:getComputedStyle(counter).fontSize};
                });
              } finally {
                counter.innerHTML = original;
              }
            })()`);
            if (countBounds.some(bounds => bounds.fontSize !== '14px' ||
              bounds.left < bounds.figureRight || bounds.right > entry.width || bounds.bottom > entry.height)) {
              throw Error('Robot count clipped or overlapping: ' + JSON.stringify(countBounds));
            }
            measured.countBounds = countBounds;
            const toggleCount = () => main.evaluate(`(() => {
              const buttons = document.querySelectorAll('#settings-appearance [role=switch]');
              const toggle = [...buttons].find(button =>
                ['显示数字', 'Show count'].includes(button.getAttribute('aria-label'))
              );
              if (!toggle) throw Error('Missing robot count toggle');
              toggle.click();
            })()`);
            await toggleCount();
            await until(() => floating.evaluate(`!!document.querySelector('[data-shape=robot]') &&
              !document.querySelector('.nv-robot-counter')`), 'robot count hidden in the native window');
            await toggleCount();
            await until(() => floating.evaluate("!!document.querySelector('.nv-robot-counter')"), 'robot count restored');
            measured.hiddenCount = true;

            if (BADGE_ONLY) {
              const title = 'Badge completion fixture';
              await main.invoke('quick_create', {request: {itemType:'todo', title, scheduled:null}});
              const item = (await main.invoke('search_items', {query:title})).find(item => item.title === title);
              if (!item) throw Error('Missing badge completion fixture');
              await main.invoke('reschedule_item', {id:item.id,target:{kind:'today'}});
              await until(() => floating.evaluate("document.querySelector('.nv-robot-counter')?.textContent === '1'"), 'one remaining task');
              await main.invoke('complete_item', {id:item.id});
              await until(() => floating.evaluate(`!!document.querySelector('[data-shape=robot] [data-expression=done]') &&
                !document.querySelector('.nv-robot-counter')`), 'robot completion expression');
              measured.completed = true;
            }
          }
          const frame=await floating.send('Page.captureScreenshot',{format:'png'});
          const bytes=Buffer.from(frame.result.data,'base64');
          writeFileSync(join(EVIDENCE,`badge-${entry.name}.png`),bytes);
          badgeRecords.push({...entry,measured,sha256:createHash('sha256').update(bytes).digest('hex'),scope:'Real WebView2 client/button bounds on current monitor; not proof of per-pixel OS click-through or mixed DPI'});
        }
      } finally { realMouse(original[0],original[1]); }
    });
    return steps;
  } finally {
    // 等进程真正退出再删数据目录：退出中的进程仍持有单实例锁，下一轮的启动会被转交给它。
    await stopInstance(child);
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
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
  ensureNoForeignInstance();
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-cold-"));
  const env = {
    ...process.env,
    NIVLO_DATA_DIR: join(data, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview-profile"),
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
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

/** 进程 `pid` 及其全部子孙进程（WebView2 的浏览器与渲染进程）的工作集之和，MB。 */
function treeWorkingSetMb(pid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize; $ids = @(${pid}); $added = $true; while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }; [math]::Round((($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object WorkingSetSize -Sum).Sum) / 1MB)`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim());
}

/**
 * （--native）「预先准备全局搜索框」：开启后重启，启动约 10 秒后后台出现隐藏的搜索窗口；
 * 第一次按快捷键的耗时与多占的内存都记下来。
 */
/**
 * （--native）主窗口还没创建时用真实鼠标点徽标：主窗口被创建并到前台，而且留在前台。
 *
 * 点击会让悬浮窗被激活、安排「把焦点还给之前的应用」；主窗口第一次创建比那个延迟慢，
 * 打开主窗口必须取消它，否则主窗口出现在之前的应用后面。
 */
async function badgeColdMainScenario() {
  ensureNoForeignInstance();
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-badge-"));
  const env = {
    ...process.env,
    NIVLO_DATA_DIR: join(data, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview-profile"),
    NIVLO_SKIP_FIRST_RUN_PROMPTS: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  };
  const original = cursorPosition();
  const child = spawn(EXE, [], { env, stdio: "ignore" });
  try {
    const [floatingPage] = await until(async () => {
      const pages = await listPages();
      return pages.length >= 1 ? pages : null;
    }, "悬浮窗页面");
    const floating = await connect(floatingPage.webSocketDebuggerUrl);
    await until(() => floating.evaluate("document.getElementById('root')?.children.length > 0"), "悬浮窗渲染");
    await sleep(1500);
    if ((await listPages()).length !== 1) throw new Error("启动时不应已有主窗口");

    focusWindow(USER_FOREGROUND);
    await until(() => foregroundWindow() === USER_FOREGROUND, "点击之前前台在别的应用", 5000);
    const badge = await floating.evaluate(
      "(() => { const k = devicePixelRatio; const r = document.querySelector('button').getBoundingClientRect(); return [(screenX + r.x + r.width / 2) * k, (screenY + r.y + r.height / 2) * k]; })()",
    );
    realMouse(badge[0], badge[1], true);
    await until(() => foregroundOwner().startsWith(`${child.pid} `), "主窗口被创建并到了前台", 8000).catch((e) => {
      throw new Error(`${e.message}（现在的前台：${foregroundOwner()}）`);
    });
    // 留在前台：延迟的「还焦点」不能在主窗口出现之后把它挤到后面去。
    await sleep(1500);
    if (!foregroundOwner().startsWith(`${child.pid} `)) {
      throw new Error(`主窗口出现后又被挤到后面：现在的前台是 ${foregroundOwner()}`);
    }
    floating.close();
  } finally {
    realMouse(original[0], original[1]);
    await stopInstance(child);
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

async function prewarmScenario() {
  ensureNoForeignInstance();
  await until(() => !testInstanceRunning(), "上一轮的被测进程退出", 15000);
  const data = mkdtempSync(join(tmpdir(), "nivlo-e2e-prewarm-"));
  const env = {
    ...process.env,
    NIVLO_DATA_DIR: join(data, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview-profile"),
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
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

/** 测试开始时用户所在的前台窗口（属于别的进程）。 */
const USER_FOREGROUND = NATIVE ? foregroundWindow() : "0";

try {
  ensureNoForeignInstance();
} catch (error) {
  console.error(error.message);
  process.exit(2);
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
if (NATIVE && !FOCUSED_RUN) {
  try {
    await coldMainScenario();
    console.log("✓ 主窗口未创建时从全局搜索框回车打开结果");
  } catch (e) {
    failed += 1;
    console.error(`✗ 主窗口未创建时从全局搜索框回车打开结果：${e.message}`);
  }
}
if (NATIVE && !FOCUSED_RUN) {
  try {
    await badgeColdMainScenario();
    console.log("✓ 主窗口未创建时点徽标：主窗口到前台并留在前台");
  } catch (e) {
    failed += 1;
    console.error(`✗ 主窗口未创建时点徽标：${e.message}`);
  }
}
if (NATIVE && !FOCUSED_RUN) {
  try {
    const { firstMs, extraMb } = await prewarmScenario();
    console.log(`✓ 预先准备全局搜索框：第一次唤出 ${firstMs} ms，进程树多占约 ${extraMb} MB`);
  } catch (e) {
    failed += 1;
    console.error(`✗ 预先准备全局搜索框：${e.message}`);
  }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
if (WARM_RUNS || CHECK_ZOOM || BADGE_MATRIX || SEARCH_ZOOM_ONLY) {
  const sorted=[...warmActivations].sort((a,b)=>a-b);
  const sourceFiles=Object.fromEntries(execFileSync('git',['diff','--name-only','--','apps/desktop','crates'],{cwd:ROOT,encoding:'utf8'}).trim().split(/\r?\n/).filter(file=>/\.(rs|tsx?|json|css)$/.test(file)).map(file=>[file,createHash('sha256').update(readFileSync(join(ROOT,file))).digest('hex')]));
  const metrics={harnessSha256:createHash('sha256').update(readFileSync(join(ROOT,'tests/e2e/e2e.mjs'))).digest('hex'),runtimeEnvironments,profileIsolation:'Temporary NIVLO_DATA_DIR and WEBVIEW2_USER_DATA_FOLDER; profile folder and fresh skin cache asserted',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),sourceFiles,executableSha256:createHash('sha256').update(readFileSync(EXE)).digest('hex'),timestamp:new Date().toISOString(),cold:hotkeyTimings.first,warm:warmActivations,warmMedian:sorted.length?median(sorted):null,warmP95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,budgetMs:150,quickCreate:quickCreateTimings,zoom:zoomRecords,badges:badgeRecords,failedScenarios:failed};
  metrics.warmBudgetPassed=sorted.length>=20&&metrics.warmP95<metrics.budgetMs;
  writeFileSync(join(EVIDENCE,'measurements.json'),JSON.stringify(metrics,null,2)+'\n');
  console.log(`Warm search focus: ${sorted.length} runs, median ${metrics.warmMedian}ms, p95 ${metrics.warmP95}ms`);
  if(WARM_RUNS>=20&&!metrics.warmBudgetPassed){failed+=1;console.error('Warm search focus budget failed (at least 20 samples; p95 below 150ms).');}
}
if (NATIVE && quickCreateTimings.click.length > 0) {
  console.log(`Quick Create 输入就绪：点「+ 待办」中位数 ${median(quickCreateTimings.click)} ms ${JSON.stringify(quickCreateTimings.click)}；快捷键 中位数 ${median(quickCreateTimings.hotkey)} ms ${JSON.stringify(quickCreateTimings.hotkey)}`);
}
if (NATIVE && hotkeyTimings.first.length > 0) {
  console.log(`全局搜索唤出（按键之后到输入框拿到焦点）：第一次 中位数 ${median(hotkeyTimings.first)} ms ${JSON.stringify(hotkeyTimings.first)}；之后 中位数 ${median(hotkeyTimings.again)} ms ${JSON.stringify(hotkeyTimings.again)}`);
}
process.exit(failed ? 1 : 0);
