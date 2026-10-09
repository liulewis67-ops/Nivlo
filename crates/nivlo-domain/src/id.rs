//! 领域实体 ID。
//!
//! 每种实体使用独立的 Newtype，避免把 `ProjectId` 误传给需要 `ItemId` 的地方。
//! ID 的取值为 UUIDv7（实施计划 D-04）；生成发生在 Application 层（需要时钟），
//! 本 crate 只负责包装与解析。

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 定义一个包装 [`Uuid`] 的 ID 类型，并实现常用 trait。
macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// 由已有的 UUID 构造 ID。
            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            /// 返回内部 UUID。
            pub fn as_uuid(&self) -> Uuid {
                self.0
            }
        }

        impl fmt::Display for $name {
            /// 输出标准的连字符 UUID 字符串。
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            /// 从标准 UUID 字符串解析。
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s).map(Self)
            }
        }
    };
}

define_id!(
    /// Item（Todo / Note / Tip）的 ID。
    ItemId
);
define_id!(
    /// Project 的 ID。
    ProjectId
);
define_id!(
    /// Tag 的 ID。
    TagId
);
define_id!(
    /// Source 的 ID。
    SourceId
);
define_id!(
    /// Attachment 的 ID。
    AttachmentId
);

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_string_and_json() {
        let id = ItemId::from_uuid(Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0001));
        let text = id.to_string();
        assert_eq!(text.parse::<ItemId>().unwrap(), id);

        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{text}\""));
        assert_eq!(serde_json::from_str::<ItemId>(&json).unwrap(), id);
    }

    #[test]
    fn rejects_invalid_text() {
        assert!("not-a-uuid".parse::<ProjectId>().is_err());
    }
}
