//! 标题与日期时间值对象。

use std::fmt;

use chrono::{NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// 标题允许的最大字符数（按 Unicode 标量值计）。
///
/// 默认标题可能来自网页或文件名，数百字符已足够；超长文本应放进 `content`。
pub const MAX_TITLE_CHARS: usize = 500;

/// 已校验的 Item 标题：去除首尾空白、非空、不超过 [`MAX_TITLE_CHARS`]。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Title(String);

impl Title {
    /// 校验并创建标题，同时去除首尾空白。
    ///
    /// # Errors
    ///
    /// * [`DomainError::EmptyTitle`] - 去除空白后为空。
    /// * [`DomainError::TitleTooLong`] - 超过 [`MAX_TITLE_CHARS`]。
    pub fn new(raw: &str) -> Result<Self, DomainError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(DomainError::EmptyTitle);
        }
        if trimmed.chars().count() > MAX_TITLE_CHARS {
            return Err(DomainError::TitleTooLong {
                max: MAX_TITLE_CHARS,
            });
        }
        Ok(Self(trimmed.to_owned()))
    }

    /// 返回标题文本。
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Title {
    /// 输出标题文本。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for Title {
    type Error = DomainError;

    /// 反序列化入口，保证外部数据也经过校验。
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::new(&value)
    }
}

impl From<Title> for String {
    /// 序列化出口。
    fn from(value: Title) -> Self {
        value.0
    }
}

/// 用户本地日历语义下的日期，可选带一天内的时间（实施计划 D-03）。
///
/// 不带时区：它表示"用户所在地的某天 / 某时刻"，用户换时区后日期不漂移。
/// "时间必须有日期"由类型结构保证——无法构造只有时间的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DatePoint {
    /// 本地日期。
    date: NaiveDate,
    /// 本地时间；`None` 表示全天。
    time: Option<NaiveTime>,
}

impl DatePoint {
    /// 创建一个全天的日期。
    pub fn all_day(date: NaiveDate) -> Self {
        Self { date, time: None }
    }

    /// 创建一个带具体时间的日期。
    pub fn at(date: NaiveDate, time: NaiveTime) -> Self {
        Self {
            date,
            time: Some(time),
        }
    }

    /// 由持久化中分开存放的日期与时间重建；时间存在而日期缺失视为数据不一致。
    ///
    /// # Errors
    ///
    /// 只有时间没有日期时返回 [`DomainError::InvalidSnapshot`]。
    pub fn from_parts(
        date: Option<NaiveDate>,
        time: Option<NaiveTime>,
        field: &'static str,
    ) -> Result<Option<Self>, DomainError> {
        match (date, time) {
            (Some(date), time) => Ok(Some(Self { date, time })),
            (None, None) => Ok(None),
            (None, Some(_)) => Err(DomainError::InvalidSnapshot(format!(
                "{field} 有时间但没有日期"
            ))),
        }
    }

    /// 本地日期。
    pub fn date(&self) -> NaiveDate {
        self.date
    }

    /// 本地时间；全天事项为 `None`。
    pub fn time(&self) -> Option<NaiveTime> {
        self.time
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn title_is_trimmed() {
        assert_eq!(
            Title::new("  修复登录超时 \n").unwrap().as_str(),
            "修复登录超时"
        );
    }

    #[test]
    fn blank_title_is_rejected() {
        assert_eq!(Title::new(""), Err(DomainError::EmptyTitle));
        assert_eq!(Title::new(" \t\n"), Err(DomainError::EmptyTitle));
    }

    #[test]
    fn title_length_counts_characters_not_bytes() {
        let ok = "拾".repeat(MAX_TITLE_CHARS);
        assert!(Title::new(&ok).is_ok());
        let too_long = "拾".repeat(MAX_TITLE_CHARS + 1);
        assert_eq!(
            Title::new(&too_long),
            Err(DomainError::TitleTooLong {
                max: MAX_TITLE_CHARS
            })
        );
    }

    #[test]
    fn title_deserialization_validates() {
        assert!(serde_json::from_str::<Title>("\"  \"").is_err());
        assert_eq!(
            serde_json::from_str::<Title>("\" a \"").unwrap().as_str(),
            "a"
        );
        assert_eq!(
            serde_json::to_string(&Title::new("a").unwrap()).unwrap(),
            "\"a\""
        );
    }

    #[test]
    fn date_point_from_parts_rejects_time_without_date() {
        let t = NaiveTime::from_hms_opt(9, 30, 0).unwrap();
        assert!(DatePoint::from_parts(None, Some(t), "scheduled").is_err());
        assert_eq!(
            DatePoint::from_parts(None, None, "scheduled").unwrap(),
            None
        );
        let d = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        assert_eq!(
            DatePoint::from_parts(Some(d), Some(t), "scheduled").unwrap(),
            Some(DatePoint::at(d, t))
        );
        assert_eq!(
            DatePoint::from_parts(Some(d), None, "scheduled").unwrap(),
            Some(DatePoint::all_day(d))
        );
    }

    #[test]
    fn date_point_orders_by_date_then_time() {
        let d1 = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let d2 = NaiveDate::from_ymd_opt(2026, 10, 10).unwrap();
        let morning = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        assert!(DatePoint::all_day(d1) < DatePoint::at(d1, morning));
        assert!(DatePoint::at(d1, morning) < DatePoint::all_day(d2));
    }
}
