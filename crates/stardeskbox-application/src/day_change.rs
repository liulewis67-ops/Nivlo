//! 日期切换监视器：本地日期变化时发布 [`DomainEvent::DayChanged`]。
//!
//! Today 依赖"今天"，所以跨过本地午夜（或休眠唤醒、用户修改系统时间）之后必须通知 UI 重新取数。
//! 实现是 `sleep` 到下一个本地午夜，**不是逐秒轮询**；为了兜底休眠与改时间，每次睡眠最长
//! `MAX_SLEEP`，醒来后用墙上时钟重新核对日期。Phase 4 由 Scheduler 与原生电源 / 时钟事件
//! 接管（实施计划 4.4、4.5、10.5）。

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use stardeskbox_common::clock::{Clock, next_local_midnight};
use stardeskbox_domain::event::DomainEvent;

use crate::event::EventPublisher;

/// 单次睡眠的最长时间。
///
/// 系统休眠期间单调时钟可能不前进，睡过午夜的计时器会在唤醒后很久才触发；
/// 限制睡眠时长让监视器最迟在 15 分钟内核对到"日期已经变了"。每天只多唤醒不到 100 次，开销可忽略。
const MAX_SLEEP: Duration = Duration::from_secs(15 * 60);

/// 最短睡眠时间：防止计时器提前触发或时钟被回拨时出现忙等。
const MIN_SLEEP: Duration = Duration::from_millis(500);

/// 运行日期切换监视器，直到 `shutdown` 完成。
///
/// 日期变化（包括一次跨越多天的跳变）时只发布**一次** `DayChanged`，携带最新的日期。
/// 调用方应当把它作为受管后台任务启动，并用 `CancellationToken::cancelled()` 之类的 Future 作为
/// `shutdown`，让退出流程能够结束它。
pub async fn run_day_change_watcher(
    clock: Arc<dyn Clock>,
    events: Arc<dyn EventPublisher>,
    shutdown: impl Future<Output = ()> + Send,
) {
    tokio::pin!(shutdown);
    let mut current = clock.today_local();
    loop {
        let now = clock.now_utc();
        let target = next_local_midnight(now, clock.timezone());
        // `to_std` 在目标早于 now（时钟被回拨）时返回错误，此时用最短睡眠重新核对。
        let wait = (target - now)
            .to_std()
            .unwrap_or(MIN_SLEEP)
            .clamp(MIN_SLEEP, MAX_SLEEP);
        tokio::select! {
            () = &mut shutdown => return,
            () = tokio::time::sleep(wait) => {}
        }
        let today = clock.today_local();
        if today != current {
            current = today;
            tracing::info!(event = "day_changed", date = %today, "本地日期已切换");
            events.publish(DomainEvent::DayChanged { date: today });
        }
    }
}

#[cfg(test)]
mod tests;
