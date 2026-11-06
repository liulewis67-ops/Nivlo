//! 悬浮窗位置的纯计算：贴边、跨显示器与 DPI（架构文档 §11）。
//!
//! 徽标长按选中后可以拖到任意位置，松手处就是新位置，不会被吸到附近的边缘；
//! 只有真正贴着（或超出）工作区边缘时才记为贴边，这样它换尺寸、换分辨率后仍然贴着那条边，
//! 超出的部分也会被拉回屏幕内。
//!
//! 保存位置时**不保存绝对像素**，而是保存 [`Placement`]：显示器 ID + 贴住的边缘 + 在该显示器
//! 工作区内的相对位置（比例）。这样分辨率、缩放比例或显示器布局变化后，窗口仍然落在合理位置；
//! 找不到原显示器时回退到主显示器。
//!
//! 本模块不依赖任何窗口库，输入输出都是物理像素的简单结构，便于完整的单元测试。
//! 尺寸以 logical px 约定（徽标视觉大小在不同缩放比例下一致），转换为物理像素时乘以显示器的缩放系数。

use serde::{Deserialize, Serialize};

/// 收起态（徽标）的默认宽度（logical px）：默认的胶囊形状。其他形状由前端在收起时告知尺寸。
pub const COLLAPSED_WIDTH_LOGICAL_PX: f64 = 64.0;

/// 收起态（徽标）的默认高度（logical px）。
pub const COLLAPSED_HEIGHT_LOGICAL_PX: f64 = 32.0;

/// 默认位置在贴住的边缘（右侧）上的相对高度：靠近顶部但不贴边。
const DEFAULT_Y_RATIO: f64 = 0.08;

/// 屏幕上的一个点（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    /// 横坐标。
    pub x: i32,
    /// 纵坐标。
    pub y: i32,
}

/// 屏幕上的一个矩形（物理像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    /// 左上角横坐标。
    pub x: i32,
    /// 左上角纵坐标。
    pub y: i32,
    /// 宽度。
    pub width: u32,
    /// 高度。
    pub height: u32,
}

impl Rect {
    /// 矩形中心点。
    pub fn center(&self) -> Point {
        // 使用 i64 中转，避免极端坐标下 `x + width` 溢出 i32。
        Point {
            x: clamp_to_i32(i64::from(self.x) + i64::from(self.width) / 2),
            y: clamp_to_i32(i64::from(self.y) + i64::from(self.height) / 2),
        }
    }

    /// 点是否落在矩形内（左 / 上边界包含，右 / 下边界不包含，与屏幕像素语义一致）。
    pub fn contains(&self, point: Point) -> bool {
        let right = i64::from(self.x) + i64::from(self.width);
        let bottom = i64::from(self.y) + i64::from(self.height);
        i64::from(point.x) >= i64::from(self.x)
            && i64::from(point.x) < right
            && i64::from(point.y) >= i64::from(self.y)
            && i64::from(point.y) < bottom
    }

    /// 点到矩形的距离的平方；点在矩形内时为 0。用于在窗口不在任何显示器内时找最近的显示器。
    fn distance_squared_to(&self, point: Point) -> i64 {
        let right = i64::from(self.x) + i64::from(self.width);
        let bottom = i64::from(self.y) + i64::from(self.height);
        let dx = (i64::from(self.x) - i64::from(point.x))
            .max(i64::from(point.x) - right)
            .max(0);
        let dy = (i64::from(self.y) - i64::from(point.y))
            .max(i64::from(point.y) - bottom)
            .max(0);
        dx * dx + dy * dy
    }
}

/// 把 i64 饱和转换为 i32。
fn clamp_to_i32(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
}

/// 一块显示器的信息。
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    /// 稳定的显示器标识（优先使用系统名称，如 `\\.\DISPLAY2`）。
    pub id: String,
    /// 工作区（已排除任务栏等系统保留区域），物理像素。
    pub work_area: Rect,
    /// logical px 到物理像素的缩放系数（150% 缩放为 1.5）。
    pub scale_factor: f64,
    /// 是否为主显示器。
    pub is_primary: bool,
}

/// 窗口贴住的屏幕边缘。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    /// 左边缘。
    Left,
    /// 右边缘。
    Right,
    /// 上边缘。
    Top,
    /// 下边缘。
    Bottom,
}

/// 悬浮窗的持久化位置：与分辨率、缩放无关。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    /// 所在显示器的标识。
    pub monitor_id: String,
    /// 贴住的边缘；`None` 表示自由位置。
    pub edge: Option<Edge>,
    /// 窗口左上角在"工作区宽度 - 窗口宽度"中的位置比例，0 = 贴左，1 = 贴右。
    pub x_ratio: f64,
    /// 窗口左上角在"工作区高度 - 窗口高度"中的位置比例，0 = 贴上，1 = 贴下。
    pub y_ratio: f64,
}

/// logical px 转物理像素（四舍五入，至少为 1）。
fn to_physical(logical: f64, scale: f64) -> u32 {
    // 尺寸为几十到几百 logical px，乘以缩放后远小于 u32 上限，转换不会截断。
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let value = (logical * scale).round().max(1.0) as u32;
    value
}

/// 在显示器列表中选出包含 `point` 的显示器；不在任何显示器内时选最近的。
///
/// 返回 `None` 表示显示器列表为空。
pub fn pick_monitor(monitors: &[MonitorInfo], point: Point) -> Option<&MonitorInfo> {
    monitors
        .iter()
        .min_by_key(|m| m.work_area.distance_squared_to(point))
}

/// 根据窗口当前的外框计算应保存的位置，并判断它是否贴着边缘。
///
/// 窗口中心所在的显示器决定了归属；窗口边缘与该显示器工作区边缘重合或超出时记为贴住
/// 该边缘（超出的部分还原时会被拉回工作区），离边缘哪怕 1px 也是自由位置，不会被吸过去。
/// 同时贴住两条边（角落）时按 超出最多、再按 左、右、上、下 的顺序取一条。
///
/// 返回 `None` 表示没有可用的显示器。
pub fn placement_for_bounds(bounds: Rect, monitors: &[MonitorInfo]) -> Option<Placement> {
    let monitor = pick_monitor(monitors, bounds.center())?;
    let work = monitor.work_area;

    let rel_x = i64::from(bounds.x) - i64::from(work.x);
    let rel_y = i64::from(bounds.y) - i64::from(work.y);
    let free_x = (i64::from(work.width) - i64::from(bounds.width)).max(0);
    let free_y = (i64::from(work.height) - i64::from(bounds.height)).max(0);

    // 到四条边的距离（窗口超出边界时为负数）。
    let distances = [
        (Edge::Left, rel_x),
        (Edge::Right, free_x - rel_x),
        (Edge::Top, rel_y),
        (Edge::Bottom, free_y - rel_y),
    ];
    let mut edge: Option<(Edge, i64)> = None;
    for (candidate, distance) in distances {
        if distance <= 0 && edge.is_none_or(|(_, best)| distance < best) {
            edge = Some((candidate, distance));
        }
    }
    let edge = edge.map(|(e, _)| e);

    let ratio = |offset: i64, free: i64| {
        if free == 0 {
            0.0
        } else {
            // 位置在 0..=free 范围内，转 f64 无精度问题。
            #[allow(clippy::cast_precision_loss)]
            let value = offset as f64 / free as f64;
            value.clamp(0.0, 1.0)
        }
    };
    let mut x_ratio = ratio(rel_x, free_x);
    let mut y_ratio = ratio(rel_y, free_y);
    // 贴边的轴强制贴边：超出工作区的窗口被拉回来，恰好贴在边缘上。
    match edge {
        Some(Edge::Left) => x_ratio = 0.0,
        Some(Edge::Right) => x_ratio = 1.0,
        Some(Edge::Top) => y_ratio = 0.0,
        Some(Edge::Bottom) => y_ratio = 1.0,
        None => {}
    }
    Some(Placement {
        monitor_id: monitor.id.clone(),
        edge,
        x_ratio,
        y_ratio,
    })
}

/// 把保存的位置还原为屏幕坐标。
///
/// 找不到 `placement.monitor_id` 对应的显示器（如副显示器已拔掉）时回退到主显示器，
/// 没有主显示器标记时取第一块，保证窗口一定出现在可见区域内。`logical_size` 为窗口的
/// logical 尺寸，按目标显示器的缩放换算，所以不同缩放比例下徽标的视觉大小一致。
///
/// 返回窗口左上角的物理坐标，以及实际使用的显示器 ID；没有任何显示器时返回 `None`。
pub fn resolve_position(
    placement: &Placement,
    logical_size: (f64, f64),
    monitors: &[MonitorInfo],
) -> Option<(Point, String)> {
    let monitor = monitors
        .iter()
        .find(|m| m.id == placement.monitor_id)
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .or_else(|| monitors.first())?;
    let work = monitor.work_area;
    let width = i64::from(to_physical(logical_size.0, monitor.scale_factor));
    let height = i64::from(to_physical(logical_size.1, monitor.scale_factor));
    let free_x = (i64::from(work.width) - width).max(0);
    let free_y = (i64::from(work.height) - height).max(0);

    let (mut x_ratio, mut y_ratio) = (
        placement.x_ratio.clamp(0.0, 1.0),
        placement.y_ratio.clamp(0.0, 1.0),
    );
    match placement.edge {
        Some(Edge::Left) => x_ratio = 0.0,
        Some(Edge::Right) => x_ratio = 1.0,
        Some(Edge::Top) => y_ratio = 0.0,
        Some(Edge::Bottom) => y_ratio = 1.0,
        None => {}
    }
    // 比例乘以可用空间后四舍五入；结果在 0..=free 内，转换不会截断。
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let (dx, dy) = (
        (x_ratio * free_x as f64).round() as i64,
        (y_ratio * free_y as f64).round() as i64,
    );
    let point = Point {
        x: clamp_to_i32(i64::from(work.x) + dx),
        y: clamp_to_i32(i64::from(work.y) + dy),
    };
    Some((point, monitor.id.clone()))
}

/// 首次启动时的默认位置：主显示器右边缘，靠近顶部。
pub fn default_placement(monitors: &[MonitorInfo]) -> Option<Placement> {
    let monitor = monitors
        .iter()
        .find(|m| m.is_primary)
        .or_else(|| monitors.first())?;
    Some(Placement {
        monitor_id: monitor.id.clone(),
        edge: Some(Edge::Right),
        x_ratio: 1.0,
        y_ratio: DEFAULT_Y_RATIO,
    })
}

/// 面板相对徽标的水平锚点：徽标位于面板的哪一侧。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HorizontalAnchor {
    /// 徽标在面板左侧，面板向右展开。
    Left,
    /// 徽标在面板右侧，面板向左展开。
    Right,
}

/// 面板相对徽标的垂直锚点：徽标位于面板的上侧还是下侧。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalAnchor {
    /// 徽标在面板上侧，面板向下展开。
    Top,
    /// 徽标在面板下侧，面板向上展开。
    Bottom,
}

/// 展开后的窗口布局：目标外框与展开方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpandedLayout {
    /// 展开后窗口的外框（物理像素）。
    pub bounds: Rect,
    /// 水平锚点。
    pub horizontal: HorizontalAnchor,
    /// 垂直锚点。
    pub vertical: VerticalAnchor,
}

/// 计算悬浮窗展开为 Today 面板后的外框。
///
/// 面板总是朝**屏幕内侧**展开：徽标在工作区右半边就向左展开（面板右缘与徽标右缘对齐），
/// 在左半边就向右展开；上下方向同理。这样无论徽标贴在四条边的哪一条、或者在四个角落，
/// 展开后的面板都完整位于当前显示器工作区内（产品文档 §5.2、实施计划 1.3）。
/// 面板尺寸以 logical px 给出，按徽标所在显示器的缩放换算；比工作区还大时收缩到工作区大小。
///
/// 返回 `None` 表示没有可用的显示器。
pub fn expand_bounds(
    collapsed: Rect,
    panel_logical: (f64, f64),
    monitors: &[MonitorInfo],
) -> Option<ExpandedLayout> {
    let monitor = pick_monitor(monitors, collapsed.center())?;
    let work = monitor.work_area;
    let width = to_physical(panel_logical.0, monitor.scale_factor).min(work.width);
    let height = to_physical(panel_logical.1, monitor.scale_factor).min(work.height);

    let center = collapsed.center();
    let work_center_x = i64::from(work.x) + i64::from(work.width) / 2;
    let work_center_y = i64::from(work.y) + i64::from(work.height) / 2;
    let horizontal = if i64::from(center.x) >= work_center_x {
        HorizontalAnchor::Right
    } else {
        HorizontalAnchor::Left
    };
    let vertical = if i64::from(center.y) >= work_center_y {
        VerticalAnchor::Bottom
    } else {
        VerticalAnchor::Top
    };

    let collapsed_right = i64::from(collapsed.x) + i64::from(collapsed.width);
    let collapsed_bottom = i64::from(collapsed.y) + i64::from(collapsed.height);
    let x = match horizontal {
        HorizontalAnchor::Left => i64::from(collapsed.x),
        HorizontalAnchor::Right => collapsed_right - i64::from(width),
    };
    let y = match vertical {
        VerticalAnchor::Top => i64::from(collapsed.y),
        VerticalAnchor::Bottom => collapsed_bottom - i64::from(height),
    };
    // 最后统一夹到工作区内：徽标本身贴着或略超出边缘时，面板也不会跑出屏幕。
    let max_x = i64::from(work.x) + i64::from(work.width) - i64::from(width);
    let max_y = i64::from(work.y) + i64::from(work.height) - i64::from(height);
    let x = x.clamp(i64::from(work.x), max_x.max(i64::from(work.x)));
    let y = y.clamp(i64::from(work.y), max_y.max(i64::from(work.y)));

    Some(ExpandedLayout {
        bounds: Rect {
            x: clamp_to_i32(x),
            y: clamp_to_i32(y),
            width,
            height,
        },
        horizontal,
        vertical,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// 构造一块显示器。
    fn monitor(id: &str, x: i32, y: i32, w: u32, h: u32, scale: f64, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id: id.to_owned(),
            work_area: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            scale_factor: scale,
            is_primary: primary,
        }
    }

    /// 1920x1080 的 100% 主显示器，工作区排除 40px 任务栏。
    fn primary() -> MonitorInfo {
        monitor("DISPLAY1", 0, 0, 1920, 1040, 1.0, true)
    }

    /// 以左上角坐标构造一个 88x40 的徽标外框。
    fn badge(x: i32, y: i32) -> Rect {
        Rect {
            x,
            y,
            width: 88,
            height: 40,
        }
    }

    /// 取松手落位后的屏幕坐标。
    fn settle(bounds: Rect, monitors: &[MonitorInfo]) -> (Point, Option<Edge>) {
        let placement = placement_for_bounds(bounds, monitors).unwrap();
        let (point, _) = resolve_position(&placement, (88.0, 40.0), monitors).unwrap();
        (point, placement.edge)
    }

    #[test]
    fn a_drop_near_an_edge_stays_exactly_where_it_was_dropped() {
        // 离左边 10px、离右边 5px、离上边 12px：都不会被吸过去。
        assert_eq!(
            settle(badge(10, 300), &[primary()]),
            (Point { x: 10, y: 300 }, None)
        );
        assert_eq!(
            settle(badge(1920 - 88 - 5, 500), &[primary()]),
            (
                Point {
                    x: 1920 - 88 - 5,
                    y: 500
                },
                None
            )
        );
        assert_eq!(
            settle(badge(800, 12), &[primary()]),
            (Point { x: 800, y: 12 }, None)
        );
    }

    #[test]
    fn a_badge_flush_with_an_edge_is_anchored_to_it() {
        assert_eq!(
            settle(badge(0, 300), &[primary()]),
            (Point { x: 0, y: 300 }, Some(Edge::Left))
        );
        assert_eq!(
            settle(badge(1920 - 88, 500), &[primary()]),
            (
                Point {
                    x: 1920 - 88,
                    y: 500
                },
                Some(Edge::Right)
            )
        );
        assert_eq!(
            settle(badge(800, 1040 - 40), &[primary()]),
            (Point { x: 800, y: 1000 }, Some(Edge::Bottom))
        );
    }

    #[test]
    fn corner_anchors_to_the_edge_it_overhangs_most() {
        // 超出左边 4、超出上边 10：取超出更多的上边；左边那一轴也被拉回屏幕内。
        let (point, edge) = settle(badge(-4, -10), &[primary()]);
        assert_eq!(edge, Some(Edge::Top));
        assert_eq!(point, Point { x: 0, y: 0 });
    }

    #[test]
    fn far_from_edges_keeps_the_free_position() {
        let (point, edge) = settle(badge(700, 400), &[primary()]);
        assert_eq!(edge, None);
        assert_eq!(point, Point { x: 700, y: 400 });
    }

    #[test]
    fn window_partially_off_screen_is_pulled_back_onto_the_edge() {
        let (point, edge) = settle(badge(-30, 300), &[primary()]);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point, Point { x: 0, y: 300 });
    }

    #[test]
    fn badge_visual_size_is_constant_across_scale_factors() {
        let placement = Placement {
            monitor_id: "A".into(),
            edge: Some(Edge::Right),
            x_ratio: 1.0,
            y_ratio: 0.5,
        };
        let at_100 = monitor("A", 0, 0, 1920, 1040, 1.0, true);
        let at_150 = monitor("A", 0, 0, 2880, 1560, 1.5, true);
        // 贴右时，窗口左上角 x = 工作区宽度 - 物理宽度；物理宽度 = logical * scale。
        assert_eq!(
            resolve_position(&placement, (88.0, 40.0), &[at_100])
                .unwrap()
                .0
                .x,
            1920 - 88
        );
        assert_eq!(
            resolve_position(&placement, (88.0, 40.0), &[at_150])
                .unwrap()
                .0
                .x,
            2880 - 132
        );
    }

    #[test]
    fn restores_onto_the_saved_monitor_when_present() {
        let right = monitor("DISPLAY2", 1920, 0, 2560, 1400, 1.0, false);
        let monitors = [primary(), right];
        let placement = Placement {
            monitor_id: "DISPLAY2".into(),
            edge: Some(Edge::Left),
            x_ratio: 0.0,
            y_ratio: 0.25,
        };
        let (point, used) = resolve_position(&placement, (88.0, 40.0), &monitors).unwrap();
        assert_eq!(used, "DISPLAY2");
        assert_eq!(point.x, 1920);
        assert!((0..1400).contains(&point.y));
    }

    #[test]
    fn falls_back_to_primary_when_the_saved_monitor_is_gone() {
        let placement = Placement {
            monitor_id: "UNPLUGGED".into(),
            edge: Some(Edge::Right),
            x_ratio: 1.0,
            y_ratio: 0.9,
        };
        let (point, used) = resolve_position(&placement, (88.0, 40.0), &[primary()]).unwrap();
        assert_eq!(used, "DISPLAY1");
        assert_eq!(point.x, 1920 - 88);
        // 无论如何都落在主显示器工作区内。
        assert!(point.y >= 0 && point.y + 40 <= 1040);
    }

    #[test]
    fn handles_monitors_with_negative_coordinates() {
        let left = monitor("LEFT", -1920, 0, 1920, 1040, 1.0, false);
        let monitors = [primary(), left];
        // 窗口位于左显示器上，略微超出其左缘。
        let (point, edge) = settle(badge(-1920 - 8, 100), &monitors);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point, Point { x: -1920, y: 100 });
        let placement = placement_for_bounds(badge(-1920 - 8, 100), &monitors).unwrap();
        assert_eq!(placement.monitor_id, "LEFT");
    }

    #[test]
    fn window_outside_every_monitor_goes_to_the_nearest_one() {
        let monitors = [primary(), monitor("RIGHT", 1920, 0, 1920, 1040, 1.0, false)];
        let placement = placement_for_bounds(badge(5000, 200), &monitors).unwrap();
        assert_eq!(placement.monitor_id, "RIGHT");
    }

    #[test]
    fn out_of_range_ratios_are_clamped_into_view() {
        let placement = Placement {
            monitor_id: "DISPLAY1".into(),
            edge: None,
            x_ratio: 7.5,
            y_ratio: -3.0,
        };
        let (point, _) = resolve_position(&placement, (88.0, 40.0), &[primary()]).unwrap();
        assert_eq!(point, Point { x: 1920 - 88, y: 0 });
    }

    #[test]
    fn window_larger_than_work_area_is_pinned_to_the_origin() {
        let tiny = monitor("TINY", 10, 20, 50, 30, 1.0, true);
        let placement = Placement {
            monitor_id: "TINY".into(),
            edge: None,
            x_ratio: 0.7,
            y_ratio: 0.7,
        };
        let (point, _) = resolve_position(&placement, (88.0, 40.0), &[tiny]).unwrap();
        assert_eq!(point, Point { x: 10, y: 20 });
    }

    #[test]
    fn no_monitors_means_no_placement() {
        assert!(placement_for_bounds(badge(0, 0), &[]).is_none());
        assert!(default_placement(&[]).is_none());
        let placement = Placement {
            monitor_id: "X".into(),
            edge: None,
            x_ratio: 0.0,
            y_ratio: 0.0,
        };
        assert!(resolve_position(&placement, (88.0, 40.0), &[]).is_none());
    }

    #[test]
    fn default_placement_is_on_the_primary_right_edge() {
        let monitors = [
            monitor("SECOND", 1920, 0, 1920, 1040, 1.0, false),
            primary(),
        ];
        let placement = default_placement(&monitors).unwrap();
        assert_eq!(placement.monitor_id, "DISPLAY1");
        assert_eq!(placement.edge, Some(Edge::Right));
        let (point, _) = resolve_position(&placement, (88.0, 40.0), &monitors).unwrap();
        assert_eq!(point.x, 1920 - 88);
    }

    #[test]
    fn placement_survives_resolution_changes() {
        // 在 1920x1040 上保存的"右侧 50% 高度"，换到 2560x1400 的显示器后仍在右侧中部。
        let saved = placement_for_bounds(badge(1920 - 88, (1040 - 40) / 2), &[primary()]).unwrap();
        let bigger = monitor("DISPLAY1", 0, 0, 2560, 1400, 1.0, true);
        let (point, _) = resolve_position(&saved, (88.0, 40.0), &[bigger]).unwrap();
        assert_eq!(point.x, 2560 - 88);
        assert_eq!(point.y, (1400 - 40) / 2);
    }

    #[test]
    fn placement_json_shape_is_stable() {
        let placement = Placement {
            monitor_id: "DISPLAY2".into(),
            edge: Some(Edge::Right),
            x_ratio: 1.0,
            y_ratio: 0.42,
        };
        let json = serde_json::to_value(&placement).unwrap();
        assert_eq!(json["monitor_id"], "DISPLAY2");
        assert_eq!(json["edge"], "right");
        assert_eq!(
            serde_json::from_value::<Placement>(json).unwrap(),
            placement
        );
    }

    /// 判断矩形是否完整位于显示器工作区内。
    fn inside(rect: Rect, monitor: &MonitorInfo) -> bool {
        let work = monitor.work_area;
        i64::from(rect.x) >= i64::from(work.x)
            && i64::from(rect.y) >= i64::from(work.y)
            && i64::from(rect.x) + i64::from(rect.width)
                <= i64::from(work.x) + i64::from(work.width)
            && i64::from(rect.y) + i64::from(rect.height)
                <= i64::from(work.y) + i64::from(work.height)
    }

    /// 以 logical 300x380 展开。
    fn expand(collapsed: Rect, monitors: &[MonitorInfo]) -> ExpandedLayout {
        expand_bounds(collapsed, (300.0, 380.0), monitors).unwrap()
    }

    #[test]
    fn panel_expands_inward_from_every_edge_and_corner() {
        let monitor = primary();
        let monitors = [monitor.clone()];
        // (徽标左上角, 期望的水平锚点, 期望的垂直锚点)
        let cases = [
            ((0, 500), HorizontalAnchor::Left, VerticalAnchor::Bottom),
            (
                (1920 - 88, 200),
                HorizontalAnchor::Right,
                VerticalAnchor::Top,
            ),
            ((900, 0), HorizontalAnchor::Left, VerticalAnchor::Top),
            (
                (1200, 1000),
                HorizontalAnchor::Right,
                VerticalAnchor::Bottom,
            ),
            // 四个角落
            ((0, 0), HorizontalAnchor::Left, VerticalAnchor::Top),
            ((1920 - 88, 0), HorizontalAnchor::Right, VerticalAnchor::Top),
            ((0, 1000), HorizontalAnchor::Left, VerticalAnchor::Bottom),
            (
                (1920 - 88, 1000),
                HorizontalAnchor::Right,
                VerticalAnchor::Bottom,
            ),
        ];
        for ((x, y), horizontal, vertical) in cases {
            let layout = expand(badge(x, y), &monitors);
            assert_eq!(
                (layout.horizontal, layout.vertical),
                (horizontal, vertical),
                "{x},{y}"
            );
            assert!(
                inside(layout.bounds, &monitor),
                "展开后超出屏幕：{x},{y} -> {:?}",
                layout.bounds
            );
            assert_eq!((layout.bounds.width, layout.bounds.height), (300, 380));
        }
    }

    #[test]
    fn the_badge_corner_stays_anchored_so_the_pointer_remains_over_the_panel() {
        let monitors = [primary()];
        // 右上角：面板右缘与徽标右缘对齐、上缘与徽标上缘对齐。
        let badge_rect = badge(1920 - 88, 40);
        let layout = expand(badge_rect, &monitors);
        assert_eq!(layout.bounds.x + 300, 1920);
        assert_eq!(layout.bounds.y, 40);
        // 徽标区域被面板完整覆盖。
        assert!(layout.bounds.x <= badge_rect.x && layout.bounds.y <= badge_rect.y);
    }

    #[test]
    fn panel_size_follows_the_monitor_scale() {
        let hi_dpi = monitor("HIDPI", 0, 0, 2880, 1560, 1.5, true);
        let layout = expand(
            Rect {
                x: 0,
                y: 0,
                width: 132,
                height: 60,
            },
            &[hi_dpi],
        );
        assert_eq!((layout.bounds.width, layout.bounds.height), (450, 570));
    }

    #[test]
    fn panel_is_shrunk_to_fit_a_tiny_work_area() {
        let tiny = monitor("TINY", 0, 0, 200, 300, 1.0, true);
        let layout = expand(
            Rect {
                x: 100,
                y: 200,
                width: 88,
                height: 40,
            },
            std::slice::from_ref(&tiny),
        );
        assert_eq!((layout.bounds.width, layout.bounds.height), (200, 300));
        assert!(inside(layout.bounds, &tiny));
    }

    #[test]
    fn expansion_on_a_secondary_monitor_stays_on_it() {
        let right = monitor("RIGHT", 1920, 0, 1920, 1040, 1.0, false);
        let monitors = [primary(), right.clone()];
        let layout = expand(badge(1920 + 1920 - 88, 300), &monitors);
        assert!(inside(layout.bounds, &right));
        assert!(layout.bounds.x >= 1920);
    }

    #[test]
    fn rect_contains_uses_half_open_pixel_semantics() {
        let rect = Rect {
            x: 10,
            y: 20,
            width: 5,
            height: 5,
        };
        assert!(rect.contains(Point { x: 10, y: 20 }));
        assert!(rect.contains(Point { x: 14, y: 24 }));
        assert!(!rect.contains(Point { x: 15, y: 24 }));
        assert!(!rect.contains(Point { x: 14, y: 25 }));
        assert!(!rect.contains(Point { x: 9, y: 20 }));
    }

    #[test]
    fn no_monitors_means_no_expansion() {
        assert!(expand_bounds(badge(0, 0), (300.0, 380.0), &[]).is_none());
    }
}
