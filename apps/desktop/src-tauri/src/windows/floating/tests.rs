//! `FloatingController` 的测试：使用假窗口与暂停的 Tokio 时间。

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{TimeZone, Utc};
use stardeskbox_application::testing::FakeUnitOfWork;
use stardeskbox_common::clock::FakeClock;
use stardeskbox_platform::foreground::ForegroundPort;
use stardeskbox_platform::placement::{Edge, MonitorInfo, Rect};

use super::*;

/// 测试里徽标的 logical 尺寸（缩放比例 1，与假窗口的初始大小一致）。
const BADGE: (f64, f64) = (88.0, 40.0);

/// 假窗口：记录收到的调用，位置变化立即反映在 `bounds` 中。
struct FakePort {
    state: Mutex<FakeState>,
}

/// [`FakePort`] 的内部状态。
struct FakeState {
    bounds: Rect,
    monitors: Vec<MonitorInfo>,
    moves: Vec<Point>,
    cursor: Point,
    focused: bool,
    fail_focus: bool,
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
                cursor: Point { x: 0, y: 0 },
                focused: false,
                fail_focus: false,
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

    /// 模拟指针移动到 `(x, y)`。
    fn set_cursor(&self, x: i32, y: i32) {
        lock(&self.state).cursor = Point { x, y };
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
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    fn collapse(&self, (width, height): (f64, f64)) -> Result<(), PlatformError> {
        let mut state = lock(&self.state);
        state.bounds.width = width as u32;
        state.bounds.height = height as u32;
        Ok(())
    }
    fn expand(&self, bounds: Rect) -> Result<(), PlatformError> {
        lock(&self.state).bounds = bounds;
        Ok(())
    }
    fn set_focusable(&self, enabled: bool) -> Result<(), PlatformError> {
        lock(&self.state).focusable = Some(enabled);
        Ok(())
    }
    fn focus(&self) -> Result<(), PlatformError> {
        let mut state = lock(&self.state);
        if state.fail_focus {
            return Err(PlatformError::Failed("无法聚焦".into()));
        }
        state.focused = true;
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
    fn cursor_position(&self) -> Result<Point, PlatformError> {
        Ok(lock(&self.state).cursor)
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

/// 假的前台窗口记忆 / 还原：只记录调用次数。
#[derive(Default)]
struct FakeForeground {
    remembered: AtomicU64,
    restored: AtomicU64,
}

impl ForegroundPort for FakeForeground {
    fn remember(&self) -> Result<(), PlatformError> {
        self.remembered.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn restore(&self) -> Result<(), PlatformError> {
        self.restored.fetch_add(1, Ordering::SeqCst);
        Ok(())
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

#[tokio::test]
async fn configuration_is_centered_and_restores_the_original_badge() {
    let f = fixture(single(), (1800, 80), &[]).await;
    f.controller.expand((300.0, 380.0)).unwrap();
    f.controller.begin_input().unwrap();
    f.controller
        .configure_input(ConfigurationLayout::Form)
        .unwrap();
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: 640,
            y: 160,
            width: 640,
            height: 720
        }
    );
    f.controller.end_input().unwrap();
    f.controller.collapse(BADGE).unwrap();
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: 1800,
            y: 80,
            width: 88,
            height: 40
        }
    );
}

#[tokio::test]
async fn configuration_fits_scaled_small_work_area_and_survives_display_change() {
    let mut display = monitor("small", -900, 900, true);
    display.work_area.y = 40;
    display.work_area.height = 700;
    display.scale_factor = 1.5;
    let f = fixture(vec![display], (-100, 80), &[]).await;
    f.controller.begin_input().unwrap();
    f.controller
        .configure_input(ConfigurationLayout::Form)
        .unwrap();
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: -876,
            y: 64,
            width: 852,
            height: 652
        }
    );
    f.controller.display_changed().await;
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: -876,
            y: 64,
            width: 852,
            height: 652
        }
    );
    assert!(f.controller.input_active.load(Ordering::SeqCst));

    // 模拟原显示器拔除，窗口迁移到不同缩放的新工作区。
    let mut replacement = monitor("replacement", 0, 2560, true);
    replacement.work_area.height = 1400;
    replacement.scale_factor = 2.0;
    lock(&f.port.state).monitors = vec![replacement];
    f.controller.display_changed().await;
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: 640,
            y: 32,
            width: 1280,
            height: 1336
        }
    );
    assert!(f.controller.input_active.load(Ordering::SeqCst));
    assert!(f.controller.configuring.load(Ordering::SeqCst));
    f.controller.end_input().unwrap();
    f.controller.collapse(BADGE).unwrap();
    let restored = f.port.bounds().unwrap();
    assert!(restored.x >= 0 && restored.y >= 0);
    assert!(restored.x + i32::try_from(restored.width).unwrap() <= 2560);
    assert!(restored.y + i32::try_from(restored.height).unwrap() <= 1400);
}

/// 控制器夹具。
struct Fixture {
    controller: Arc<FloatingController<FakePort>>,
    port: Arc<FakePort>,
    /// 记录前台窗口记忆 / 还原调用的假实现。
    foreground: Arc<FakeForeground>,
    /// 看门狗触发 `on_pointer_outside` 的次数。
    pointer_outside: Arc<AtomicU64>,
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
    let pointer_outside = Arc::new(AtomicU64::new(0));
    let foreground = Arc::new(FakeForeground::default());
    let counter = pointer_outside.clone();
    let controller = FloatingController::new(
        port.clone(),
        settings,
        Handle::current(),
        shutdown.clone(),
        Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        foreground.clone(),
    );
    *lock(&controller.badge) = BADGE;
    Fixture {
        controller,
        port,
        foreground,
        pointer_outside,
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
async fn a_drop_near_an_edge_stays_where_it_was_dropped_and_is_saved() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    let before = f.port.move_count();

    // 用户把徽标拖到离左边缘 10px 的位置：不会被吸到边上。
    f.port.drag_to(10, 300);
    f.controller.on_moved(Point { x: 10, y: 300 });
    advance(Duration::from_millis(300)).await;

    assert_eq!(f.port.position(), Point { x: 10, y: 300 });
    assert_eq!(f.port.move_count(), before);
    let saved = saved_placement(&f.uow).unwrap();
    assert_eq!(saved.edge, None);
    assert_eq!(saved.monitor_id, "DISPLAY1");
}

#[tokio::test(start_paused = true)]
async fn a_drop_hanging_off_the_screen_is_pulled_back_onto_the_edge() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    let before = f.port.move_count();

    f.port.drag_to(-10, 300);
    f.controller.on_moved(Point { x: -10, y: 300 });
    // 防抖期间不动。
    advance(Duration::from_millis(100)).await;
    assert_eq!(f.port.position(), Point { x: -10, y: 300 });
    assert_eq!(f.port.move_count(), before);

    advance(Duration::from_millis(100)).await;
    assert_eq!(f.port.position(), Point { x: 0, y: 300 });
    assert_eq!(saved_placement(&f.uow).unwrap().edge, Some(Edge::Left));
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

/// 面板尺寸（logical px）。
const PANEL: (f64, f64) = (300.0, 380.0);

#[tokio::test(start_paused = true)]
async fn expand_places_the_panel_inside_the_work_area_and_reports_the_direction() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 20);

    let layout = f.controller.expand(PANEL).unwrap();

    let bounds = f.port.bounds().unwrap();
    assert_eq!((bounds.width, bounds.height), (300, 380));
    assert!(bounds.x >= 0 && bounds.x + 300 <= 1920 && bounds.y >= 0 && bounds.y + 380 <= 1040);
    // 徽标在右上角：面板向左、向下展开，右缘与徽标右缘对齐。
    assert_eq!(
        layout.horizontal,
        stardeskbox_platform::placement::HorizontalAnchor::Right
    );
    assert_eq!(
        layout.vertical,
        stardeskbox_platform::placement::VerticalAnchor::Top
    );
    assert_eq!(bounds.x + 300, 1920);
}

#[tokio::test(start_paused = true)]
async fn collapse_restores_the_original_badge_position() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    let before = f.port.bounds().unwrap();

    f.controller.expand(PANEL).unwrap();
    f.controller.collapse(BADGE).unwrap();

    assert_eq!(f.port.bounds().unwrap(), before);
}

#[tokio::test(start_paused = true)]
async fn repeated_expansion_keeps_returning_to_the_same_badge() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    let before = f.port.bounds().unwrap();

    f.controller.expand(PANEL).unwrap();
    // 进入 Quick Create 后面板变高，再次展开基于同一个收起态外框。
    f.controller.expand((300.0, 460.0)).unwrap();
    assert_eq!(f.port.bounds().unwrap().height, 460);
    f.controller.collapse(BADGE).unwrap();

    assert_eq!(f.port.bounds().unwrap(), before);
}

#[tokio::test(start_paused = true)]
async fn moves_while_expanded_are_not_treated_as_drags() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    f.controller.expand(PANEL).unwrap();

    // 展开过程中系统回送的位置变化（包括不匹配目标位置的中间事件）不能触发吸附与保存。
    f.controller.on_moved(Point { x: 1500, y: 500 });
    advance(Duration::from_millis(500)).await;

    assert!(saved_placement(&f.uow).is_none());
    assert_eq!(f.port.bounds().unwrap().width, 300);
}

#[tokio::test(start_paused = true)]
async fn dragging_works_again_after_collapsing() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.expand(PANEL).unwrap();
    f.controller.collapse(BADGE).unwrap();

    f.port.drag_to(-10, 300);
    f.controller.on_moved(Point { x: -10, y: 300 });
    advance(Duration::from_millis(300)).await;

    assert_eq!(f.port.position(), Point { x: 0, y: 300 });
    assert_eq!(saved_placement(&f.uow).unwrap().edge, Some(Edge::Left));
}

#[tokio::test(start_paused = true)]
async fn a_pending_drag_settle_is_cancelled_by_expanding() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(10, 300);
    f.controller.on_moved(Point { x: 10, y: 300 });

    f.controller.expand(PANEL).unwrap();
    advance(Duration::from_millis(500)).await;

    assert!(
        saved_placement(&f.uow).is_none(),
        "展开之后不应再执行之前的拖动结算"
    );
}

#[tokio::test(start_paused = true)]
async fn collapse_without_expanding_is_a_no_op_and_failed_expand_leaves_it_collapsed() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    let before = f.port.bounds().unwrap();
    f.controller.collapse(BADGE).unwrap();
    assert_eq!(f.port.bounds().unwrap(), before);

    // 没有显示器时展开失败，控制器不能卡在"已展开"状态。
    lock(&f.port.state).monitors.clear();
    assert!(f.controller.expand(PANEL).is_err());
    lock(&f.port.state).monitors = single();
    f.port.drag_to(10, 300);
    f.controller.on_moved(Point { x: 10, y: 300 });
    advance(Duration::from_millis(300)).await;
    assert!(saved_placement(&f.uow).is_some());
}

#[tokio::test(start_paused = true)]
async fn a_new_badge_size_keeps_the_badge_on_its_edge() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    f.controller.on_moved(Point {
        x: 1920 - 88,
        y: 500,
    });
    advance(Duration::from_millis(300)).await;

    // 收起态下换成更小的形状：仍贴着右边缘，垂直中心不变。
    f.controller.collapse((40.0, 40.0)).unwrap();
    let bounds = f.port.bounds().unwrap();
    assert_eq!((bounds.width, bounds.height), (40, 40));
    assert_eq!(bounds.x + 40, 1920);

    // 展开期间换了形状：收起时先回到原来的外框，再按新尺寸落位。
    f.controller.expand(PANEL).unwrap();
    f.controller.collapse((64.0, 32.0)).unwrap();
    let bounds = f.port.bounds().unwrap();
    assert_eq!((bounds.width, bounds.height), (64, 32));
    assert_eq!(bounds.x + 64, 1920);
}

#[tokio::test(start_paused = true)]
async fn watchdog_reports_the_pointer_leaving_once_and_only_while_expanded() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    f.controller.expand(PANEL).unwrap();
    let panel = f.port.bounds().unwrap();

    // 指针在面板内：不报告。
    f.port.set_cursor(panel.x + 10, panel.y + 10);
    advance(Duration::from_millis(600)).await;
    assert_eq!(f.pointer_outside.load(Ordering::SeqCst), 0);

    // 指针被甩到窗口外：只报告一次，不会每个周期都报告。
    f.port.set_cursor(100, 100);
    advance(Duration::from_millis(1000)).await;
    assert_eq!(f.pointer_outside.load(Ordering::SeqCst), 1);

    // 回到窗口内再离开：再次报告。
    f.port.set_cursor(panel.x + 10, panel.y + 10);
    advance(Duration::from_millis(300)).await;
    f.port.set_cursor(100, 100);
    advance(Duration::from_millis(300)).await;
    assert_eq!(f.pointer_outside.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn watchdog_stops_after_collapsing() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.expand(PANEL).unwrap();
    f.controller.collapse(BADGE).unwrap();

    f.port.set_cursor(100, 100);
    advance(Duration::from_millis(2000)).await;

    assert_eq!(
        f.pointer_outside.load(Ordering::SeqCst),
        0,
        "收起后不应再有任何检查"
    );
}

#[tokio::test(start_paused = true)]
async fn re_expanding_does_not_start_a_second_watchdog() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.expand(PANEL).unwrap();
    f.controller.expand((300.0, 460.0)).unwrap();
    f.port.set_cursor(100, 100);

    advance(Duration::from_millis(1000)).await;

    assert_eq!(
        f.pointer_outside.load(Ordering::SeqCst),
        1,
        "同一时刻只能有一个看门狗"
    );
}

#[tokio::test(start_paused = true)]
async fn watchdog_exits_on_shutdown() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.expand(PANEL).unwrap();
    f.shutdown.cancel();
    f.port.set_cursor(100, 100);

    advance(Duration::from_millis(1000)).await;

    assert_eq!(f.pointer_outside.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn begin_input_remembers_the_foreground_then_makes_the_window_focusable_and_focused() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    assert_eq!(lock(&f.port.state).focusable, Some(false));

    f.controller.begin_input().unwrap();

    assert_eq!(f.foreground.remembered.load(Ordering::SeqCst), 1);
    assert_eq!(lock(&f.port.state).focusable, Some(true));
    assert!(lock(&f.port.state).focused);
}

#[tokio::test(start_paused = true)]
async fn end_input_makes_the_window_unfocusable_again_and_gives_focus_back() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.begin_input().unwrap();

    f.controller.end_input().unwrap();

    assert_eq!(lock(&f.port.state).focusable, Some(false));
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn being_activated_outside_input_gives_focus_straight_back() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;

    f.controller.on_focused();
    // 不是立刻还：等激活过程走完。
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 0);
    advance(Duration::from_millis(100)).await;

    assert_eq!(f.foreground.remembered.load(Ordering::SeqCst), 1);
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn opening_the_main_window_cancels_the_pending_focus_return() {
    // 点徽标：悬浮窗被激活，紧接着请求打开主窗口。主窗口第一次创建比还焦点的延迟慢，
    // 不取消的话焦点会先被还给之前的应用，主窗口出现在它后面。
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;

    f.controller.on_focused();
    f.controller.cancel_focus_return();
    advance(Duration::from_millis(100)).await;
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 0);

    // 之后再被误激活（没有打开主窗口）照常还回去。
    f.controller.on_focused();
    advance(Duration::from_millis(100)).await;
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn focus_during_quick_create_input_is_kept() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.begin_input().unwrap();
    let remembered = f.foreground.remembered.load(Ordering::SeqCst);

    f.controller.on_focused();
    advance(Duration::from_millis(100)).await;

    assert_eq!(f.foreground.remembered.load(Ordering::SeqCst), remembered);
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 0);

    // 输入结束之后再被激活，又会还回去。
    f.controller.end_input().unwrap();
    f.controller.on_focused();
    advance(Duration::from_millis(100)).await;
    assert_eq!(f.foreground.restored.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn end_input_without_begin_is_harmless() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.end_input().unwrap();
    assert_eq!(lock(&f.port.state).focusable, Some(false));
}

#[tokio::test(start_paused = true)]
async fn a_failed_focus_leaves_the_window_unfocusable() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    lock(&f.port.state).fail_focus = true;

    assert!(f.controller.begin_input().is_err());

    // 不能留下一个"可被激活"的悬浮窗：否则下次单击就会抢走别的应用的焦点。
    assert_eq!(lock(&f.port.state).focusable, Some(false));
}

#[tokio::test(start_paused = true)]
async fn the_settings_page_can_change_always_on_top_while_running() {
    let f = fixture(single(), (0, 0), &[]).await;
    f.controller.restore().await;
    assert_eq!(lock(&f.port.state).always_on_top, Some(true));

    f.controller.set_always_on_top(false).unwrap();
    assert_eq!(lock(&f.port.state).always_on_top, Some(false));
    f.controller.set_always_on_top(true).unwrap();
    assert_eq!(lock(&f.port.state).always_on_top, Some(true));
}

#[tokio::test(start_paused = true)]
async fn unplugging_the_monitor_that_holds_the_badge_moves_it_into_view_within_the_same_call() {
    let monitors = vec![
        monitor("DISPLAY1", 0, 1920, true),
        monitor("DISPLAY2", 1920, 2560, false),
    ];
    let saved = serde_json::to_string(&Placement {
        monitor_id: "DISPLAY2".into(),
        edge: Some(Edge::Right),
        x_ratio: 1.0,
        y_ratio: 0.5,
    })
    .unwrap();
    let f = fixture(monitors, (0, 0), &[(keys::FLOATING_PLACEMENT, &saved)]).await;
    f.controller.restore().await;
    assert!(f.port.position().x >= 1920, "徽标先在副显示器上");

    // 拔掉副显示器。
    lock(&f.port.state).monitors = single();
    f.controller.display_changed().await;
    let position = f.port.position();
    assert!(position.x >= 0 && position.x + 88 <= 1920, "{position:?}");
    assert!(position.y >= 0 && position.y + 40 <= 1040, "{position:?}");

    // 再接回去：回到保存的副显示器位置。
    lock(&f.port.state).monitors = vec![
        monitor("DISPLAY1", 0, 1920, true),
        monitor("DISPLAY2", 1920, 2560, false),
    ];
    f.controller.display_changed().await;
    assert!(f.port.position().x >= 1920);
}

#[tokio::test(start_paused = true)]
async fn a_display_change_while_the_panel_is_expanded_collapses_it_first() {
    let f = fixture(single(), (1800, 500), &[]).await;
    f.controller.restore().await;
    f.controller.expand((320.0, 420.0)).unwrap();
    assert!(lock(&f.controller.collapsed).is_some());
    f.controller.display_changed().await;
    assert!(lock(&f.controller.collapsed).is_none());
    let position = f.port.position();
    assert!(position.x >= 0 && position.x + 88 <= 1920);
}

#[tokio::test]
async fn document_layout_is_larger_switches_back_and_survives_display_change() {
    let f = fixture(single(), (1800, 80), &[]).await;
    f.controller.begin_input().unwrap();
    f.controller
        .configure_input(ConfigurationLayout::Document)
        .unwrap();
    let document = Rect {
        x: 480,
        y: 90,
        width: 960,
        height: 860,
    };
    assert_eq!(f.port.bounds().unwrap(), document);

    // 显示器变化后仍按文档布局重新定位。
    f.controller.display_changed().await;
    assert_eq!(f.port.bounds().unwrap(), document);

    // 切回表单布局：只改尺寸，收起后回到徽标原来的位置。
    f.controller
        .configure_input(ConfigurationLayout::Form)
        .unwrap();
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: 640,
            y: 160,
            width: 640,
            height: 720
        }
    );
    f.controller.end_input().unwrap();
    f.controller.collapse(BADGE).unwrap();
    assert_eq!(
        f.port.bounds().unwrap(),
        Rect {
            x: 1800,
            y: 80,
            width: 88,
            height: 40
        }
    );
}

#[tokio::test(start_paused = true)]
async fn dragging_the_expanded_panel_takes_the_badge_along() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1920 - 88, 500);
    let before = f.port.bounds().unwrap();

    f.controller.expand(PANEL).unwrap();
    let panel = f.port.bounds().unwrap();
    f.controller.begin_drag();
    f.port.drag_to(panel.x - 600, panel.y - 200);
    f.controller.collapse(BADGE).unwrap();

    let after = f.port.bounds().unwrap();
    assert_eq!((after.x, after.y), (before.x - 600, before.y - 200));
}

#[tokio::test(start_paused = true)]
async fn a_dragged_panel_reexpands_where_it_was_left() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.port.drag_to(1000, 500);

    f.controller.expand(PANEL).unwrap();
    let panel = f.port.bounds().unwrap();
    f.controller.begin_drag();
    f.port.drag_to(panel.x - 300, panel.y - 100);
    // 进入 Quick Create 后面板变高：从拖到的位置长高，不跳回去。
    f.controller.expand((300.0, 460.0)).unwrap();

    let grown = f.port.bounds().unwrap();
    assert_eq!((grown.x, grown.y), (panel.x - 300, panel.y - 100));
}

#[tokio::test(start_paused = true)]
async fn a_badge_drag_is_not_mistaken_for_a_panel_drag() {
    let f = fixture(single(), (700, 400), &[]).await;
    f.controller.restore().await;
    f.controller.begin_drag();
    f.port.drag_to(1920 - 88, 500);
    let before = f.port.bounds().unwrap();

    f.controller.expand(PANEL).unwrap();
    f.controller.collapse(BADGE).unwrap();

    assert_eq!(f.port.bounds().unwrap(), before);
}
