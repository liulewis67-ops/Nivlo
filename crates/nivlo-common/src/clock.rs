//! 可注入的时钟。
//!
//! 所有依赖"现在"或"今天"的逻辑都必须通过 [`Clock`] 获得时间，禁止在业务代码中直接调用
//! `Utc::now()` / `Local::now()`，这样日期相关行为（午夜切换、逾期、提醒）才能用
//! [`FakeClock`] 稳定测试（实施计划 0.4）。

use std::sync::{Arc, Mutex, PoisonError};

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
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

/// 返回本地日期 `date` 的开始时刻（该日 00:00，本地时区）对应的 UTC 时间点。
///
/// 夏令时可能让某天的 00:00 不存在（时钟从 23:59 直接跳到 01:00），此时取该日之后第一个
/// 存在的整点——那才是用户真正看到"这一天开始了"的时刻。
pub fn start_of_local_day(date: NaiveDate, timezone: Tz) -> DateTime<Utc> {
    let mut candidate = date.and_hms_opt(0, 0, 0).unwrap_or_default();
    // 最多尝试 24 个整点：任何时区的夏令时空隙都不会超过几个小时。
    for _ in 0..24 {
        if let Some(local) = timezone.from_local_datetime(&candidate).earliest() {
            return local.with_timezone(&Utc);
        }
        candidate += Duration::hours(1);
    }
    // 理论上不可达；退化为按 UTC 解释，保证调用方不会死循环。
    Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap_or_default())
}

/// 计算 `now` 之后的第一个"本地午夜"（下一个本地日期的开始）对应的 UTC 时间点。
///
/// 用于在日期切换时刻精确唤醒，而不是逐秒轮询。
pub fn next_local_midnight(now: DateTime<Utc>, timezone: Tz) -> DateTime<Utc> {
    let today = now.with_timezone(&timezone).date_naive();
    start_of_local_day(today.succ_opt().unwrap_or(today), timezone)
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
    fn next_midnight_in_a_fixed_offset_zone() {
        // 上海 2026-10-09 23:30（UTC 15:30）→ 下一个午夜是 10-10 00:00 上海 = 10-09 16:00 UTC。
        let now = Utc.with_ymd_and_hms(2026, 10, 9, 15, 30, 0).unwrap();
        assert_eq!(
            next_local_midnight(now, Tz::Asia__Shanghai),
            Utc.with_ymd_and_hms(2026, 10, 9, 16, 0, 0).unwrap()
        );
        // 恰好在午夜：返回的是"下一个"午夜，而不是当前时刻。
        let at_midnight = Utc.with_ymd_and_hms(2026, 10, 9, 16, 0, 0).unwrap();
        assert_eq!(
            next_local_midnight(at_midnight, Tz::Asia__Shanghai),
            Utc.with_ymd_and_hms(2026, 10, 10, 16, 0, 0).unwrap()
        );
    }

    #[test]
    fn next_midnight_follows_the_users_timezone_not_utc() {
        let now = Utc.with_ymd_and_hms(2026, 10, 9, 12, 0, 0).unwrap();
        let utc = next_local_midnight(now, Tz::UTC);
        let la = next_local_midnight(now, Tz::America__Los_Angeles);
        assert_eq!(utc, Utc.with_ymd_and_hms(2026, 10, 10, 0, 0, 0).unwrap());
        // 洛杉矶当时是 PDT（UTC-7）：本地午夜 = UTC 07:00。
        assert_eq!(la, Utc.with_ymd_and_hms(2026, 10, 10, 7, 0, 0).unwrap());
    }

    #[test]
    fn next_midnight_handles_a_daylight_saving_gap_at_midnight() {
        // 圣保罗 2018-11-04 的夏令时从 00:00 直接跳到 01:00，当天不存在 00:00。
        let now = Utc.with_ymd_and_hms(2018, 11, 3, 12, 0, 0).unwrap();
        let next = next_local_midnight(now, Tz::America__Sao_Paulo);
        let local = next.with_timezone(&Tz::America__Sao_Paulo);
        assert_eq!(
            local.date_naive(),
            NaiveDate::from_ymd_opt(2018, 11, 4).unwrap()
        );
        assert_eq!(local.format("%H:%M").to_string(), "01:00");
    }

    #[test]
    fn next_midnight_across_a_daylight_saving_fall_back() {
        // 洛杉矶 2026-11-01 回拨一小时，当天有 25 小时；午夜到午夜仍是正确的本地日期边界。
        let now = Utc.with_ymd_and_hms(2026, 11, 1, 12, 0, 0).unwrap();
        let next = next_local_midnight(now, Tz::America__Los_Angeles);
        let local = next.with_timezone(&Tz::America__Los_Angeles);
        assert_eq!(
            local.date_naive(),
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
        );
        assert_eq!(local.format("%H:%M").to_string(), "00:00");
    }

    #[test]
    fn start_of_local_day_is_the_utc_instant_of_local_midnight() {
        let date = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        assert_eq!(
            start_of_local_day(date, Tz::Asia__Shanghai),
            Utc.with_ymd_and_hms(2026, 10, 8, 16, 0, 0).unwrap()
        );
        assert_eq!(
            start_of_local_day(date, Tz::UTC),
            Utc.with_ymd_and_hms(2026, 10, 9, 0, 0, 0).unwrap()
        );
    }

    #[test]
    fn system_clock_reports_a_timezone() {
        let clock = SystemClock::new();
        // 只验证不 panic 且能给出日期；具体时区取决于运行环境。
        let _ = clock.timezone();
        let _ = clock.today_local();
    }
}
