//! 可注入的时钟。
//!
//! 所有依赖"现在"或"今天"的逻辑都必须通过 [`Clock`] 获得时间，禁止在业务代码中直接调用
//! `Utc::now()` / `Local::now()`，这样日期相关行为（午夜切换、逾期、提醒）才能用
//! [`FakeClock`] 稳定测试（实施计划 0.4）。

use std::sync::{Arc, Mutex, PoisonError};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;

/// 提供当前时间与用户时区的时钟抽象。
pub trait Clock: Send + Sync {
    /// 返回当前 UTC 时间。
    fn now_utc(&self) -> DateTime<Utc>;

    /// 返回用户所在时区。
    ///
    /// "今天"、"明天"等日期语义都按该时区解释（实施计划 D-03）。
    fn timezone(&self) -> Tz;

    /// 返回用户本地时区下的今天日期。
    fn today_local(&self) -> NaiveDate {
        self.now_utc().with_timezone(&self.timezone()).date_naive()
    }
}

/// 读取操作系统时间与时区的真实时钟。
#[derive(Debug, Clone)]
pub struct SystemClock {
    /// 构造时探测到的系统时区。
    timezone: Tz,
}

impl SystemClock {
    /// 探测系统时区并创建时钟；探测失败时回退到 UTC 并记录警告。
    pub fn new() -> Self {
        let timezone = iana_time_zone::get_timezone()
            .ok()
            .and_then(|name| name.parse::<Tz>().ok())
            .unwrap_or_else(|| {
                tracing::warn!(
                    event = "timezone_detect_failed",
                    "无法识别系统时区，回退到 UTC"
                );
                Tz::UTC
            });
        Self { timezone }
    }
}

impl Default for SystemClock {
    /// 等价于 [`SystemClock::new`]。
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    /// 读取系统当前时间。本函数是业务代码中唯一允许直接读取系统时间的位置。
    fn now_utc(&self) -> DateTime<Utc> {
        Utc::now()
    }

    /// 返回构造时探测到的时区。
    fn timezone(&self) -> Tz {
        self.timezone
    }
}

/// 测试用的可控时钟，多个克隆共享同一份时间。
#[derive(Debug, Clone)]
pub struct FakeClock {
    /// 当前假想的 UTC 时间，用 `Arc<Mutex>` 让克隆之间保持同步。
    now: Arc<Mutex<DateTime<Utc>>>,
    /// 假想的用户时区。
    timezone: Tz,
}

impl FakeClock {
    /// 创建一个固定在 `now`、时区为 UTC 的时钟。
    pub fn at_utc(now: DateTime<Utc>) -> Self {
        Self::new(now, Tz::UTC)
    }

    /// 创建一个固定在 `now`、使用给定时区的时钟。
    pub fn new(now: DateTime<Utc>, timezone: Tz) -> Self {
        Self {
            now: Arc::new(Mutex::new(now)),
            timezone,
        }
    }

    /// 把时间设置为 `now`（可以向前或向后，用于模拟时钟调整）。
    pub fn set(&self, now: DateTime<Utc>) {
        // 锁中毒只可能源自其他测试线程 panic，时间值本身仍然有效，直接取回即可。
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = now;
    }

    /// 把时间向前推进 `delta`。
    pub fn advance(&self, delta: Duration) {
        let mut guard = self.now.lock().unwrap_or_else(PoisonError::into_inner);
        *guard += delta;
    }
}

impl Clock for FakeClock {
    /// 返回当前假想时间。
    fn now_utc(&self) -> DateTime<Utc> {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 返回假想时区。
    fn timezone(&self) -> Tz {
        self.timezone
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn today_local_follows_timezone() {
        // UTC 16:30 在上海已是次日 00:30。
        let now = Utc.with_ymd_and_hms(2026, 10, 9, 16, 30, 0).unwrap();
        let shanghai = FakeClock::new(now, Tz::Asia__Shanghai);
        let utc = FakeClock::at_utc(now);
        assert_eq!(
            shanghai.today_local(),
            NaiveDate::from_ymd_opt(2026, 10, 10).unwrap()
        );
        assert_eq!(
            utc.today_local(),
            NaiveDate::from_ymd_opt(2026, 10, 9).unwrap()
        );
    }

    #[test]
    fn advancing_across_midnight_changes_today() {
        let clock = FakeClock::new(
            Utc.with_ymd_and_hms(2026, 10, 9, 15, 59, 0).unwrap(),
            Tz::Asia__Shanghai,
        );
        let before = clock.today_local();
        clock.advance(Duration::minutes(2));
        assert_eq!(clock.today_local(), before.succ_opt().unwrap());
    }

    #[test]
    fn clones_share_time() {
        let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap());
        let other = clock.clone();
        clock.set(Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap());
        assert_eq!(other.now_utc(), clock.now_utc());
    }

    #[test]
    fn system_clock_reports_a_timezone() {
        let clock = SystemClock::new();
        // 只验证不 panic 且能给出日期；具体时区取决于运行环境。
        let _ = clock.timezone();
        let _ = clock.today_local();
    }
}
