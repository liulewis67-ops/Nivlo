//! `CaptureService`：把一次捕获变成 Item（实施计划 2.3、产品文档 §6–7、架构文档 §16、§56）。
//!
//! 在 Workflow Engine 出现之前（Phase 5 会把这里的规则改写为内置的 Generic Workflow），
//! 这里是一组固定的默认规则，**全部进入 Inbox**（实施计划 D-02）：
//!
//! | 输入 | 创建 | 内容 |
//! |---|---|---|
//! | 文本 | Todo | 标题取首行；多行 / 被截断的文本全文放进内容 |
//! | URL | Note | 标题是主机 + 路径，内容是完整网址 |
//! | 文件 | Note | 一个文件一条 Note，附件是**引用**（不复制） |
//! | 多个文件 | 每个文件一条 Note | 在同一个事务里一起创建 |
//! | 图片 | Note | 附件是复制到 \`attachments/\` 的文件（没有原始路径可引用） |
//!
//! 同时记录 Source（来自哪里）。整个过程是**一个事务**：Item、Source、Attachment 要么全部落库，
//! 要么什么都不留下；已经写到磁盘上的图片文件在失败时会被清理。成功后返回创建的 Item，
//! 调用方可以用它们的 ID 调用 [\`CaptureService::undo\`] 把数据库恢复到捕获之前。

use std::sync::Arc;
use std::time::Instant;

use nivlo_common::clock::Clock;
use nivlo_common::id::new_uuid_v7;
use nivlo_domain::attachment::{Attachment, AttachmentKind};
use nivlo_domain::capture::default_title;
use nivlo_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest, FileRef};
use nivlo_domain::event::DomainEvent;
use nivlo_domain::id::{AttachmentId, ItemId, SourceId};
use nivlo_domain::item::{Item, ItemType, NewItem};
use nivlo_domain::source::{Source, SourceType};

use crate::error::AppError;
use crate::event::EventPublisher;
use crate::ports::{AttachmentFiles, UnitOfWork};

/// 一次捕获创建出的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureResult {
    /// 创建的 Item，按输入顺序排列（多个文件时每个文件一条）。
    pub items: Vec<Item>,
}

impl CaptureResult {
    /// 撤销这次捕获所需的句柄：创建出的全部 Item 的 ID。
    #[must_use]
    pub fn undo_ids(&self) -> Vec<ItemId> {
        self.items.iter().map(Item::id).collect()
    }
}

/// 计划创建的一条记录（还没有落库）。
struct Planned {
    /// 要创建的 Item。
    item: NewItem,
    /// 来源的类型与细节。
    source: SourceDraft,
    /// 要关联的附件。
    attachment: Option<AttachmentDraft>,
}

/// 来源草稿。
struct SourceDraft {
    /// 来源类型（\`web\` / \`file\` / \`text\` / \`image\`）。
    source_type: &'static str,
    /// 来源 URL。
    url: Option<String>,
    /// 来源文件路径。
    path: Option<String>,
}

/// 附件草稿。
enum AttachmentDraft {
    /// 引用用户的文件。
    Reference(FileRef),
    /// 需要复制到 \`attachments/\` 的图片。
    Image(nivlo_domain::capture::ImageData),
}

/// 一个已经写到磁盘、还没提交数据库的附件，失败时要清理。
struct StoredAttachment {
    /// 相对 \`attachments/\` 的路径。
    relative_path: String,
}

/// 把一个文件引用规划成一条 Note。
fn plan_file(file: &FileRef) -> Planned {
    let input = CaptureInput::File { file: file.clone() };
    let mut item = NewItem::new(ItemType::Note, default_title(&input));
    item.in_inbox = true;
    Planned {
        item,
        source: SourceDraft {
            source_type: SourceType::FILE,
            url: None,
            path: Some(file.path.clone()),
        },
        attachment: Some(AttachmentDraft::Reference(file.clone())),
    }
}

/// 默认规则：输入 → 要创建的记录。
fn plan(input: &CaptureInput) -> Vec<Planned> {
    match input {
        CaptureInput::Text { text } => {
            let title = default_title(input);
            let mut item = NewItem::new(ItemType::Todo, title.clone());
            // 标题已经能完整表达（单行、没被截断）时不重复放进内容。
            if *text != title {
                item.content = Some(text.clone());
            }
            item.in_inbox = true;
            vec![Planned {
                item,
                source: SourceDraft {
                    source_type: SourceType::TEXT,
                    url: None,
                    path: None,
                },
                attachment: None,
            }]
        }
        CaptureInput::Url { url } => {
            let mut item = NewItem::new(ItemType::Note, default_title(input));
            item.content = Some(url.clone());
            item.in_inbox = true;
            vec![Planned {
                item,
                source: SourceDraft {
                    source_type: SourceType::WEB,
                    url: Some(url.clone()),
                    path: None,
                },
                attachment: None,
            }]
        }
        CaptureInput::File { file } => vec![plan_file(file)],
        CaptureInput::Files { files } => files.iter().map(plan_file).collect(),
        CaptureInput::Image { image } => {
            let mut item = NewItem::new(ItemType::Note, default_title(input));
            item.in_inbox = true;
            vec![Planned {
                item,
                source: SourceDraft {
                    source_type: SourceType::IMAGE,
                    url: None,
                    path: None,
                },
                attachment: Some(AttachmentDraft::Image(image.clone())),
            }]
        }
    }
}

/// 输入种类的日志名。
fn kind_name(input: &CaptureInput) -> &'static str {
    match input {
        CaptureInput::Text { .. } => "text",
        CaptureInput::Url { .. } => "url",
        CaptureInput::File { .. } => "file",
        CaptureInput::Files { .. } => "files",
        CaptureInput::Image { .. } => "image",
    }
}

/// 来路的日志名。
fn origin_name(origin: CaptureOrigin) -> &'static str {
    match origin {
        CaptureOrigin::Manual => "manual",
        CaptureOrigin::Drop => "drop",
        CaptureOrigin::Paste => "paste",
        CaptureOrigin::QuickAdd => "quick_add",
        CaptureOrigin::Shortcut => "shortcut",
    }
}

/// 捕获的 Use Case。
#[derive(Clone)]
pub struct CaptureService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：提供"现在"并用于生成 UUIDv7。
    clock: Arc<dyn Clock>,
    /// 提交成功后发布领域事件。
    events: Arc<dyn EventPublisher>,
    /// 由 Nivlo 拥有的附件文件（粘贴的图片）。
    files: Arc<dyn AttachmentFiles>,
}

impl CaptureService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventPublisher>,
        files: Arc<dyn AttachmentFiles>,
    ) -> Self {
        Self {
            uow,
            clock,
            events,
            files,
        }
    }

    /// 捕获一次输入，创建 Item + Source + Attachment。
    ///
    /// 事务性：任何一步失败都不会在数据库里留下记录，已经写到磁盘的图片文件也会被清理。
    /// 提交成功后才发布 [\`DomainEvent::ItemCreated\`]。来路（\`origin\`）只写入日志，
    /// 不影响创建什么。
    ///
    /// # Errors
    ///
    /// * 领域规则错误（如标题不合法）映射为对应错误码。
    /// * 存储 / 文件错误（\`STORAGE_UNAVAILABLE\` 等），此时没有留下任何数据。
    pub async fn capture(&self, request: CaptureRequest) -> Result<CaptureResult, AppError> {
        let started = Instant::now();
        let now = self.clock.now_utc();
        let plans = plan(&request.input);
        let mut stored: Vec<StoredAttachment> = Vec::new();

        let outcome = self.write_all(&request, plans, now, &mut stored).await;
        let items = match outcome {
            Ok(items) => items,
            Err(error) => {
                // 数据库里什么都没留下，磁盘上也不能留下孤儿文件。
                for file in &stored {
                    self.files.remove(&file.relative_path).await;
                }
                return Err(error);
            }
        };

        for item in &items {
            self.events
                .publish(DomainEvent::ItemCreated { item_id: item.id() });
        }
        tracing::info!(
            event = "capture_completed",
            kind = kind_name(&request.input),
            origin = origin_name(request.origin),
            items = items.len(),
            duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            "捕获完成"
        );
        Ok(CaptureResult { items })
    }

    /// 在单个事务里写入全部记录；图片文件在事务开始之前写好并记录到 \`stored\`。
    async fn write_all(
        &self,
        request: &CaptureRequest,
        plans: Vec<Planned>,
        now: chrono::DateTime<chrono::Utc>,
        stored: &mut Vec<StoredAttachment>,
    ) -> Result<Vec<Item>, AppError> {
        // 先把要写的记录全部构造并校验好（纯内存），再写磁盘，最后一次性落库。
        let mut records: Vec<(Item, Source, Option<Attachment>)> = Vec::with_capacity(plans.len());
        for planned in plans {
            let item_id = ItemId::from_uuid(new_uuid_v7(self.clock.as_ref()));
            let (item, _) = Item::create(item_id, planned.item, now)?;
            let source = Source {
                id: SourceId::from_uuid(new_uuid_v7(self.clock.as_ref())),
                item_id,
                source_type: SourceType::new(planned.source.source_type),
                source_app: request.source_application.clone(),
                source_url: planned.source.url,
                source_path: planned.source.path,
                original_title: None,
                metadata_json: None,
                captured_at: now,
            };
            let attachment = match planned.attachment {
                None => None,
                Some(AttachmentDraft::Reference(file)) => Some(Attachment {
                    id: AttachmentId::from_uuid(new_uuid_v7(self.clock.as_ref())),
                    item_id,
                    kind: AttachmentKind::Reference,
                    path: file.path,
                    name: file.name,
                    mime: file.mime,
                    size_bytes: file.size_bytes,
                    added_at: now,
                }),
                Some(AttachmentDraft::Image(image)) => {
                    let id = AttachmentId::from_uuid(new_uuid_v7(self.clock.as_ref()));
                    let file = self.files.store_image(id, &image).await?;
                    stored.push(StoredAttachment {
                        relative_path: file.relative_path.clone(),
                    });
                    Some(Attachment {
                        id,
                        item_id,
                        kind: AttachmentKind::Stored,
                        path: file.relative_path,
                        name: format!("图片.{}", image.format.extension()),
                        mime: Some(image.format.mime().to_owned()),
                        size_bytes: Some(file.size_bytes),
                        added_at: now,
                    })
                }
            };
            records.push((item, source, attachment));
        }

        let mut tx = self.uow.begin().await?;
        for (item, source, attachment) in &records {
            tx.items().insert(item).await?;
            tx.sources().insert(source).await?;
            if let Some(attachment) = attachment {
                tx.attachments().insert(attachment).await?;
            }
        }
        tx.commit().await?;
        Ok(records.into_iter().map(|(item, _, _)| item).collect())
    }

    /// 撤销一次捕获：永久删除这些 Item 及其来源、附件记录，并清理 Nivlo 自己保存的图片文件。
    ///
    /// 被引用的用户文件**绝不**被删除。已经不存在的 ID 被忽略（重复撤销是安全的）。
    /// 删除在单个事务里完成；磁盘清理在提交之后尽力而为。
    ///
    /// # Errors
    ///
    /// 存储错误，此时没有删除任何东西。
    pub async fn undo(&self, item_ids: &[ItemId]) -> Result<(), AppError> {
        let mut tx = self.uow.begin().await?;
        let mut owned_files: Vec<String> = Vec::new();
        let mut deleted: Vec<ItemId> = Vec::new();
        for id in item_ids {
            if tx.items().get(*id).await?.is_none() {
                continue;
            }
            for attachment in tx.attachments().list_for_item(*id).await? {
                if attachment.owns_file() {
                    owned_files.push(attachment.path);
                }
            }
            tx.items().delete(*id).await?;
            deleted.push(*id);
        }
        tx.commit().await?;

        for path in &owned_files {
            self.files.remove(path).await;
        }
        for item_id in deleted {
            self.events.publish(DomainEvent::ItemDeleted { item_id });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
