//! 悬浮窗位置控制器：启动时还原位置，拖动结束后吸附并保存。
//!
//! 用户拖动无边框窗口时，系统不会给出"拖动结束"事件，只有连续的 `Moved`。
//! 因此这里对 `Moved` 做防抖：最后一次移动之后安静一小段时间（`SETTLE_DELAY`），就认为拖动结束，
//! 然后一次性完成"吸附 → 保存"，既不会在拖动过程中和系统抢位置（卡顿 / 闪烁），
//! 也不会每个像素都写一次数据库。具体的吸附与跨显示器 / DPI 计算在
//! [`nivlo_platform::placement`] 中，这里只负责时序与持久化。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Duration;

use nivlo_application::settings::{SettingsService, keys};
use nivlo_platform::error::PlatformError;
use nivlo_platform::floating_window::FloatingWindowPort;
use nivlo_platform::placement::{
    COLLAPSED_HEIGHT_LOGICAL_PX, COLLAPSED_WIDTH_LOGICAL_PX, Placement, Point, default_placement,
    placement_for_bounds, resolve_position,
};
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

/// 最后一次 `Moved` 之后多久认为拖动已经结束。
///
/// 太短会在用户短暂停顿时提前吸附，太长则松手后窗口"迟钝"；150ms 是手感与稳定性的折中。
const SETTLE_DELAY: Duration = Duration::from_millis(150);

/// 悬浮窗被移动时的观察者，由窗口事件回调调用（该回调在主线程上，不能阻塞）。
pub trait MoveObserver: Send + Sync {
    /// 窗口被移动到 `position`（物理像素）。
    fn on_moved(&self, position: Point);
}

/// 悬浮窗位置控制器。
pub struct FloatingController<P: FloatingWindowPort + 'static> {
    /// 指向自身的弱引用：窗口事件回调只有 `&self`，派生后台任务时需要升级成 `Arc`。
    me: Weak<Self>,
    /// 窗口行为 Port。
    port: Arc<P>,
    /// 设置服务，用于保存 / 读取位置与置顶偏好。
    settings: SettingsService,
    /// 用于派生后台任务的 Tokio 句柄（窗口事件回调不在 Tokio 运行时内）。
    runtime: Handle,
    /// 退出信号，取消尚未执行的吸附任务。
    shutdown: CancellationToken,
    /// 防抖代数：每次 `Moved` 加一，只有最新一代的定时任务才会执行吸附。
    generation: AtomicU64,
    /// 控制器自己发起的移动的目标位置，用来忽略自己触发的 `Moved` 事件。
    expected: Mutex<Option<Point>>,
    /// 最近一次保存的位置 JSON，内容没变时不重复写库。
    last_saved: Mutex<Option<String>>,
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
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            port,
            settings,
            runtime,
            shutdown,
            generation: AtomicU64::new(0),
            expected: Mutex::new(None),
            last_saved: Mutex::new(None),
        })
    }

    /// 启动时应用保存的偏好：位置、置顶、不可聚焦。
    ///
    /// 位置还原到保存的显示器；该显示器不存在（如副显示器已拔掉）时回退到主显示器，
    /// 没有保存过位置时使用默认位置。任何一项失败都只记录日志、不阻止启动：
    /// 悬浮窗在默认位置仍然可用，用户可以拖动它。
    pub async fn restore(&self) {
        // 先收起到徽标大小：Windows 创建窗口时会把宽度夹到系统最小宽度，之后按徽标尺寸计算位置才准确。
        if let Err(error) = self.port.collapse() {
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
        let size = (COLLAPSED_WIDTH_LOGICAL_PX, COLLAPSED_HEIGHT_LOGICAL_PX);
        let Some((position, _monitor)) = resolve_position(&placement, size, &monitors) else {
            return Err(PlatformError::Failed("没有可用的显示器".to_owned()));
        };
        self.move_to(position)
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
        let bounds = self.port.bounds()?;
        let monitors = self.port.monitors()?;
        let Some(placement) = placement_for_bounds(bounds, &monitors) else {
            return Ok(());
        };
        let size = (COLLAPSED_WIDTH_LOGICAL_PX, COLLAPSED_HEIGHT_LOGICAL_PX);
        // 用户只能拖动收起态的徽标（展开面板时窗口位置由 expand / collapse 决定，不走这里），
        // 因此按收起态的 logical 尺寸还原位置即可。
        // TODO(P1.3): 展开 / 收起期间的程序化移动需要暂停吸附，避免与展开方向计算互相干扰。
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

impl<P: FloatingWindowPort + 'static> MoveObserver for FloatingController<P> {
    /// 记录一次移动，并（重新）启动防抖定时器。
    fn on_moved(&self, position: Point) {
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
