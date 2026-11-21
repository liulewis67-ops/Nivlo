//! Scheduler 的驱动：Reconcile 与睡眠循环。

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use nivlo_application::error::AppError;
use nivlo_application::ports::UnitOfWork;
use nivlo_application::trigger::{Trigger, TriggerKey, triggers_of};
use nivlo_common::clock::Clock;
use nivlo_platform::notification::NotificationPort;
use tokio::sync::Notify;

use crate::plan::{Locale, MISSED_LOOKBACK, Notice, ON_TIME_GRACE, compose, plan, single};

/// 单次睡眠的最长时间。
///
/// 系统休眠期间单调时钟可能不前进，睡过触发点的计时器会在唤醒后很久才触发；限制睡眠时长，
/// 让 Scheduler 最迟在这个时间内醒来、用墙上时钟重新核对一次（实施计划 4.5；Windows 原生的
/// 电源 / 时钟事件在 10.5 补强）。
pub const MAX_SLEEP: StdDuration = StdDuration::from_secs(15 * 60);

/// 最短睡眠时间：防止计时器提前触发或时钟被回拨时出现忙等。
pub const MIN_SLEEP: StdDuration = StdDuration::from_millis(500);

/// 墙上时钟与单调时钟的偏差超过这个值就认为发生了休眠恢复或系统时间调整（只记录日志）。
const JUMP_THRESHOLD: Duration = Duration::minutes(2);

/// 触发记录保留多久，更早的清理掉。
const LOG_RETENTION: Duration = Duration::days(30);

/// 最多发送几次，包括第一次。
pub const MAX_REMINDER_COUNT: u8 = 5;

/// Delay between repeated deliveries of the same reminder.
const REPEAT_INTERVAL: Duration = Duration::minutes(1);

/// Delivery state for a reminder that still has repetitions scheduled.
struct PendingRepeat {
    /// Original trigger, used to discard reminders removed or rescheduled by the user.
    key: TriggerKey,
    /// Number of deliveries already attempted for this reminder.
    sent: u8,
    /// Earliest time of the next repeated delivery.
    at: DateTime<Utc>,
    /// Whether the original trigger was recovered as a missed reminder.
    missed: bool,
}

/// Scheduler 的外部控制：唤醒与暂停通知。
#[derive(Debug, Default)]
pub struct Control {
    /// 唤醒信号：Schedule 变化、恢复通知、应用从休眠恢复时发送。
    wake: Notify,
    /// 是否暂停通知（托盘「暂停通知」）。
    paused: AtomicBool,
    /// 通知文案的语言（`Locale` 的编号，切换语言后下一次通知生效）。
    locale: AtomicU8,
    /// Configured total delivery count, including the initial reminder.
    repeat_count: AtomicU8,
}

impl Control {
    /// 创建控制句柄。
    pub fn new() -> Self {
        Self::default()
    }

    /// 让 Scheduler 立刻重新计算。多次唤醒会合并成一次。
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// 暂停或恢复通知。暂停期间到点的触发点**不丢**：恢复后作为「错过的」汇总通知。
    pub fn set_paused(&self, paused: bool) {
        let was = self.paused.swap(paused, Ordering::SeqCst);
        if was && !paused {
            self.wake();
        }
    }

    /// 切换通知文案的语言。
    pub fn set_locale(&self, locale: Locale) {
        self.locale.store(locale as u8, Ordering::SeqCst);
    }

    /// 当前通知文案的语言。
    pub fn locale(&self) -> Locale {
        match self.locale.load(Ordering::SeqCst) {
            1 => Locale::En,
            _ => Locale::ZhCn,
        }
    }

    /// 设置每个提醒的发送次数，包括第一次。
    pub fn set_repeat_count(&self, count: u8) {
        self.repeat_count
            .store(count.clamp(1, MAX_REMINDER_COUNT), Ordering::SeqCst);
        self.wake();
    }

    /// 默认一次；零表示还没加载任何偏好。
    pub fn repeat_count(&self) -> u8 {
        self.repeat_count.load(Ordering::SeqCst).max(1)
    }

    /// 当前是否暂停通知。
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

/// Scheduler。
pub struct Scheduler {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：「现在」与用户时区。
    clock: Arc<dyn Clock>,
    /// 通知出口。
    notifier: Arc<dyn NotificationPort>,
    /// 外部控制。
    control: Arc<Control>,
    /// 同一次应用运行中的后续提醒；首次投递仍由持久化触发记录去重。
    repeats: Mutex<Vec<PendingRepeat>>,
}

impl Scheduler {
    /// 创建 Scheduler。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        notifier: Arc<dyn NotificationPort>,
        control: Arc<Control>,
    ) -> Self {
        Self {
            uow,
            clock,
            notifier,
            control,
            repeats: Mutex::default(),
        }
    }

    /// Attempt notification delivery and record its result without stopping the scheduler.
    fn send(&self, notice: &Notice) {
        match self.notifier.notify(&notice.notification) {
            // 只记数量与是否补发，不记标题（日志可能随诊断包导出）。
            Ok(()) => tracing::info!(
                event = "notification_sent",
                triggers = notice.keys.len(),
                missed = notice.missed,
                "已发送系统通知"
            ),
            Err(error) => {
                tracing::warn!(event = "notification_failed", %error, "发送系统通知失败");
            }
        }
    }

    /// Deliver due repetitions, discard stale triggers, and return the next repeat time.
    fn process_repeats(
        &self,
        now: DateTime<Utc>,
        timezone: Tz,
        triggers: &[Trigger],
    ) -> Option<DateTime<Utc>> {
        let mut repeats = self
            .repeats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let count = self.control.repeat_count();
        repeats.retain_mut(|repeat| {
            if repeat.sent >= count || now - repeat.at > ON_TIME_GRACE {
                return false;
            }
            // 完成、删除或改时间都会让原来的触发点消失。
            let Some(trigger) = triggers.iter().find(|trigger| trigger.key == repeat.key) else {
                return false;
            };
            if repeat.at <= now && !self.control.is_paused() {
                self.send(&single(
                    trigger,
                    repeat.missed,
                    timezone,
                    self.control.locale(),
                ));
                repeat.sent += 1;
                repeat.at = now + REPEAT_INTERVAL;
            }
            repeat.sent < count
        });
        repeats.iter().map(|repeat| repeat.at).min()
    }

    /// Reconcile：把现在该触发的触发点通知出去并记录，返回下一个触发点的时刻。
    ///
    /// 启动、休眠唤醒、时钟变化、计时到点都走这一个入口，所以行为一致：
    /// 已经通知过的不会重复，错过的（超过准时宽限）补发，暂停期间不通知也不记录。
    ///
    /// 先发通知、后提交记录：进程恰好在两者之间崩溃最坏是重复一次，而不是丢失一次提醒。
    ///
    /// # Errors
    ///
    /// 存储错误；此时没有记录任何东西。
    pub async fn reconcile(&self) -> Result<Option<DateTime<Utc>>, AppError> {
        let now = self.clock.now_utc();
        let timezone = self.clock.timezone();
        let mut tx = self.uow.begin().await?;
        let sources = tx.triggers().list_trigger_sources().await?;
        let triggers: Vec<_> = sources
            .iter()
            .flat_map(|item| triggers_of(item, timezone))
            .collect();
        let fired: HashSet<TriggerKey> = tx
            .triggers()
            .list_fired_since(now - MISSED_LOOKBACK - Duration::days(1))
            .await?
            .into_iter()
            .collect();
        let repeat_at = self.process_repeats(now, timezone, &triggers);
        let result = plan(now, triggers, &fired);
        let mut scheduled = Vec::new();

        if !self.control.is_paused() {
            for notice in compose(now, &result.due, timezone, self.control.locale()) {
                self.send(&notice);
                // 汇总通知只发一次。单条通知按配置继续提醒。
                if let [key] = notice.keys.as_slice()
                    && self.control.repeat_count() > 1
                {
                    scheduled.push(PendingRepeat {
                        key: *key,
                        sent: 1,
                        at: now + REPEAT_INTERVAL,
                        missed: notice.missed,
                    });
                }
                for key in &notice.keys {
                    tx.triggers().record_fired(key, now, notice.missed).await?;
                }
            }
            tx.triggers()
                .prune_fired_before(now - LOG_RETENTION)
                .await?;
        }
        tx.commit().await?;
        let first_repeat_at = scheduled.first().map(|repeat| repeat.at);
        if !scheduled.is_empty() {
            self.repeats
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(scheduled);
        }
        Ok([result.next, repeat_at, first_repeat_at]
            .into_iter()
            .flatten()
            .min())
    }

    /// 运行 Scheduler 直到 `shutdown` 完成：Reconcile → 睡到最近的触发点（最长 [`MAX_SLEEP`]）→ 重复。
    ///
    /// 睡眠可被 [`Control::wake`] 打断。调用方应当把它作为受管后台任务启动，
    /// 并用 `CancellationToken::cancelled()` 之类的 Future 作为 `shutdown`，让退出流程能够结束它。
    pub async fn run(&self, shutdown: impl Future<Output = ()> + Send) {
        tokio::pin!(shutdown);
        loop {
            let next = match self.reconcile().await {
                Ok(next) => next,
                Err(error) => {
                    tracing::warn!(event = "scheduler_reconcile_failed", %error, "Scheduler 计算触发点失败");
                    None
                }
            };
            let now = self.clock.now_utc();
            // 暂停期间不必为具体触发点醒来：恢复时会被唤醒，这里只做低频核对。
            let wait = match next {
                Some(at) if !self.control.is_paused() => (at - now).to_std().unwrap_or(MIN_SLEEP),
                _ => MAX_SLEEP,
            }
            .clamp(MIN_SLEEP, MAX_SLEEP);

            let wall_before = self.clock.now_utc();
            let mono_before = tokio::time::Instant::now();
            tokio::select! {
                () = &mut shutdown => return,
                () = self.control.wake.notified() => {}
                () = tokio::time::sleep(wait) => {}
            }
            let mono_elapsed =
                Duration::from_std(mono_before.elapsed()).unwrap_or(Duration::zero());
            let wall_elapsed = self.clock.now_utc() - wall_before;
            if (wall_elapsed - mono_elapsed).abs() > JUMP_THRESHOLD {
                tracing::info!(
                    event = "clock_jump_or_resume",
                    drift_seconds = (wall_elapsed - mono_elapsed).num_seconds(),
                    "检测到系统休眠恢复或时间被调整，重新核对触发点"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests;
