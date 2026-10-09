//! 悬浮窗位置的纯计算：边缘吸附、跨显示器与 DPI（架构文档 §11）。
//!
//! 保存位置时**不保存绝对像素**，而是保存 [`Placement`]：显示器 ID + 吸附边缘 + 在该显示器
//! 工作区内的相对位置（比例）。这样分辨率、缩放比例或显示器布局变化后，窗口仍然落在合理位置；
//! 找不到原显示器时回退到主显示器。
//!
//! 本模块不依赖任何窗口库，输入输出都是物理像素的简单结构，便于完整的单元测试。
//! 尺寸以 logical px 约定（徽标视觉大小在不同缩放比例下一致），转换为物理像素时乘以显示器的缩放系数。

use serde::{Deserialize, Serialize};

/// 吸附阈值（logical px）：窗口边缘距离屏幕边缘不超过该值时吸附。
pub const SNAP_THRESHOLD_LOGICAL_PX: f64 = 24.0;

/// 收起态（徽标）的宽度（logical px）。
pub const COLLAPSED_WIDTH_LOGICAL_PX: f64 = 88.0;

/// 收起态（徽标）的高度（logical px）。
pub const COLLAPSED_HEIGHT_LOGICAL_PX: f64 = 40.0;

/// 默认位置在吸附边缘（右侧）上的相对高度：靠近顶部但不贴边。
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

/// 窗口吸附的屏幕边缘。
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
    /// 吸附的边缘；`None` 表示自由位置。
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

/// 根据窗口当前的外框计算应保存的位置，并判断是否应当吸附到边缘。
///
/// 窗口中心所在的显示器决定了归属；窗口边缘距离该显示器工作区边缘在
/// [`SNAP_THRESHOLD_LOGICAL_PX`]（按该显示器缩放换算）以内时吸附到最近的边缘，
/// 窗口部分超出工作区也算"在阈值内"。距离相同时按 左、右、上、下 的顺序取先者。
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
    // 阈值转为物理像素；取整即可，亚像素精度对吸附手感没有意义。
    #[allow(clippy::cast_possible_truncation)]
    let threshold = (SNAP_THRESHOLD_LOGICAL_PX * monitor.scale_factor).round() as i64;
    let mut edge: Option<(Edge, i64)> = None;
    for (candidate, distance) in distances {
        if distance <= threshold && edge.is_none_or(|(_, best)| distance < best) {
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
    // 吸附的轴强制贴边，保证"吸附后位置恰好在边缘"。
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

    /// 取吸附结果的屏幕坐标。
    fn settle(bounds: Rect, monitors: &[MonitorInfo]) -> (Point, Option<Edge>) {
        let placement = placement_for_bounds(bounds, monitors).unwrap();
        let (point, _) = resolve_position(&placement, (88.0, 40.0), monitors).unwrap();
        (point, placement.edge)
    }

    #[test]
    fn snaps_to_the_left_edge_within_threshold() {
        let (point, edge) = settle(badge(10, 300), &[primary()]);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point, Point { x: 0, y: 300 });
    }

    #[test]
    fn snaps_to_the_right_edge() {
        // 窗口右缘距离屏幕右缘 5px。
        let (point, edge) = settle(badge(1920 - 88 - 5, 500), &[primary()]);
        assert_eq!(edge, Some(Edge::Right));
        assert_eq!(
            point,
            Point {
                x: 1920 - 88,
                y: 500
            }
        );
    }

    #[test]
    fn snaps_to_top_and_bottom() {
        let (top, edge) = settle(badge(800, 12), &[primary()]);
        assert_eq!((top, edge), (Point { x: 800, y: 0 }, Some(Edge::Top)));

        let (bottom, edge) = settle(badge(800, 1040 - 40 - 20), &[primary()]);
        assert_eq!(
            (bottom, edge),
            (Point { x: 800, y: 1000 }, Some(Edge::Bottom))
        );
    }

    #[test]
    fn corner_snaps_to_the_single_nearest_edge() {
        // 距离左边 4、距离上边 10：一次只吸附最近的一条边（左边）；
        // 上边保持用户拖放的位置，不会被"强行"同时吸附。
        let (point, edge) = settle(badge(4, 10), &[primary()]);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point, Point { x: 0, y: 10 });
    }

    #[test]
    fn far_from_edges_keeps_the_free_position() {
        let (point, edge) = settle(badge(700, 400), &[primary()]);
        assert_eq!(edge, None);
        assert_eq!(point, Point { x: 700, y: 400 });
    }

    #[test]
    fn threshold_scales_with_dpi() {
        // 150% 缩放：阈值 36 物理像素。距离 30 应吸附；100% 缩放下 30 > 24 不吸附。
        let hi_dpi = monitor("HIDPI", 0, 0, 2880, 1560, 1.5, true);
        assert_eq!(
            settle(
                Rect {
                    x: 30,
                    y: 600,
                    width: 132,
                    height: 60
                },
                &[hi_dpi]
            )
            .1,
            Some(Edge::Left)
        );
        assert_eq!(settle(badge(30, 600), &[primary()]).1, None);
    }

    #[test]
    fn window_partially_off_screen_still_snaps() {
        let (point, edge) = settle(badge(-30, 300), &[primary()]);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point.x, 0);
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
        // 窗口位于左显示器上，靠近其左缘。
        let (point, edge) = settle(badge(-1920 + 8, 100), &monitors);
        assert_eq!(edge, Some(Edge::Left));
        assert_eq!(point, Point { x: -1920, y: 100 });
        let placement = placement_for_bounds(badge(-1920 + 8, 100), &monitors).unwrap();
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
}
