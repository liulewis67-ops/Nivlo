//! UUIDv7 生成（实施计划 D-04）。
//!
//! UUIDv7 的高位是毫秒时间戳，因此按字符串排序大致等于按创建时间排序，
//! 对 SQLite 的 B-Tree 主键插入也更友好。时间戳来自注入的 [`Clock`]，保证测试可控。

use chrono::{DateTime, Utc};
use uuid::{ContextV7, Timestamp, Uuid};

use crate::clock::Clock;

/// 使用给定时间点生成一个 UUIDv7。
pub fn new_uuid_v7_at(at: DateTime<Utc>) -> Uuid {
    // 早于 Unix 纪元的时间不可能由系统时钟产生，按 0 处理即可，不必让调用方处理错误。
    let secs = u64::try_from(at.timestamp()).unwrap_or(0);
    // 每次新建上下文：随机位保证唯一性，同一毫秒内的单调性不作要求。
    Uuid::new_v7(Timestamp::from_unix(
        ContextV7::new(),
        secs,
        at.timestamp_subsec_nanos(),
    ))
}

/// 使用时钟的当前时间生成一个 UUIDv7。
pub fn new_uuid_v7(clock: &dyn Clock) -> Uuid {
    new_uuid_v7_at(clock.now_utc())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::clock::FakeClock;

    #[test]
    fn generates_version_7_uuid() {
        let id = new_uuid_v7_at(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
        assert_eq!(id.get_version_num(), 7);
    }

    #[test]
    fn ids_sort_by_creation_time() {
        let early = new_uuid_v7_at(Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap());
        let late = new_uuid_v7_at(Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 1).unwrap());
        assert!(early.to_string() < late.to_string());
    }

    #[test]
    fn uses_injected_clock() {
        let clock = FakeClock::at_utc(Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap());
        let id = new_uuid_v7(&clock);
        let secs = id.get_timestamp().unwrap().to_unix().0;
        assert_eq!(i64::try_from(secs).unwrap(), clock.now_utc().timestamp());
    }
}
