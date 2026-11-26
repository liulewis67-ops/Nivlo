//! 数据库文本编码：时间戳、日期与时间。
//!
//! 约定（实施计划 D-03 / D-04）：
//!
//! * 审计时间戳与 `reminder_at`：UTC、固定宽度的 RFC 3339（毫秒精度，如
//!   `2026-10-09T08:00:00.000Z`），因此字符串排序即时间排序。毫秒以下的精度在落库时被舍弃，
//!   StarDeskBox 的时间戳只需要毫秒。
//! * 本地日期：`YYYY-MM-DD`；本地时间：`HH:MM:SS`（有小数秒时附带）。

use chrono::{DateTime, NaiveDate, NaiveTime, SecondsFormat, Utc};
use stardeskbox_application::ports::StorageError;

/// 日期文本格式。
const DATE_FORMAT: &str = "%Y-%m-%d";

/// 本地时间的写出格式；`%.f` 仅在存在小数秒时输出。
const TIME_FORMAT: &str = "%H:%M:%S%.f";

/// 把 UTC 时间点编码为固定宽度的 RFC 3339 文本。
pub(crate) fn format_timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 解析 [`format_timestamp`] 写出的文本。
///
/// # Errors
///
/// 文本不是合法的 RFC 3339 时间时返回 [`StorageError::Corrupt`]。
pub(crate) fn parse_timestamp(text: &str) -> Result<DateTime<Utc>, StorageError> {
    DateTime::parse_from_rfc3339(text)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|e| StorageError::Corrupt(format!("无效的时间戳 {text:?}：{e}")))
}

/// 把本地日期编码为 `YYYY-MM-DD`。
pub(crate) fn format_date(value: NaiveDate) -> String {
    value.format(DATE_FORMAT).to_string()
}

/// 解析 [`format_date`] 写出的文本。
///
/// # Errors
///
/// 文本不是合法日期时返回 [`StorageError::Corrupt`]。
pub(crate) fn parse_date(text: &str) -> Result<NaiveDate, StorageError> {
    NaiveDate::parse_from_str(text, DATE_FORMAT)
        .map_err(|e| StorageError::Corrupt(format!("无效的日期 {text:?}：{e}")))
}

/// 把本地时间编码为 `HH:MM:SS`。
pub(crate) fn format_time(value: NaiveTime) -> String {
    value.format(TIME_FORMAT).to_string()
}

/// 解析 [`format_time`] 写出的文本。
///
/// # Errors
///
/// 文本不是合法时间时返回 [`StorageError::Corrupt`]。
pub(crate) fn parse_time(text: &str) -> Result<NaiveTime, StorageError> {
    NaiveTime::parse_from_str(text, TIME_FORMAT)
        .map_err(|e| StorageError::Corrupt(format!("无效的时间 {text:?}：{e}")))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn timestamp_is_fixed_width_and_sortable() {
        let a = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let b = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 6).unwrap();
        assert_eq!(format_timestamp(a), "2026-01-02T03:04:05.000Z");
        assert!(format_timestamp(a) < format_timestamp(b));
        assert_eq!(parse_timestamp(&format_timestamp(a)).unwrap(), a);
    }

    #[test]
    fn date_and_time_round_trip() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        assert_eq!(format_date(d), "2026-10-09");
        assert_eq!(parse_date("2026-10-09").unwrap(), d);

        let t = NaiveTime::from_hms_opt(14, 30, 0).unwrap();
        assert_eq!(format_time(t), "14:30:00");
        assert_eq!(parse_time("14:30:00").unwrap(), t);
    }

    #[test]
    fn garbage_is_reported_as_corrupt() {
        assert!(matches!(
            parse_timestamp("yesterday"),
            Err(StorageError::Corrupt(_))
        ));
        assert!(matches!(
            parse_date("2026/10/09"),
            Err(StorageError::Corrupt(_))
        ));
        assert!(matches!(parse_time("25:00"), Err(StorageError::Corrupt(_))));
    }
}
