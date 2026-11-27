//! Attachment：Item 关联的文件。
//!
//! 文件默认只保存**引用**（原始路径），不复制，避免 StarAt 演变成文件管理器
//! （产品文档 §19、架构文档 §34）。只有没有原始路径的内容（如粘贴的截图）才会被复制到
//! 应用的 `attachments/` 目录。持久化在实施计划 2.2 完成。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::id::{AttachmentId, ItemId};

/// 附件的保存方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    /// 引用用户磁盘上的原始文件；删除 Item 时**绝不**删除该文件。
    Reference,
    /// 内容已复制到应用的 `attachments/` 目录，由 StarAt 负责清理。
    Stored,
}

impl AttachmentKind {
    /// 存储用的文本形式。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::Stored => "stored",
        }
    }

    /// 解析 [`AttachmentKind::as_str`] 写出的文本；不认识时返回 `None`。
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "reference" => Some(Self::Reference),
            "stored" => Some(Self::Stored),
            _ => None,
        }
    }
}

/// Item 的附件记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    /// 附件 ID。
    pub id: AttachmentId,
    /// 所属 Item。
    pub item_id: ItemId,
    /// 保存方式。
    pub kind: AttachmentKind,
    /// 文件路径：`Reference` 为用户原始路径，`Stored` 为 `attachments/` 下的相对路径。
    pub path: String,
    /// 展示用文件名。
    pub name: String,
    /// MIME 类型；无法探测时为 `None`。
    pub mime: Option<String>,
    /// 文件大小（字节）；未知时为 `None`。
    pub size_bytes: Option<u64>,
    /// 添加时间。
    pub added_at: DateTime<Utc>,
}

impl Attachment {
    /// 删除所属 Item 时，StarAt 是否应当删除磁盘上的文件。
    ///
    /// 只有 `Stored` 附件由 StarAt 拥有；`Reference` 指向用户自己的文件，必须保留。
    pub fn owns_file(&self) -> bool {
        self.kind == AttachmentKind::Stored
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;
    use uuid::Uuid;

    use super::*;

    /// 构造指定保存方式的测试附件。
    fn attachment(kind: AttachmentKind) -> Attachment {
        Attachment {
            id: AttachmentId::from_uuid(Uuid::from_u128(4)),
            item_id: ItemId::from_uuid(Uuid::from_u128(1)),
            kind,
            path: "D:\\projects\\设计 文档\\design.md".to_owned(),
            name: "design.md".to_owned(),
            mime: Some("text/markdown".to_owned()),
            size_bytes: Some(1024),
            added_at: Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap(),
        }
    }

    #[test]
    fn only_stored_attachments_own_their_file() {
        assert!(!attachment(AttachmentKind::Reference).owns_file());
        assert!(attachment(AttachmentKind::Stored).owns_file());
    }

    #[test]
    fn serde_round_trip() {
        let a = attachment(AttachmentKind::Reference);
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(serde_json::from_str::<Attachment>(&json).unwrap(), a);
    }
}
