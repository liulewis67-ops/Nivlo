//! 调度计划：给定「现在」、全部触发点与已触发记录，哪些现在该触发、下一个触发点是什么。
//!
//! 全部是纯函数，不碰数据库、时钟与通知——Scheduler 的可靠性（不丢、不重复、错过的补发）
//! 都在这里用确定性的输入验证（实施计划 4.4、4.5）。

use std::collections::HashSet;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use starat_application::trigger::{Trigger, TriggerKey, TriggerKind};
use starat_platform::notification::Notification;

/// 回溯多久之内错过的触发点还值得补发。更早的静默忽略：一周前的提醒再弹出来只是噪音。
pub const MISSED_LOOKBACK: Duration = Duration::days(7);

/// 触发点超过这么久才被处理，就算「错过」（唤醒后补发）而不是「准时」。
pub const ON_TIME_GRACE: Duration = Duration::minutes(2);

/// 错过的触发点最多逐条通知几个，更多的合并成一条汇总。
pub const MAX_INDIVIDUAL_MISSED: usize = 3;

/// 一次 Reconcile 的计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// 现在该触发的触发点，按触发时刻从早到晚。
    pub due: Vec<Trigger>,
    /// 下一个尚未触发、且在未来的触发点的时刻；没有则为 `None`。
    pub next: Option<DateTime<Utc>>,
}

/// 计算计划。
///
/// * 已经通知过的（在 `fired` 里）不会再触发——重启、唤醒、时钟被向后调整都不会让它重复；
/// * 触发时刻早于 `now - MISSED_LOOKBACK` 的不再补发；
/// * 触发时刻在未来的只参与计算 `next`。
pub fn plan(now: DateTime<Utc>, triggers: Vec<Trigger>, fired: &HashSet<TriggerKey>) -> Plan {
    let oldest = now - MISSED_LOOKBACK;
    let mut due: Vec<Trigger> = Vec::new();
    let mut next: Option<DateTime<Utc>> = None;
    for trigger in triggers {
        if fired.contains(&trigger.key) {
            continue;
        }
        let at = trigger.key.fire_at;
        if at > now {
            next = Some(next.map_or(at, |current| current.min(at)));
        } else if at >= oldest {
            due.push(trigger);
        }
    }
    due.sort_by_key(|trigger| trigger.key);
    Plan { due, next }
}

/// 通知文案的语言。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Locale {
    /// 简体中文（默认）。
    #[default]
    ZhCn,
    /// 英文。
    En,
}

/// 一条要发出去的通知，以及它代表的触发点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    /// 通知内容。
    pub notification: Notification,
    /// 这条通知覆盖的触发点（汇总通知覆盖多个）。
    pub keys: Vec<TriggerKey>,
    /// 是否是错过之后的补发。
    pub missed: bool,
}

/// 把「现在该触发」的触发点整理成通知。
///
/// 准时的逐条通知；错过的不超过 [`MAX_INDIVIDUAL_MISSED`] 条也逐条通知（标题带「错过」），
/// 更多的合并成一条汇总，避免休眠一夜醒来被通知轰炸（实施计划 4.5）。
pub fn compose(now: DateTime<Utc>, due: &[Trigger], timezone: Tz, locale: Locale) -> Vec<Notice> {
    let (late, on_time): (Vec<&Trigger>, Vec<&Trigger>) = due
        .iter()
        .partition(|trigger| now - trigger.key.fire_at > ON_TIME_GRACE);
    let mut notices: Vec<Notice> = on_time
        .into_iter()
        .map(|trigger| single(trigger, false, timezone, locale))
        .collect();
    if late.len() <= MAX_INDIVIDUAL_MISSED {
        notices.extend(
            late.into_iter()
                .map(|trigger| single(trigger, true, timezone, locale)),
        );
    } else {
        let titles: Vec<&str> = late.iter().take(3).map(|t| t.title.as_str()).collect();
        let (title, body) = match locale {
            Locale::ZhCn => (
                format!("你错过了 {} 个提醒", late.len()),
                format!("包括：{} 等。点击打开StarAt查看。", titles.join("、")),
            ),
            Locale::En => (
                format!("You missed {} reminders", late.len()),
                format!(
                    "Including: {} and more. Click to open StarAt.",
                    titles.join(", ")
                ),
            ),
        };
        notices.push(Notice {
            notification: Notification {
                title,
                body,
                item_id: None,
            },
            keys: late.iter().map(|t| t.key).collect(),
            missed: true,
        });
    }
    notices
}

/// 一个触发点的通知。
pub(crate) fn single(trigger: &Trigger, missed: bool, timezone: Tz, locale: Locale) -> Notice {
    let local = trigger.key.fire_at.with_timezone(&timezone);
    let clock_time = local.format("%H:%M");
    let label = match (locale, trigger.key.kind) {
        (Locale::ZhCn, TriggerKind::Reminder) => "提醒",
        (Locale::ZhCn, TriggerKind::Tip) => "💡 提示",
        (Locale::ZhCn, TriggerKind::Due) => "到期",
        (Locale::En, TriggerKind::Reminder) => "Reminder",
        (Locale::En, TriggerKind::Tip) => "💡 Tip",
        (Locale::En, TriggerKind::Due) => "Due",
    };
    let title = match (missed, locale) {
        (false, _) => label.to_owned(),
        (true, Locale::ZhCn) => format!("错过的{label}"),
        (true, Locale::En) => format!("Missed: {label}"),
    };
    // 补发的通知带上原本的时间，让用户知道是哪个时刻的事；准时的 Tip 直接显示时间。
    let body = match (missed, trigger.key.kind) {
        (true, _) | (false, TriggerKind::Tip) => format!("{clock_time} {}", trigger.title),
        (false, _) => trigger.title.clone(),
    };
    Notice {
        notification: Notification {
            title,
            body,
            item_id: Some(trigger.key.item_id.to_string()),
        },
        keys: vec![trigger.key],
        missed,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;
    use starat_domain::id::ItemId;
    use starat_domain::item::ItemType;
    use uuid::Uuid;

    use super::*;

    /// 2026-10-14 的某个 UTC 时刻。
    fn at(hour: u32, minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 14, hour, minute, 0).unwrap()
    }

    /// 一个触发点。
    fn trigger(n: u128, kind: TriggerKind, fire_at: DateTime<Utc>, title: &str) -> Trigger {
        Trigger {
            key: TriggerKey {
                fire_at,
                item_id: ItemId::from_uuid(Uuid::from_u128(n)),
                kind,
            },
            title: title.to_owned(),
            item_type: ItemType::Todo,
        }
    }

    #[test]
    fn due_and_next_are_split_around_now_and_sorted() {
        let triggers = vec![
            trigger(1, TriggerKind::Reminder, at(11, 0), "晚一点"),
            trigger(2, TriggerKind::Reminder, at(9, 0), "早"),
            trigger(3, TriggerKind::Reminder, at(10, 0), "正好现在"),
            trigger(4, TriggerKind::Reminder, at(12, 0), "更晚"),
        ];
        let result = plan(at(10, 0), triggers, &HashSet::new());
        let titles: Vec<&str> = result.due.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["早", "正好现在"]);
        assert_eq!(result.next, Some(at(11, 0)));
    }

    #[test]
    fn fired_triggers_never_fire_again_even_after_the_clock_goes_backwards() {
        let first = trigger(1, TriggerKind::Reminder, at(10, 0), "提醒");
        let fired: HashSet<TriggerKey> = [first.key].into_iter().collect();

        // 同一个时刻：不再触发。
        assert!(plan(at(10, 5), vec![first.clone()], &fired).due.is_empty());
        // 系统时间被向后调整到触发点之前：它又变成「未来」的触发点，但已经记录过，不参与 next。
        let rewound = plan(at(9, 0), vec![first.clone()], &fired);
        assert!(rewound.due.is_empty());
        assert_eq!(rewound.next, None);
        // 修改了提醒时间 = 新的触发点（时刻不同），会再次触发。
        let moved = trigger(1, TriggerKind::Reminder, at(10, 30), "提醒");
        assert_eq!(plan(at(10, 31), vec![moved], &fired).due.len(), 1);
        // 同一个 Item 的不同种类互不影响。
        let tip = trigger(1, TriggerKind::Tip, at(10, 0), "提醒");
        assert_eq!(plan(at(10, 5), vec![tip], &fired).due.len(), 1);
    }

    #[test]
    fn triggers_older_than_the_lookback_are_ignored() {
        let old = trigger(1, TriggerKind::Reminder, at(10, 0), "太久以前");
        let now = at(10, 0) + MISSED_LOOKBACK + Duration::minutes(1);
        assert!(plan(now, vec![old.clone()], &HashSet::new()).due.is_empty());
        let still = at(10, 0) + MISSED_LOOKBACK - Duration::minutes(1);
        assert_eq!(plan(still, vec![old], &HashSet::new()).due.len(), 1);
    }

    #[test]
    fn on_time_triggers_are_individual_and_tips_show_their_time() {
        let due = vec![
            trigger(1, TriggerKind::Reminder, at(10, 0), "交周报"),
            trigger(2, TriggerKind::Tip, at(10, 0), "站会"),
            trigger(3, TriggerKind::Due, at(10, 0), "提交材料"),
        ];
        let notices = compose(at(10, 1), &due, Tz::UTC, Locale::ZhCn);
        assert_eq!(notices.len(), 3);
        assert!(notices.iter().all(|n| !n.missed));
        assert_eq!(notices[0].notification.title, "提醒");
        assert_eq!(notices[0].notification.body, "交周报");
        assert_eq!(notices[1].notification.title, "💡 提示");
        assert_eq!(notices[1].notification.body, "10:00 站会");
        assert_eq!(notices[2].notification.title, "到期");
    }

    #[test]
    fn times_in_notifications_use_the_user_time_zone() {
        let due = vec![trigger(1, TriggerKind::Tip, at(2, 0), "东京的会")];
        let notices = compose(at(2, 1), &due, Tz::Asia__Tokyo, Locale::ZhCn);
        assert_eq!(notices[0].notification.body, "11:00 东京的会");
    }

    #[test]
    fn a_few_missed_triggers_are_individual_with_their_original_time() {
        let due = vec![
            trigger(1, TriggerKind::Reminder, at(10, 0), "开会"),
            trigger(2, TriggerKind::Reminder, at(10, 30), "吃药"),
        ];
        let notices = compose(at(11, 0), &due, Tz::UTC, Locale::ZhCn);
        assert_eq!(notices.len(), 2);
        assert!(notices.iter().all(|n| n.missed));
        assert_eq!(notices[0].notification.title, "错过的提醒");
        assert_eq!(notices[0].notification.body, "10:00 开会");
    }

    #[test]
    fn many_missed_triggers_are_merged_into_one_summary() {
        let due: Vec<Trigger> = (1..=6)
            .map(|n| {
                trigger(
                    n,
                    TriggerKind::Reminder,
                    at(8, n as u32),
                    &format!("事项{n}"),
                )
            })
            .collect();
        let notices = compose(at(12, 0), &due, Tz::UTC, Locale::ZhCn);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].notification.title, "你错过了 6 个提醒");
        assert_eq!(notices[0].notification.item_id, None);
        assert_eq!(notices[0].keys.len(), 6);
        assert!(notices[0].notification.body.contains("事项1"));
    }

    #[test]
    fn on_time_ones_stay_individual_when_mixed_with_many_missed() {
        let mut due: Vec<Trigger> = (1..=5)
            .map(|n| trigger(n, TriggerKind::Reminder, at(8, n as u32), "旧"))
            .collect();
        due.push(trigger(9, TriggerKind::Reminder, at(11, 59), "刚到点"));
        let notices = compose(at(12, 0), &due, Tz::UTC, Locale::ZhCn);
        assert_eq!(notices.len(), 2);
        let individual = notices.iter().find(|n| !n.missed).unwrap();
        assert_eq!(individual.notification.body, "刚到点");
    }

    #[test]
    fn english_notices() {
        let due = vec![trigger(1, TriggerKind::Reminder, at(10, 0), "standup")];
        let on_time = compose(at(10, 1), &due, Tz::UTC, Locale::En);
        assert_eq!(on_time[0].notification.title, "Reminder");
        let missed = compose(at(12, 0), &due, Tz::UTC, Locale::En);
        assert_eq!(missed[0].notification.title, "Missed: Reminder");
        assert_eq!(missed[0].notification.body, "10:00 standup");
    }
}
