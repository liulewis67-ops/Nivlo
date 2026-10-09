//! `FloatingController` 的测试：使用假窗口与暂停的 Tokio 时间。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use chrono::{TimeZone, Utc};
use nivlo_application::testing::FakeUnitOfWork;
use nivlo_common::clock::FakeClock;
use nivlo_platform::placement::{Edge, MonitorInfo, Rect};

use super::*;

/// 假窗口：记录收到的调用，位置变化立即反映在 `bounds` 中。
struct FakePort {
    state: Mutex<FakeState>,
}

/// [`FakePort`] 的内部状态。
struct FakeState {
    bounds: Rect,
    monitors: Vec<MonitorInfo>,
    moves: Vec<Point>,
    always_on_top: Option<bool>,
    focusable: Option<bool>,
}

impl FakePort {
    /// 创建一个 88x40 的徽标窗口，初始位置在 `(x, y)`。
    fn new(monitors: Vec<MonitorInfo>, x: i32, y: i32) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(FakeState {
                bounds: Rect {
                    x,
                    y,
                    width: 88,
                    height: 40,
                },
                monitors,
                moves: Vec::new(),
                always_on_top: None,
                focusable: None,
            }),
        })
    }

    /// 模拟用户把窗口拖到 `(x, y)`（不经过控制器的 `move_to`）。
    fn drag_to(&self, x: i32, y: i32) {
        let mut state = lock(&self.state);
        state.bounds.x = x;
        state.bounds.y = y;
    }

    /// 窗口当前位置。
    fn position(&self) -> Point {
        let state = lock(&self.state);
        Point {
            x: state.bounds.x,
            y: state.bounds.y,
        }
    }

    /// 控制器发起的移动次数。
    fn move_count(&self) -> usize {
        lock(&self.state).moves.len()
    }
}

impl FloatingWindowPort for FakePort {
    fn bounds(&self) -> Result<Rect, PlatformError> {
        Ok(lock(&self.state).bounds)
    }
    fn collapse(&self) -> Result<(), PlatformError> {
        Ok(())
    }
    fn expand(&self, _bounds: Rect) -> Result<(), PlatformError> {
        Ok(())
    }
    fn set_focusable(&self, enabled: bool) -> Result<(), PlatformError> {
        lock(&self.state).focusable = Some(enabled);
        Ok(())
    }
    fn set_always_on_top(&self, enabled: bool) -> Result<(), PlatformError> {
        lock(&self.state).always_on_top = Some(enabled);
        Ok(())
    }
    fn move_to(&self, position: Point) -> Result<(), PlatformError> {
        let mut state = lock(&self.state);
        state.bounds.x = position.x;
        state.bounds.y = position.y;
        state.moves.push(position);
        Ok(())
    }
    fn current_monitor(&self) -> Result<MonitorInfo, PlatformError> {
        lock(&self.state)
            .monitors
            .first()
            .cloned()
            .ok_or_else(|| PlatformError::Failed("无显示器".into()))
    }
    fn monitors(&self) -> Result<Vec<MonitorInfo>, PlatformError> {
        Ok(lock(&self.state).monitors.clone())
    }
}

/// 构造一块显示器。
fn monitor(id: &str, x: i32, w: u32, primary: bool) -> MonitorInfo {
    MonitorInfo {
        id: id.to_owned(),
        work_area: Rect {
            x,
            y: 0,
            width: w,
            height: 1040,
        },
        scale_factor: 1.0,
        is_primary: primary,
    }
}

/// 单显示器。
fn single() -> Vec<MonitorInfo> {
    vec![monitor("DISPLAY1", 0, 1920, true)]
}

/// 控制器夹具。
struct Fixture {
    controller: Arc<FloatingController<FakePort>>,
    port: Arc<FakePort>,
    uow: FakeUnitOfWork,
    shutdown: CancellationToken,
}

/// 创建夹具；`saved` 为预先写入设置的内容。
async fn fixture(monitors: Vec<MonitorInfo>, start: (i32, i32), saved: &[(&str, &str)]) -> Fixture {
    let uow = FakeUnitOfWork::new();
    let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
    let settings = SettingsService::new(Arc::new(uow.clone()), Arc::new(clock));
    for (key, value) in saved {
        settings.set(key, value).await.unwrap();
    }
    let port = FakePort::new(monitors, start.0, start.1);
    let shutdown = CancellationToken::new();
    let controller =
        FloatingController::new(port.clone(), settings, Handle::current(), shutdown.clone());
    Fixture {
        controller,
        port,
        uow,
        shutdown,
    }
}

/// 让出执行权并推进虚拟时间，使防抖任务有机会运行。
async fn advance(duration: Duration) {
    // 先让刚派生的任务运行到 `sleep`，使它的截止时间从"当前虚拟时间"起算；
    // 否则任务第一次被轮询时时钟已经被推进，会比预期多等一段时间。
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(duration).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

/// 读取已保存的位置。
fn saved_placement(uow: &FakeUnitOfWork) -> Option<Placement> {
    uow.committed_setting(keys::FLOATING_PLACEMENT)
        .map(|json| serde_json::from_str(&json).unwrap())
}

#[tokio::test(start_paused = true)]
async fn first_run_uses_the_default_position_on_the_primary_right_edge() {
    let f = fixture(single(), (500, 500), &[]).await;
    f.controller.restore().await;
    assert_eq!(f.port.position().x, 1920 - 88);
    // 默认位置靠近顶部，不贴边。
    assert!(f.port.position().y > 0 && f.port.position().y < 200);
}

#[tokio::test(start_paused = true)]
async fn restores_the_saved_placement_on_the_same_monitor() {
    let monitors = vec![
        monitor("DISPLAY1", 0, 1920, true),
        monitor("DISPLAY2", 1920, 2560, false),
    ];
    let saved = serde_json::to_string(&Placement {
        monitor_id: "DISPLAY2".into(),
        edge: Some(Edge::Left),
        x_ratio: 0.0,
        y_ratio: 0.5,
    })
    .unwrap();
    let f = fixture(monitors, (0, 0), &[(keys::FLOATING_PLACEMENT, &saved)]).await;
    f.controller.restore().await;
    assert_eq!(f.port.position().x, 1920);
    assert_eq!(f.port.position().y, (1040 - 40) / 2);
}

#[tokio::test(start_paused = true)]
async fn falls_back_to_the_primary_monitor_when_the_saved_one_is_gone() {
    let saved = serde_json::to_string(&Placement {
        monitor_id: "UNPLUGGED".into(),
        edge: Some(Edge::Right),
        x_ratio: 1.0,
        y_ratio: 0.99,
    })
    .unwrap();
    let f = fixture(single(), (0, 0), &[(keys::FLOATING_PLACEMENT, &saved)]).await;
    f.controller.restore().await;
    let position = f.port.position();
    assert!(position.x >= 0 && position.x + 88 <= 1920);
    assert!(position.y >= 0 && position.y + 40 <= 1040);
}

#[tokio::test(start_paused = true)]
async fn corrupt_saved_placement_falls_back_to_the_default() {
    let f = fixture(single(), (0, 0), &[(keys::FLOATING_PLACEMENT, "{not json")]).await;
    f.controller.restore().await;
    assert_eq!(f.port.position().x, 1920 - 88);
}

#[tokio::test(start_paused = true)]
async fn restore_applies_always_on_top_and_makes_the_window_unfocusable() {
    let f = fixture(single(), (0, 0), &[]).await;
    f.controller.restore().await;
    assert_eq!(lock(&f.port.state).always_on_top, Some(true));
    assert_eq!(lock(&f.port.state).focusable, Some(false));

    let f = fixture(single(), (0, 0), &[(keys::FLOATING_ALWAYS_ON_TOP, "false")]).await;
    f.controller.restore().await;
    assert_eq!(lock(&f.port.state).always_on_top, Some(false));
}

#[tokio::test(start_paused = true)]
async fn after_a_drag_the_window_snaps_to_the_edge_and_the_placement_is_saved() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    let before = f.port.move_count();

    // 用户把徽标拖到离左边缘 10px 的位置。
    f.port.drag_to(10, 300);
    f.controller.on_moved(Point { x: 10, y: 300 });
    // 防抖期间不动。
    advance(Duration::from_millis(100)).await;
    assert_eq!(f.port.position(), Point { x: 10, y: 300 });
    assert_eq!(f.port.move_count(), before);

    advance(Duration::from_millis(100)).await;
    assert_eq!(f.port.position(), Point { x: 0, y: 300 });
    let saved = saved_placement(&f.uow).unwrap();
    assert_eq!(saved.edge, Some(Edge::Left));
    assert_eq!(saved.monitor_id, "DISPLAY1");
}

#[tokio::test(start_paused = true)]
async fn a_continuous_drag_settles_only_once_after_the_last_move() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    let before = f.port.move_count();

    for step in 0..10 {
        let x = 300 + step * 5;
        f.port.drag_to(x, 400);
        f.controller.on_moved(Point { x, y: 400 });
        advance(Duration::from_millis(50)).await;
    }
    // 拖动过程中（每次间隔 50ms < 150ms）从未吸附，也没有保存。
    assert_eq!(f.port.move_count(), before);
    assert!(saved_placement(&f.uow).is_none());

    advance(Duration::from_millis(300)).await;
    // 远离边缘：自由位置，只保存、不移动。
    let saved = saved_placement(&f.uow).unwrap();
    assert_eq!(saved.edge, None);
    assert_eq!(f.port.position(), Point { x: 345, y: 400 });
    assert_eq!(f.port.move_count(), before);
}

#[tokio::test(start_paused = true)]
async fn moves_caused_by_the_controller_itself_do_not_trigger_a_settle() {
    let f = fixture(single(), (0, 0), &[]).await;
    f.controller.restore().await;
    // 系统回送"窗口被移动到默认位置"的事件。
    f.controller.on_moved(f.port.position());
    advance(Duration::from_millis(500)).await;
    assert!(saved_placement(&f.uow).is_none(), "自己的移动不应触发保存");
}

#[tokio::test(start_paused = true)]
async fn a_pending_settle_is_cancelled_on_shutdown() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(10, 300);
    f.controller.on_moved(Point { x: 10, y: 300 });
    f.shutdown.cancel();
    advance(Duration::from_millis(500)).await;
    assert!(saved_placement(&f.uow).is_none());
    assert_eq!(f.port.position(), Point { x: 10, y: 300 });
}

#[tokio::test(start_paused = true)]
async fn unchanged_placement_is_not_written_twice() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.settle().await;
    let first = f.uow.committed_setting(keys::FLOATING_PLACEMENT);
    assert!(first.is_some());
    // 第二次内容相同：命中 last_saved，不会再次提交。
    f.uow.fail_next_commit();
    f.controller.settle().await;
    assert_eq!(f.uow.committed_setting(keys::FLOATING_PLACEMENT), first);
}
