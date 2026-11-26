//! 把浏览器标签页拖到悬浮窗上：在松手时截下这次拖动，读出那一页的网址，再让标签页回到原处。
//!
//! Chrome / Edge 等 Chromium 浏览器拖动标签页**不是系统拖放**：浏览器自己跟踪鼠标，把标签页拆成一个
//! 新窗口并用系统的「移动窗口」循环带着它走，因此悬浮窗的 HTML5 Drop 永远收不到任何东西
//! （资源管理器同样收不到）。这里的做法：
//!
//! 1. 监听系统的「移动窗口开始 / 结束」事件（`EVENT_SYSTEM_MOVESIZESTART` / `END`）。被移动的是认得的
//!    浏览器窗口时，在这次移动期间装一个低级鼠标钩子（`WH_MOUSE_LL`），移动结束就卸掉。
//! 2. 指针第一次进入悬浮窗时，开始用 UI Automation 读这个窗口地址栏里的网址（提前读，松手时多半已经读好）。
//! 3. 指针在悬浮窗上松开左键时，**吞掉这次松开**：浏览器的移动循环没有收到松手，标签页还「拿在手里」；
//!    等网址读好后替用户按一下 Esc —— 浏览器把这当作取消拖动，标签页回到原来的窗口和位置
//!    （整窗拖动时窗口回到原位）—— 再补一个松开左键，让系统的按键状态复原。最后把网址交给页面。
//!
//! 只认已知浏览器的进程（避免把同样基于 Chromium 的 Electron 应用里的输入框误当成地址栏）；
//! 读到的必须像网址，否则不交给页面（标签页照样回到原处）。Firefox 的标签页拖动本来就是系统拖放，
//! 走原有的 Drop 流程。
//!
//! 钩子都是事件驱动的：`WinEvent` 只在有窗口被移动时回调；鼠标钩子只在浏览器窗口被拖动的那几秒存在。
//! UI Automation 查询与按键模拟放在独立线程里，钩子回调本身立即返回。

// 本模块含 Win32 / COM 调用（后端规范 §9.4）：每个 `unsafe` 块都有 SAFETY 注释。
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, HWINEVENTHOOK, IUIAutomation, IUIAutomationValuePattern, SetWinEventHook,
    TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTUP,
    MOUSEINPUT, SendInput, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, GetClassNameW,
    GetWindowRect, GetWindowTextW, HHOOK, IsWindowVisible, LLMHF_INJECTED, MSLLHOOKSTRUCT,
    OBJID_WINDOW, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_LBUTTONUP, WM_MOUSEMOVE,
};

use crate::source_app::{process_image_stem, window_process_id};

/// 一次「标签页拖到悬浮窗上」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabDrop {
    /// 页面网址（`http(s)`）。
    pub url: String,
    /// 页面标题（从窗口标题去掉浏览器名）；认不出格式时为 `None`。
    pub title: Option<String>,
    /// 松手时指针的屏幕坐标（物理像素）。
    pub screen_x: i32,
    /// 同上。
    pub screen_y: i32,
}

/// 识别到标签页拖入时的回调；在工作线程上调用。
pub type TabDropCallback = Arc<dyn Fn(TabDrop) + Send + Sync>;

/// Chromium 顶层窗口的窗口类名。
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";

/// 认得的 Chromium 浏览器进程（可执行文件名，不含扩展名，小写）。
const BROWSERS: &[&str] = &[
    "chrome", "msedge", "brave", "vivaldi", "opera", "chromium", "arc",
];

/// 地址栏可能还没准备好（浏览器第一次被 UI Automation 查询时才开放无障碍树）：最多试几次、每次隔多久。
const READ_ATTEMPTS: u32 = 4;
/// 同上。
const READ_RETRY: Duration = Duration::from_millis(150);

/// 安装后的状态：悬浮窗句柄与回调。钩子回调没有用户数据参数，只能经由静态变量取得。
struct Watch {
    /// 悬浮窗自己的窗口句柄。
    own_hwnd: isize,
    /// 识别到标签页拖入时调用。
    callback: TabDropCallback,
}

/// 唯一的一份安装状态。
static WATCH: OnceLock<Watch> = OnceLock::new();

/// 把 `isize` 句柄还原为 `HWND`。
fn to_hwnd(handle: isize) -> HWND {
    HWND(handle as *mut c_void)
}

/// 把地址栏里的文字变成网址：浏览器常常省略 `https://`，这里补上；
/// 不像网址的（搜索词、`chrome://` 内部页、本地文件）返回 `None`。
#[must_use]
pub fn normalize_address(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.chars().any(char::is_whitespace) {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return (text.len() > lower.find("://")? + 3).then(|| text.to_owned());
    }
    // 其他协议（chrome://、edge://、file:///、about:、view-source: 等）不是可以收集的网页。
    let head = lower.split(['/', '?', '#']).next().unwrap_or_default();
    if lower.contains("://") || lower.starts_with("about:") || lower.starts_with("view-source:") {
        return None;
    }
    let host = head.rsplit_once('@').map_or(head, |(_, host)| host);
    let host_name = host.split(':').next().unwrap_or_default();
    if host_name == "localhost" || host_name.parse::<std::net::Ipv4Addr>().is_ok() {
        return Some(format!("http://{text}"));
    }
    let looks_like_domain = host_name.contains('.')
        && !host_name.starts_with('.')
        && !host_name.ends_with('.')
        && host_name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-'));
    looks_like_domain.then(|| format!("https://{text}"))
}

/// 从浏览器窗口标题里取页面标题：去掉末尾的「 - Google Chrome」之类（及其后的用户资料名）。
/// 认不出格式时返回 `None`（宁可没有，也不要把浏览器名当成标题）。
#[must_use]
pub fn page_title(window_title: &str) -> Option<String> {
    const SUFFIXES: &[&str] = &[
        " - Google Chrome",
        " - Microsoft\u{200b} Edge",
        " - Microsoft Edge",
        " - Brave",
        " - Vivaldi",
        " - Chromium",
        " - Opera",
    ];
    let cut = SUFFIXES
        .iter()
        .filter_map(|suffix| window_title.find(suffix))
        .min()?;
    let mut title = &window_title[..cut];
    // Edge 把用户资料名放在浏览器名前面：「页面 - 个人 - Microsoft Edge」。资料名无法与标题里的连字符区分，
    // 只去掉 Edge 默认的资料名。
    for profile in [" - Personal", " - 个人", " - Work", " - 工作"] {
        if let Some(stripped) = title.strip_suffix(profile) {
            title = stripped;
        }
    }
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// 窗口类名。
fn class_name(hwnd: isize) -> String {
    let mut buffer = [0_u16; 64];
    // SAFETY: `buffer` 是可写的缓冲区，函数最多写入其长度个字符；窗口不存在时返回 0。
    let length = unsafe { GetClassNameW(to_hwnd(hwnd), &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)])
}

/// 窗口标题。
fn window_text(hwnd: isize) -> String {
    let mut buffer = [0_u16; 512];
    // SAFETY: `buffer` 是可写的缓冲区，函数最多写入其长度个字符；窗口不存在时返回 0。
    let length = unsafe { GetWindowTextW(to_hwnd(hwnd), &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)])
}

/// 是否是认得的 Chromium 浏览器的顶层窗口。
fn is_browser_window(hwnd: isize) -> bool {
    class_name(hwnd) == CHROMIUM_WINDOW_CLASS
        && window_process_id(hwnd)
            .and_then(process_image_stem)
            .is_some_and(|stem| BROWSERS.contains(&stem.to_ascii_lowercase().as_str()))
}

/// 屏幕上的一点是否在（可见的）悬浮窗上。
fn over_badge(own_hwnd: isize, point: POINT) -> bool {
    let own = to_hwnd(own_hwnd);
    // SAFETY: `IsWindowVisible` 接受任意句柄值。
    if !unsafe { IsWindowVisible(own) }.as_bool() {
        return false;
    }
    let mut rect = RECT::default();
    // SAFETY: `rect` 是有效的输出指针；窗口不存在时函数失败。
    if unsafe { GetWindowRect(own, &raw mut rect) }.is_err() {
        return false;
    }
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

/// 本线程的 COM 初始化；释放时反初始化。
struct ComScope;

impl ComScope {
    /// 以多线程套间初始化本线程的 COM。
    fn enter() -> Option<Self> {
        // SAFETY: 在本线程第一次使用 COM 之前调用；成功（含 S_FALSE）时由 `Drop` 配对反初始化。
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .ok()
            .map(|()| Self)
    }
}

impl Drop for ComScope {
    /// 与 `enter` 配对的反初始化。
    fn drop(&mut self) {
        // SAFETY: 只有 `enter` 成功时才会构造本类型，每次构造只反初始化一次。
        unsafe { CoUninitialize() };
    }
}

/// 用 UI Automation 读出浏览器窗口地址栏（窗口里第一个编辑框）的内容并规范成网址。
fn read_address(hwnd: isize) -> Option<String> {
    let _com = ComScope::enter()?;
    // SAFETY: 本线程已初始化 COM；`CUIAutomation` 是系统提供的进程内 COM 类。
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
    // SAFETY: 句柄只是被传给 UI Automation 查询；窗口不存在时调用失败。
    let root = unsafe { automation.ElementFromHandle(to_hwnd(hwnd)) }.ok()?;
    // SAFETY: 属性 ID 与值的类型匹配（控件类型是整数）。
    let condition = unsafe {
        automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_EditControlTypeId.0),
        )
    }
    .ok()?;
    for attempt in 0..READ_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(READ_RETRY);
        }
        // SAFETY: `root` 与 `condition` 都是上面取得的有效 COM 对象；找不到时返回错误。
        let Ok(edit) = (unsafe { root.FindFirst(TreeScope_Descendants, &condition) }) else {
            continue;
        };
        // SAFETY: 请求的模式 ID 与接口类型一致；编辑框不支持该模式时返回错误。
        let Ok(value) =
            (unsafe { edit.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) })
        else {
            continue;
        };
        // SAFETY: `value` 是有效的 COM 对象。
        if let Ok(text) = unsafe { value.CurrentValue() } {
            return normalize_address(&text.to_string());
        }
    }
    None
}

/// 读网址最多等多久（松手之后标签页仍「拿在手里」，不能让用户等太久）。
const READ_WAIT: Duration = Duration::from_millis(2000);

/// 按下 Esc 之后、补发松开左键之前的间隔：让浏览器先处理完取消。
const CANCEL_SETTLE: Duration = Duration::from_millis(60);

/// 一次正在进行的浏览器窗口移动。
struct MoveSession {
    /// 被移动的浏览器窗口。
    window: isize,
    /// 这次移动期间的低级鼠标钩子（`HHOOK` 的数值）；0 表示没装上。
    mouse_hook: isize,
    /// 读网址的结果；指针第一次进入悬浮窗时开始读。
    reading: Option<Receiver<Option<String>>>,
    /// 已经在悬浮窗上松手（之后的事件都不再处理）。
    dropped: bool,
}

/// 当前的移动；钩子回调没有用户数据参数，只能经由静态变量取得。所有访问都在主线程上。
static SESSION: Mutex<Option<MoveSession>> = Mutex::new(None);

/// 在新线程上读窗口地址栏，返回取结果的通道。
fn start_reading(window: isize) -> Receiver<Option<String>> {
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("stardeskbox-tab-read".to_owned())
        .spawn(move || {
            let _ = sender.send(read_address(window));
        });
    drop(spawned);
    receiver
}

/// 模拟输入：先按下并松开 Esc（浏览器取消拖动，标签页回到原处），稍等后松开左键（复原系统的按键状态，
/// 因为真正的松开已经被吞掉了）。
fn cancel_drag_and_release() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let escape = [key(Default::default()), key(KEYEVENTF_KEYUP)];
    let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(i32::MAX);
    // SAFETY: `escape` 是有效的 `INPUT` 数组，`size` 是单个元素的大小。
    unsafe { SendInput(&escape, size) };
    std::thread::sleep(CANCEL_SETTLE);
    let release = [INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: MOUSEEVENTF_LEFTUP,
                ..Default::default()
            },
        },
    }];
    // SAFETY: 同上。
    unsafe { SendInput(&release, size) };
}

/// 低级鼠标钩子：只在浏览器窗口被拖动期间存在。
///
/// # Safety
///
/// 只能由系统作为 `WH_MOUSE_LL` 钩子调用；`code >= 0` 时 `lparam` 指向有效的 `MSLLHOOKSTRUCT`。
unsafe extern "system" fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0
        && let Some(watch) = WATCH.get()
    {
        // SAFETY: 系统保证 `code >= 0` 时 `lparam` 指向本次事件的 `MSLLHOOKSTRUCT`，在回调期间有效。
        let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        // 自己补发的松开（以及其他程序模拟的输入）一律放行。
        let injected = event.flags & LLMHF_INJECTED != 0;
        let message = u32::try_from(wparam.0).unwrap_or(0);
        if !injected && (message == WM_MOUSEMOVE || message == WM_LBUTTONUP) {
            let mut guard = SESSION
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(session) = guard.as_mut().filter(|session| !session.dropped)
                && over_badge(watch.own_hwnd, event.pt)
            {
                let reading = session
                    .reading
                    .get_or_insert_with(|| start_reading(session.window));
                if message == WM_LBUTTONUP {
                    session.dropped = true;
                    let reading = std::mem::replace(reading, mpsc::channel().1);
                    let window = session.window;
                    let point = event.pt;
                    let callback = Arc::clone(&watch.callback);
                    let spawned = std::thread::Builder::new()
                        .name("stardeskbox-tab-drop".to_owned())
                        .spawn(move || {
                            // 先读完（窗口还在），再取消拖动：取消后拆出来的窗口就消失了。
                            let title = page_title(&window_text(window));
                            let url = reading.recv_timeout(READ_WAIT).ok().flatten();
                            cancel_drag_and_release();
                            if let Some(url) = url {
                                callback(TabDrop {
                                    url,
                                    title,
                                    screen_x: point.x,
                                    screen_y: point.y,
                                });
                            }
                        });
                    if spawned.is_ok() {
                        // 吞掉这次松开：浏览器以为标签页还拿在手里，等上面的线程替它取消。
                        return LRESULT(1);
                    }
                }
            }
        }
    }
    // SAFETY: 原样传给下一个钩子。
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// 卸掉一次移动的鼠标钩子。
fn unhook_mouse(session: &MoveSession) {
    if session.mouse_hook != 0 {
        // SAFETY: 句柄来自本模块成功的 `SetWindowsHookExW`，每个会话只卸一次。
        let _ = unsafe { UnhookWindowsHookEx(HHOOK(session.mouse_hook as *mut c_void)) };
    }
}

/// `WinEvent` 回调：某个窗口的移动 / 缩放开始或结束了。
///
/// # Safety
///
/// 只能由系统作为 `WinEvent` 回调调用；这里不解引用任何参数，只读取窗口句柄。
unsafe extern "system" fn on_move_size(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if id_object != OBJID_WINDOW.0 {
        return;
    }
    let Some(watch) = WATCH.get() else {
        return;
    };
    let moved = hwnd.0 as isize;
    let mut guard = SESSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // 不论开始还是结束，先收拾上一次（结束事件丢失时也不会留下钩子）。
    if let Some(previous) = guard.take() {
        unhook_mouse(&previous);
    }
    if event != EVENT_SYSTEM_MOVESIZESTART || moved == watch.own_hwnd || !is_browser_window(moved) {
        return;
    }
    // SAFETY: 取本进程主模块的句柄，没有前置条件。
    let module = unsafe { GetModuleHandleW(None) }.ok();
    // SAFETY: 回调是在整个进程生命周期内存在的 `extern "system"` 函数；低级钩子不注入其他进程，
    // 回调在本线程（有消息循环的主线程）上执行。
    let mouse_hook =
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module.map(Into::into), 0) }
            .map_or(0, |hook| hook.0 as isize);
    *guard = Some(MoveSession {
        window: moved,
        mouse_hook,
        reading: None,
        dropped: false,
    });
}

/// 开始识别「把浏览器标签页拖到悬浮窗上」。只能安装一次；钩子随进程存在。
///
/// 钩子回调经由安装线程的消息循环投递，因此必须在带消息循环的线程（Tauri 主线程）上调用。
///
/// # Errors
///
/// 已经安装过，或系统拒绝安装钩子时返回说明文字。
pub fn watch_tab_drops(own_hwnd: isize, callback: TabDropCallback) -> Result<(), &'static str> {
    WATCH
        .set(Watch { own_hwnd, callback })
        .map_err(|_| "已经安装过")?;
    // SAFETY: 回调是在整个进程生命周期内存在的 `extern "system"` 函数；
    // `WINEVENT_OUTOFCONTEXT` 让回调在本线程上异步执行，不注入其他进程。
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_MOVESIZESTART,
            EVENT_SYSTEM_MOVESIZEEND,
            None,
            Some(on_move_size),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if hook.0.is_null() {
        Err("系统拒绝安装钩子")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_address, page_title};

    #[test]
    fn address_without_scheme_becomes_https() {
        assert_eq!(
            normalize_address("github.com").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(
            normalize_address("github.com/liulewis67-ops/rust_training?tab=readme#top").as_deref(),
            Some("https://github.com/liulewis67-ops/rust_training?tab=readme#top")
        );
        assert_eq!(
            normalize_address(" 例子.中国/页 ").as_deref(),
            Some("https://例子.中国/页")
        );
    }

    #[test]
    fn full_urls_are_kept() {
        assert_eq!(
            normalize_address("https://chatgpt.com/c/6aed").as_deref(),
            Some("https://chatgpt.com/c/6aed")
        );
        assert_eq!(
            normalize_address("HTTP://Example.com").as_deref(),
            Some("HTTP://Example.com")
        );
        assert_eq!(normalize_address("https://"), None);
    }

    #[test]
    fn local_hosts_use_http() {
        assert_eq!(
            normalize_address("localhost:5173/a").as_deref(),
            Some("http://localhost:5173/a")
        );
        assert_eq!(
            normalize_address("127.0.0.1:8080").as_deref(),
            Some("http://127.0.0.1:8080")
        );
    }

    #[test]
    fn non_pages_are_rejected() {
        for text in [
            "",
            "rust training",
            "chrome://newtab",
            "edge://settings",
            "file:///C:/a.txt",
            "about:blank",
            "view-source:https://a.com",
            "readme",
            "main.",
        ] {
            assert_eq!(normalize_address(text), None, "{text}");
        }
    }

    #[test]
    fn titles_drop_the_browser_name() {
        assert_eq!(
            page_title("GitHub - Google Chrome").as_deref(),
            Some("GitHub")
        );
        assert_eq!(
            page_title("A - B - Google Chrome - Work").as_deref(),
            Some("A - B")
        );
        assert_eq!(
            page_title("Dashboard - Personal - Microsoft\u{200b} Edge").as_deref(),
            Some("Dashboard")
        );
        assert_eq!(page_title("Google Chrome"), None);
        assert_eq!(page_title(" - Google Chrome"), None);
        assert_eq!(page_title("Some App"), None);
    }
}

/// 手动验证：对本机正在运行的每个 Chromium 浏览器窗口读一次地址栏（`cargo test -- --ignored live_`）。
#[cfg(test)]
#[allow(clippy::print_stdout)]
mod live {
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, IsWindowVisible};
    use windows::core::w;

    #[test]
    #[ignore = "需要正在运行的浏览器"]
    fn live_read_open_browser_windows() {
        let mut after = None;
        loop {
            // SAFETY: 按类名枚举顶层窗口；`after` 是上一次返回的有效句柄或 None。
            let Ok(hwnd) = (unsafe { FindWindowExW(None, after, w!("Chrome_WidgetWin_1"), None) })
            else {
                break;
            };
            after = Some(hwnd);
            let handle = hwnd.0 as isize;
            // SAFETY: `IsWindowVisible` 接受任意句柄值。
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() || !super::is_browser_window(handle) {
                continue;
            }
            let started = std::time::Instant::now();
            println!(
                "{:?} | {:?} | {:?}",
                super::page_title(&super::window_text(handle)),
                super::read_address(handle),
                started.elapsed()
            );
        }
    }
}
