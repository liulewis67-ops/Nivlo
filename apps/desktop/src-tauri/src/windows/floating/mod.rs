//! 悬浮窗位置控制器：启动时还原位置，拖动结束后吸附并保存。
//!
//! 用户拖动无边框窗口时，系统不会给出"拖动结束"事件，只有连续的 `Moved`。
//! 因此这里对 `Moved` 做防抖：最后一次移动之后安静一小段时间（`SETTLE_DELAY`），就认为拖动结束，
//! 然后一次性完成"吸附 → 保存"，既不会在拖动过程中和系统抢位置（卡顿 / 闪烁），
//! 也不会每个像素都写一次数据库。具体的吸附与跨显示器 / DPI 计算在
//! [`nivlo_platform::placement`] 中，这里只负责时序与持久化。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use nivlo_application::settings::{SettingsService, keys};
use nivlo_platform::error::PlatformError;
use nivlo_platform::floating_window::FloatingWindowPort;
use nivlo_platform::foreground::ForegroundPort;
use nivlo_platform::placement::{
    COLLAPSED_HEIGHT_LOGICAL_PX, COLLAPSED_WIDTH_LOGICAL_PX, ExpandedLayout, Placement, Point,
    Rect, default_placement, expand_bounds, placement_for_bounds, resolve_position,
};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

/// 最后一次 `Moved` 之后多久认为拖动已经结束。
///
/// 太短会在用户短暂停顿时提前吸附，太长则松手后窗口"迟钝"；150ms 是手感与稳定性的折中。
const SETTLE_DELAY: Duration = Duration::from_millis(150);

/// 悬浮窗被误激活后等多久再把焦点还回去：让这次点击的激活（含 WebView2 的 `SetFocus`）先走完。
const FOCUS_RETURN_DELAY: Duration = Duration::from_millis(60);

/// 面板展开期间检查"指针是否还在窗口内"的间隔。
///
/// WebView 在指针被快速甩出窗口时可能不会投递 `pointerleave`（已在 Windows 11 + WebView2 上
/// 复现），面板会一直停在展开状态。这个看门狗**只在面板展开期间运行**（通常是几秒），
/// 收起后立即停止，空闲时没有任何计时器，因此不违反"禁止轮询"的原则（后端规范 §7）。
const WATCHDOG_INTERVAL: Duration = Duration::from_millis(150);

/// 悬浮窗的行为句柄：窗口事件回调与 IPC Command 通过它与位置控制器交互。
///
/// 做成 trait 对象是为了让 `AppState` 不必携带控制器的泛型参数（`FloatingController<P>`）。
pub trait FloatingHandle: Send + Sync {
    /// 窗口被移动到 `position`（物理像素）。由窗口事件回调调用——该回调在主线程上，不能阻塞。
    fn on_moved(&self, position: Point);

    /// 把窗口展开为 `panel_logical`（logical px）大小的 Today 面板，并返回展开后的布局。
    ///
    /// # Errors
    ///
    /// 没有可用显示器或窗口调用失败时返回 [`PlatformError`]。
    fn expand(&self, panel_logical: (f64, f64)) -> Result<ExpandedLayout, PlatformError>;

    /// 收起回 `badge_logical`（logical px）大小的徽标，位置与展开前一致。
    ///
    /// 徽标尺寸随形状 / 皮肤变化：尺寸和上次不同时，按原来的位置（贴边则仍贴边）换算成新尺寸重新落位；
    /// 未展开且尺寸没变时是空操作。
    ///
    /// # Errors
    ///
    /// 窗口调用失败时返回 [`PlatformError`]。
    fn collapse(&self, badge_logical: (f64, f64)) -> Result<(), PlatformError>;

    /// 立即把还没来得及落盘的窗口状态（拖动后的吸附位置）保存下来。退出流程在关闭数据库之前调用。
    fn flush(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;

    /// 开始文本输入（Quick Create）：记住用户当前的前台窗口，让悬浮窗临时可聚焦并获得键盘焦点。
    ///
    /// # Errors
    ///
    /// 窗口无法聚焦时返回 [`PlatformError`]；此时悬浮窗已恢复为不可聚焦，调用方应放弃输入。
    fn begin_input(&self) -> Result<(), PlatformError>;

    /// 将配置页置于当前显示器工作区中央，保留徽标位置。
    ///
    /// # Errors
    ///
    /// 显示器或窗口不可用时返回平台错误。
    fn configure_input(&self) -> Result<(), PlatformError>;

    /// 立即修改悬浮窗是否置顶（设置页）。持久化由调用方负责。
    ///
    /// # Errors
    ///
    /// 窗口调用失败时返回 [`PlatformError`]。
    fn set_always_on_top(&self, enabled: bool) -> Result<(), PlatformError>;

    /// 显示器配置变化（拔掉 / 接上显示器、分辨率或缩放比例改变）：把徽标放回保存位置所在的显示器；
    /// 那块显示器已经不存在时回到主显示器可见区域。展开期间先收起再重新定位。
    fn on_display_changed(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;

    /// 悬浮窗变成了前台窗口。不在 Quick Create 输入期间时这是「误激活」：窗口虽然带
    /// `WS_EX_NOACTIVATE`，但点击落在 WebView2 的子窗口上，WebView2 会自己 `SetFocus`，
    /// 把悬浮窗拉到前台。这里立即把前台还给用户之前的应用，悬停与点击都不会抢走焦点。
    fn on_focused(&self);

    /// 用户要切到拾序（点徽标、面板里的按钮打开主窗口）：取消尚未执行的「把焦点还回去」。
    ///
    /// 主窗口第一次打开要先创建窗口（几百毫秒），比还焦点的延迟长；不取消的话，焦点会先被还给
    /// 之前的应用，主窗口随后出现在它后面。
    fn cancel_focus_return(&self);

    /// 结束文本输入：悬浮窗恢复为不可聚焦，并把焦点还给用户之前的窗口。可以重复调用。
    ///
    /// # Errors
    ///
    /// 窗口调用失败时返回 [`PlatformError`]；还原前台窗口失败只记录日志、不视为错误。
    fn end_input(&self) -> Result<(), PlatformError>;
}

/// 悬浮窗位置控制器。
pub struct FloatingController<P: FloatingWindowPort + 'static> {
    /// 指向自身的弱引用：窗口事件回调只有 `&self`，派生后台任务时需要升级成 `Arc`。
    me: Weak<Self>,
    /// 窗口行为 Port。
    port: Arc<P>,
    /// 前台窗口的记忆 / 还原：Quick Create 结束后把焦点还给用户之前的应用。
    foreground: Arc<dyn ForegroundPort>,
    /// 设置服务，用于保存 / 读取位置与置顶偏好。
    settings: SettingsService,
    /// 看门狗发现指针已离开窗口时调用（宿主据此通知前端补发 `pointerLeave`）。
    on_pointer_outside: Arc<dyn Fn() + Send + Sync>,
    /// 用于派生后台任务的 Tokio 句柄（窗口事件回调不在 Tokio 运行时内）。
    runtime: Handle,
    /// 退出信号，取消尚未执行的吸附任务。
    shutdown: CancellationToken,
    /// 防抖代数：每次 `Moved` 加一，只有最新一代的定时任务才会执行吸附。
    generation: AtomicU64,
    /// 看门狗代数：每次展开 / 收起加一，旧一代的看门狗任务发现代数变化后退出。
    watchdog: AtomicU64,
    /// 展开期间保存的收起态外框；`Some` 表示当前处于展开状态。
    ///
    /// 展开 / 收起会让窗口位置与尺寸变化并产生 `Moved` 事件，这些不是用户拖动，
    /// 因此展开期间忽略移动事件，也不做吸附。
    collapsed: Mutex<Option<Rect>>,
    /// 收起态徽标的 logical 尺寸：由前端按形状 / 皮肤告知，默认是胶囊的尺寸。
    badge: Mutex<(f64, f64)>,
    /// 控制器自己发起的移动的目标位置，用来忽略自己触发的 `Moved` 事件。
    expected: Mutex<Option<Point>>,
    /// 最近一次保存的位置 JSON，内容没变时不重复写库。
    last_saved: Mutex<Option<String>>,
    /// 正在 Quick Create 输入：这期间悬浮窗本来就应该拿着焦点，不做「还回去」。
    input_active: AtomicBool,
    /// 完整配置页正在显示，显示器变化时保持配置几何。
    configuring: AtomicBool,
    /// 「把焦点还回去」的代数：每次激活加一，取消时也加一；延迟到了代数没变才还。
    focus_return: AtomicU64,
}

/// 获取互斥锁；锁中毒只会发生在其他线程 panic 之后，数据本身仍有效。
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<P: FloatingWindowPort + 'static> FloatingController<P> {
    /// 创建控制器。
    pub fn new(
        port: Arc<P>,
        settings: SettingsService,
        runtime: Handle,
        shutdown: CancellationToken,
        on_pointer_outside: Arc<dyn Fn() + Send + Sync>,
        foreground: Arc<dyn ForegroundPort>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            port,
            foreground,
            settings,
            on_pointer_outside,
            runtime,
            shutdown,
            generation: AtomicU64::new(0),
            watchdog: AtomicU64::new(0),
            collapsed: Mutex::new(None),
            badge: Mutex::new((COLLAPSED_WIDTH_LOGICAL_PX, COLLAPSED_HEIGHT_LOGICAL_PX)),
            expected: Mutex::new(None),
            last_saved: Mutex::new(None),
            input_active: AtomicBool::new(false),
            configuring: AtomicBool::new(false),
            focus_return: AtomicU64::new(0),
        })
    }

    /// 启动时应用保存的偏好：位置、置顶、不可聚焦。
    ///
    /// 位置还原到保存的显示器；该显示器不存在（如副显示器已拔掉）时回退到主显示器，
    /// 没有保存过位置时使用默认位置。任何一项失败都只记录日志、不阻止启动：
    /// 悬浮窗在默认位置仍然可用，用户可以拖动它。
    pub async fn restore(&self) {
        // 先收起到徽标大小：Windows 创建窗口时会把宽度夹到系统最小宽度，之后按徽标尺寸计算位置才准确。
        let badge = *lock(&self.badge);
        if let Err(error) = self.port.collapse(badge) {
            tracing::warn!(event = "floating_collapse_failed", %error, "收起悬浮窗失败");
        }
        if let Err(error) = self.restore_position().await {
            tracing::warn!(event = "floating_restore_failed", %error, "还原悬浮窗位置失败，使用默认位置");
        }

        let always_on_top = match self.settings.get(keys::FLOATING_ALWAYS_ON_TOP).await {
            Ok(Some(value)) => value != "false",
            _ => true,
        };
        if let Err(error) = self.port.set_always_on_top(always_on_top) {
            tracing::warn!(event = "floating_always_on_top_failed", %error, "设置悬浮窗置顶失败");
        }
        // 默认不可聚焦：Hover / 点击不能抢走用户正在使用的应用的焦点；
        // 平台不支持时降级为可聚焦，不是致命错误（架构文档 §53）。
        match self.port.set_focusable(false) {
            Ok(()) => {}
            Err(PlatformError::Unsupported(reason)) => {
                tracing::info!(event = "floating_focusable_unsupported", %reason, "平台不支持设置不可聚焦");
            }
            Err(error) => {
                tracing::warn!(event = "floating_focusable_failed", %error, "设置悬浮窗不可聚焦失败");
            }
        }
    }

    /// 读取保存的位置（或默认位置）并移动窗口。
    async fn restore_position(&self) -> Result<(), PlatformError> {
        let monitors = self.port.monitors()?;
        let saved = match self.settings.get(keys::FLOATING_PLACEMENT).await {
            Ok(Some(json)) => match serde_json::from_str::<Placement>(&json) {
                Ok(placement) => Some(placement),
                Err(error) => {
                    // 设置内容损坏时不报错给用户，直接回到默认位置，并覆盖掉坏数据。
                    tracing::warn!(event = "floating_placement_invalid", %error, "保存的悬浮窗位置无法解析");
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(event = "floating_placement_read_failed", %error, "读取悬浮窗位置失败");
                None
            }
        };
        let Some(placement) = saved.or_else(|| default_placement(&monitors)) else {
            return Err(PlatformError::Failed("没有可用的显示器".to_owned()));
        };
        let size = *lock(&self.badge);
        let Some((position, _monitor)) = resolve_position(&placement, size, &monitors) else {
            return Err(PlatformError::Failed("没有可用的显示器".to_owned()));
        };
        self.move_to(position)
    }

    /// 显示器配置变化后重新定位（见 [`FloatingHandle::on_display_changed`]）。
    pub async fn display_changed(&self) {
        if self.configuring.load(Ordering::SeqCst) {
            // 配置页保持打开，但关闭时的徽标也必须能回到仍然存在的工作区。
            let original = *lock(&self.collapsed);
            if let (Some(original), Ok(monitors)) = (original, self.port.monitors())
                && let Some(placement) = placement_for_bounds(original, &monitors)
                && let Some((position, _)) =
                    resolve_position(&placement, *lock(&self.badge), &monitors)
            {
                *lock(&self.collapsed) = Some(Rect {
                    x: position.x,
                    y: position.y,
                    ..original
                });
            }
            if let Err(error) = self.configure_input() {
                tracing::warn!(event = "floating_configuration_reposition_failed", %error, "重新定位配置页失败");
            }
            return;
        }
        // 展开着的面板外框是按旧的显示器布局算的：先收起，再按保存的位置重新定位。
        // 先把尺寸取出来：条件里的锁守卫会活到整个 if 结束，而 collapse 还要再锁一次。
        let badge = *lock(&self.badge);
        if lock(&self.collapsed).is_some()
            && let Err(error) = FloatingHandle::collapse(self, badge)
        {
            tracing::warn!(event = "floating_display_collapse_failed", %error, "显示器变化时收起悬浮窗失败");
        }
        match self.restore_position().await {
            Ok(()) => tracing::info!(
                event = "floating_display_changed",
                "显示器配置变化，悬浮窗已重新定位"
            ),
            Err(error) => {
                tracing::warn!(event = "floating_display_reposition_failed", %error, "显示器变化后重新定位悬浮窗失败");
            }
        }
    }

    /// 移动窗口，并记住目标位置以便忽略由此产生的 `Moved` 事件。
    fn move_to(&self, position: Point) -> Result<(), PlatformError> {
        *lock(&self.expected) = Some(position);
        self.port.move_to(position).inspect_err(|_| {
            *lock(&self.expected) = None;
        })
    }

    /// 拖动结束后的收尾：计算吸附位置、必要时移动窗口、保存位置。
    pub async fn settle(&self) {
        if let Err(error) = self.try_settle().await {
            tracing::warn!(event = "floating_settle_failed", %error, "悬浮窗吸附失败");
        }
    }

    /// [`FloatingController::settle`] 的实际逻辑。
    async fn try_settle(&self) -> Result<(), PlatformError> {
        if lock(&self.collapsed).is_some() {
            // 展开期间窗口的位置由展开 / 收起决定，不是用户拖动，不能据此吸附或保存。
            return Ok(());
        }
        let bounds = self.port.bounds()?;
        let monitors = self.port.monitors()?;
        let Some(placement) = placement_for_bounds(bounds, &monitors) else {
            return Ok(());
        };
        let size = *lock(&self.badge);
        // 用户只能拖动收起态的徽标（展开面板时窗口位置由 expand / collapse 决定，不走这里），
        // 因此按收起态的 logical 尺寸还原位置即可。
        if let Some((target, _)) = resolve_position(&placement, size, &monitors)
            && (target.x != bounds.x || target.y != bounds.y)
        {
            self.move_to(target)?;
        }
        self.save(&placement).await;
        Ok(())
    }

    /// 保存位置；内容与上次相同则跳过。
    async fn save(&self, placement: &Placement) {
        let Ok(json) = serde_json::to_string(placement) else {
            return;
        };
        if lock(&self.last_saved).as_deref() == Some(json.as_str()) {
            return;
        }
        match self.settings.set(keys::FLOATING_PLACEMENT, &json).await {
            Ok(()) => *lock(&self.last_saved) = Some(json),
            Err(error) => {
                tracing::warn!(event = "floating_placement_save_failed", %error, "保存悬浮窗位置失败");
            }
        }
    }
}

impl<P: FloatingWindowPort + 'static> FloatingController<P> {
    /// 启动（或重启）展开期间的看门狗：指针从窗口内移到窗口外时，边沿触发一次 `on_pointer_outside`。
    ///
    /// 重复展开（如面板变高）会让旧看门狗因代数变化而退出，同一时刻只有一个在运行。
    fn start_watchdog(&self) {
        let Some(this) = self.me.upgrade() else {
            return;
        };
        let generation = this.watchdog.fetch_add(1, Ordering::SeqCst) + 1;
        let runtime = this.runtime.clone();
        runtime.spawn(async move {
            let mut was_outside = false;
            loop {
                tokio::select! {
                    () = this.shutdown.cancelled() => return,
                    () = tokio::time::sleep(WATCHDOG_INTERVAL) => {}
                }
                if this.watchdog.load(Ordering::SeqCst) != generation {
                    return;
                }
                let (Ok(cursor), Ok(bounds)) = (this.port.cursor_position(), this.port.bounds())
                else {
                    // 读不到位置时放弃兜底（DOM 事件仍然有效），不要反复失败刷日志。
                    return;
                };
                let outside = !bounds.contains(cursor);
                if outside && !was_outside {
                    (this.on_pointer_outside)();
                }
                was_outside = outside;
            }
        });
    }

    /// 把窗口调整为 `rect`（位置与尺寸），并记住目标位置以便忽略由此产生的 `Moved` 事件。
    fn move_to_rect(&self, rect: Rect) -> Result<(), PlatformError> {
        *lock(&self.expected) = Some(Point {
            x: rect.x,
            y: rect.y,
        });
        self.port.expand(rect).inspect_err(|_| {
            *lock(&self.expected) = None;
        })
    }

    /// 徽标换了尺寸：先按当前外框算出位置（吸附边缘 + 相对比例），换成新尺寸后再按它落位，
    /// 贴在右边缘的徽标变宽 / 变窄后仍贴着右边缘。位置本身没变，不需要重新保存。
    fn resize_badge(&self, size: (f64, f64)) -> Result<(), PlatformError> {
        let bounds = self.port.bounds()?;
        let monitors = self.port.monitors()?;
        let placement = placement_for_bounds(bounds, &monitors);
        self.port.collapse(size)?;
        if let Some(placement) = placement
            && let Some((target, _)) = resolve_position(&placement, size, &monitors)
            && (target.x != bounds.x || target.y != bounds.y)
        {
            self.move_to(target)?;
        }
        Ok(())
    }
}

impl<P: FloatingWindowPort + 'static> FloatingHandle for FloatingController<P> {
    /// 修改置顶：直接交给窗口 Port。
    fn set_always_on_top(&self, enabled: bool) -> Result<(), PlatformError> {
        self.port.set_always_on_top(enabled)
    }

    /// 显示器配置变化：重新定位。
    fn on_display_changed(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.display_changed())
    }

    /// 退出前保存位置：等价于立即「结算」一次；展开期间或位置没变时是空操作。
    fn flush(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.settle())
    }

    /// 展开为面板：面板朝屏幕内侧展开，完整位于当前显示器工作区内。
    ///
    /// 重复调用（例如进入 Quick Create 后面板变高）会基于**同一个**收起态外框重新计算，
    /// 因此多次展开 / 调整大小后再收起，位置仍回到最初的徽标处。
    fn expand(&self, panel_logical: (f64, f64)) -> Result<ExpandedLayout, PlatformError> {
        let collapsed = {
            let mut slot = lock(&self.collapsed);
            match *slot {
                Some(rect) => rect,
                None => {
                    let rect = self.port.bounds()?;
                    *slot = Some(rect);
                    rect
                }
            }
        };
        let layout = self
            .port
            .monitors()
            .and_then(|monitors| {
                expand_bounds(collapsed, panel_logical, &monitors)
                    .ok_or_else(|| PlatformError::Failed("没有可用的显示器".to_owned()))
            })
            .inspect_err(|_| *lock(&self.collapsed) = None)?;
        // 取消尚未执行的吸附：展开之前的拖动结算不应在面板展开后才触发。
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.move_to_rect(layout.bounds).inspect_err(|_| {
            // 展开失败时回到收起态，避免控制器误以为窗口已展开而一直忽略拖动。
            *lock(&self.collapsed) = None;
        })?;
        self.start_watchdog();
        Ok(layout)
    }

    /// 收起：恢复展开前保存的徽标外框；徽标尺寸变了再按新尺寸落位。
    fn collapse(&self, badge_logical: (f64, f64)) -> Result<(), PlatformError> {
        let previous = std::mem::replace(&mut *lock(&self.badge), badge_logical);
        let expanded = lock(&self.collapsed).take();
        if let Some(collapsed) = expanded {
            self.watchdog.fetch_add(1, Ordering::SeqCst);
            // 先清掉 collapsed 再移动：移动产生的事件会被当作"自己的移动"（expected）而忽略，
            // 不会误触发一次吸附。
            self.move_to_rect(collapsed)?;
        }
        // 尺寸只来自前端的几个固定常量，按位比较即可。
        if previous.0.to_bits() != badge_logical.0.to_bits()
            || previous.1.to_bits() != badge_logical.1.to_bits()
        {
            self.resize_badge(badge_logical)?;
        }
        Ok(())
    }

    /// 完整配置页按工作区和缩放居中，停止 Hover 看门狗。
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_possible_wrap
    )]
    fn configure_input(&self) -> Result<(), PlatformError> {
        let monitor = self.port.current_monitor()?;
        let area = monitor.work_area;
        let margin = (16.0 * monitor.scale_factor).round() as u32;
        let width = ((640.0 * monitor.scale_factor).round() as u32)
            .min(area.width.saturating_sub(margin * 2).max(1));
        let height = ((720.0 * monitor.scale_factor).round() as u32)
            .min(area.height.saturating_sub(margin * 2).max(1));
        let original = self.port.bounds()?;
        let was_expanded = lock(&self.collapsed).is_some();
        if !was_expanded {
            *lock(&self.collapsed) = Some(original);
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.watchdog.fetch_add(1, Ordering::SeqCst);
        let target = Rect {
            x: area.x + ((area.width - width) / 2) as i32,
            y: area.y + ((area.height - height) / 2) as i32,
            width,
            height,
        };
        if let Err(error) = self.move_to_rect(target) {
            let _ = self.move_to_rect(original);
            if !was_expanded {
                *lock(&self.collapsed) = None;
            }
            return Err(error);
        }
        self.configuring.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// 开始文本输入：先记住前台窗口，再让悬浮窗可聚焦并聚焦。
    ///
    /// 任何一步失败都把窗口恢复为不可聚焦，避免悬浮窗留在"可被激活"的状态里，
    /// 之后单击就会抢走别的应用的焦点。
    fn begin_input(&self) -> Result<(), PlatformError> {
        // 先标记再聚焦：聚焦本身会触发 `on_focused`，不能被当成误激活。
        self.input_active.store(true, Ordering::SeqCst);
        if let Err(error) = self.foreground.remember() {
            tracing::warn!(event = "floating_foreground_remember_failed", %error, "记住前台窗口失败");
        }
        let result = self
            .port
            .set_focusable(true)
            .and_then(|()| self.port.focus());
        if result.is_err() {
            self.input_active.store(false, Ordering::SeqCst);
            if let Err(error) = self.port.set_focusable(false) {
                tracing::warn!(event = "floating_unfocusable_failed", %error, "恢复悬浮窗不可聚焦失败");
            }
        }
        result
    }

    /// 不在输入期间被激活：稍等激活过程走完，再把前台还给用户之前的窗口
    /// （悬浮窗自己在前台时取钩子记录的那个）。
    ///
    /// 不能在激活事件里立刻还：那时系统还在处理这次点击的激活，WebView2 随后的 `SetFocus`
    /// 会把悬浮窗重新拉回前台（真机 E2E 复现过）。
    fn on_focused(&self) {
        if self.input_active.load(Ordering::SeqCst) {
            return;
        }
        let Some(this) = self.me.upgrade() else {
            return;
        };
        let generation = this.focus_return.fetch_add(1, Ordering::SeqCst) + 1;
        let runtime = this.runtime.clone();
        runtime.spawn(async move {
            tokio::select! {
                () = this.shutdown.cancelled() => return,
                () = tokio::time::sleep(FOCUS_RETURN_DELAY) => {}
            }
            // 等待期间进入了 Quick Create 输入、或用户要打开主窗口：这次激活是用户要的。
            if this.input_active.load(Ordering::SeqCst)
                || this.focus_return.load(Ordering::SeqCst) != generation
            {
                return;
            }
            if let Err(error) = this.foreground.remember() {
                tracing::warn!(event = "floating_focus_remember_failed", %error, "记住前台窗口失败");
                return;
            }
            match this.foreground.restore() {
                Ok(()) => tracing::info!(
                    event = "floating_focus_returned",
                    "悬浮窗被误激活，焦点已还给之前的应用"
                ),
                Err(error) => {
                    tracing::warn!(event = "floating_focus_return_failed", %error, "无法把焦点还给之前的应用")
                }
            }
        });
    }

    /// 取消尚未执行的「把焦点还回去」。
    fn cancel_focus_return(&self) {
        self.focus_return.fetch_add(1, Ordering::SeqCst);
    }

    /// 结束文本输入：恢复不可聚焦，再把焦点还给之前的窗口。
    fn end_input(&self) -> Result<(), PlatformError> {
        self.configuring.store(false, Ordering::SeqCst);
        self.input_active.store(false, Ordering::SeqCst);
        let result = self.port.set_focusable(false);
        // 还原失败（用户已关闭那个应用、系统拒绝等）不影响悬浮窗本身，只记录。
        if let Err(error) = self.foreground.restore() {
            tracing::warn!(event = "floating_foreground_restore_failed", %error, "还原前台窗口失败");
        }
        result
    }

    /// 记录一次移动，并（重新）启动防抖定时器。
    fn on_moved(&self, position: Point) {
        if lock(&self.collapsed).is_some() {
            return;
        }
        {
            let mut expected = lock(&self.expected);
            if *expected == Some(position) {
                // 这是我们自己的 move_to 触发的事件，不是用户在拖动。
                *expected = None;
                return;
            }
        }
        let Some(this) = self.me.upgrade() else {
            return;
        };
        let generation = this.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let runtime = this.runtime.clone();
        runtime.spawn(async move {
            tokio::select! {
                () = this.shutdown.cancelled() => return,
                () = tokio::time::sleep(SETTLE_DELAY) => {}
            }
            // 等待期间又发生了移动（代数变了）说明用户还在拖动，由更新的那个任务负责收尾。
            if this.generation.load(Ordering::SeqCst) == generation {
                this.settle().await;
            }
        });
    }
}

#[cfg(test)]
mod tests;
