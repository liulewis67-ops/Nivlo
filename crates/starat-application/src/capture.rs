//! `CaptureService`：把一次捕获变成 Item（实施计划 2.3、产品文档 §6–7、架构文档 §16、§56）。
//!
//! 捕获先交给 Workflow Engine（实施计划 5.5）：Resolver 选出匹配的 Workflow，产出要创建的 Item。
//! 没有接入引擎、没有 Workflow 匹配、Workflow 失败或没有产出时，使用下面这组固定的默认规则——
//! 它们同时也是内置 Generic Workflow 复刻的对象，**全部进入 Inbox**（实施计划 D-02），
//! 因此**捕获永不丢失**：Workflow 失败时原始输入照常保存，并在来源上记下失败原因：
//!
//! | 输入 | 创建 | 内容 |
//! |---|---|---|
//! | 文本 | Todo | 标题取首行；多行 / 被截断的文本全文放进内容 |
//! | URL | Note | 标题是主机 + 路径，内容是完整网址 |
//! | 文件 | Note | 一个文件一条 Note，附件是**引用**（不复制） |
//! | 多个文件 | 每个文件一条 Note | 在同一个事务里一起创建 |
//! | 图片 | Note | 附件是复制到 `attachments/` 的文件（没有原始路径可引用） |
//!
//! 同时记录 Source（来自哪里）。整个过程是**一个事务**：Item、Source、Attachment 要么全部落库，
//! 要么什么都不留下；已经写到磁盘上的图片文件在失败时会被清理。成功后返回创建的 Item，
//! 调用方可以用它们的 ID 调用 [`CaptureService::undo`] 把数据库恢复到捕获之前。

use std::sync::Arc;
use std::time::Instant;

use starat_common::clock::Clock;
use starat_common::id::new_uuid_v7;
use starat_domain::attachment::{Attachment, AttachmentKind};
use starat_domain::capture::default_title;
use starat_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest, FileRef};
use starat_domain::event::DomainEvent;
use starat_domain::id::TagId;
use starat_domain::id::{AttachmentId, ItemId, SourceId};
use starat_domain::item::{DatePoint, Priority};
use starat_domain::item::{Item, ItemType, NewItem};
use starat_domain::source::{Source, SourceType};
use starat_domain::tag::{Tag, TagName};

use crate::error::AppError;
use crate::event::EventPublisher;
use crate::ports::{AttachmentFiles, UnitOfWork};
use tokio::sync::mpsc::UnboundedSender;

use crate::workflow::{
    PlannedItem, RunMode, RunRecord, RunStatus, WorkflowEngine, WorkflowRunResult, new_run_id,
    summarize_input,
};

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
    /// 要打的标签（Workflow 产出；默认规则没有）。
    tags: Vec<String>,
}

/// 来源草稿。
struct SourceDraft {
    /// 来源类型（`web` / `file` / `text` / `image`）。
    source_type: &'static str,
    /// 来源 URL。
    url: Option<String>,
    /// 来源文件路径。
    path: Option<String>,
    /// 附带的元数据（JSON）：Workflow 失败时记下原因，供「重新运行」与排查。
    metadata_json: Option<String>,
    /// 原始标题 / 来源显示名（如 `Jira · AI-128`）。
    original_title: Option<String>,
}

/// 附件草稿。
enum AttachmentDraft {
    /// 引用用户的文件。
    Reference(FileRef),
    /// 需要复制到 `attachments/` 的图片。
    Image(starat_domain::capture::ImageData),
}

/// 一个已经写到磁盘、还没提交数据库的附件，失败时要清理。
struct StoredAttachment {
    /// 相对 `attachments/` 的路径。
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
            metadata_json: None,
            original_title: None,
        },
        attachment: Some(AttachmentDraft::Reference(file.clone())),
        tags: Vec::new(),
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
                    metadata_json: None,
                    original_title: None,
                },
                attachment: None,
                tags: Vec::new(),
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
                    metadata_json: None,
                    original_title: None,
                },
                attachment: None,
                tags: Vec::new(),
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
                    metadata_json: None,
                    original_title: None,
                },
                attachment: Some(AttachmentDraft::Image(image.clone())),
                tags: Vec::new(),
            }]
        }
    }
}

/// 把 Workflow 的产出转成要创建的记录；来源与附件由输入的种类决定（与默认规则一致）。
fn from_planned(input: &CaptureInput, items: &[PlannedItem]) -> Vec<Planned> {
    items
        .iter()
        .map(|planned| {
            let mut item = NewItem::new(planned.item_type, planned.title.clone());
            item.content = planned.content.clone();
            item.in_inbox = planned.in_inbox;
            item.priority = planned.priority.unwrap_or(Priority::None);
            item.scheduled = planned.scheduled.map(DatePoint::all_day);
            let file = match input {
                CaptureInput::File { file } => Some(file),
                CaptureInput::Files { files } => files.get(planned.file_index.unwrap_or(0)),
                _ => None,
            };
            let (source, attachment) = match input {
                CaptureInput::Text { .. } => (
                    SourceDraft {
                        source_type: SourceType::TEXT,
                        url: None,
                        path: None,
                        metadata_json: None,
                        original_title: None,
                    },
                    None,
                ),
                CaptureInput::Url { url } => (
                    SourceDraft {
                        source_type: SourceType::WEB,
                        url: Some(url.clone()),
                        path: None,
                        metadata_json: None,
                        original_title: None,
                    },
                    None,
                ),
                CaptureInput::File { .. } | CaptureInput::Files { .. } => (
                    SourceDraft {
                        source_type: SourceType::FILE,
                        url: None,
                        path: file.map(|f| f.path.clone()),
                        metadata_json: None,
                        original_title: None,
                    },
                    file.filter(|_| planned.attach)
                        .map(|f| AttachmentDraft::Reference(f.clone())),
                ),
                CaptureInput::Image { image } => (
                    SourceDraft {
                        source_type: SourceType::IMAGE,
                        url: None,
                        path: None,
                        metadata_json: None,
                        original_title: None,
                    },
                    planned
                        .attach
                        .then(|| AttachmentDraft::Image(image.clone())),
                ),
            };
            let mut source = source;
            source.original_title.clone_from(&planned.source_label);
            if !planned.metadata.is_empty() {
                source.metadata_json = serde_json::to_string(&planned.metadata).ok();
            }
            Planned {
                item,
                source,
                attachment,
                tags: planned.tags.clone(),
            }
        })
        .collect()
}

/// Workflow 失败时写在来源上的元数据。
fn failure_metadata(run: &WorkflowRunResult) -> Option<String> {
    let failure = run.result.as_ref().err()?;
    Some(
        serde_json::json!({
            "workflowError": {
                "workflowId": run.workflow_id.as_str(),
                "workflowName": run.workflow_name,
                "kind": failure.kind.as_str(),
                "message": failure.message,
                "failedStep": failure.failed_step,
            }
        })
        .to_string(),
    )
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
    /// 由 StarAt 拥有的附件文件（粘贴的图片）。
    files: Arc<dyn AttachmentFiles>,
    /// Workflow 引擎；`None` 时只用默认规则。
    workflows: Option<Arc<dyn WorkflowEngine>>,
    /// 后台补全队列；`None` 时联网的 Workflow 只做即时版本。
    enrichment: Option<UnboundedSender<EnrichmentJob>>,
}

/// `plan_for` 的结果。
struct Planning {
    /// 要创建的记录。
    plans: Vec<Planned>,
    /// Workflow 的这次运行（用于提交之后记录）。
    run: Option<(WorkflowRunResult, RunStatus)>,
    /// 选中的 Workflow 带 `http` Step 时，要在后台补全的 Workflow。
    enrich_with: Option<starat_domain::workflow::WorkflowId>,
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
            workflows: None,
            enrichment: None,
        }
    }

    /// 接入 Workflow 引擎：之后的捕获先交给匹配的 Workflow（实施计划 5.5）。
    #[must_use]
    pub fn with_workflows(mut self, engine: Arc<dyn WorkflowEngine>) -> Self {
        self.workflows = Some(engine);
        self
    }

    /// 接入后台补全队列：联网的 Workflow 先即时创建，之后由队列的消费者调用 [`Self::enrich`]。
    #[must_use]
    pub fn with_enrichment(mut self, queue: UnboundedSender<EnrichmentJob>) -> Self {
        self.enrichment = Some(queue);
        self
    }

    /// 规划这次捕获要创建什么：优先走 Workflow，任何一步不行都退回默认规则（捕获永不丢失）。
    ///
    /// 返回要创建的记录，以及（如果有 Workflow 参与）这次运行，用于提交成功之后记录。
    async fn plan_for(&self, request: &CaptureRequest) -> Planning {
        let fallback = |plans: Vec<Planned>| Planning {
            plans,
            run: None,
            enrich_with: None,
        };
        let Some(engine) = &self.workflows else {
            return fallback(plan(&request.input));
        };
        let workflows = match self.uow.begin_read().await {
            Ok(mut tx) => match tx.workflows().list().await {
                Ok(stored) => stored.into_iter().map(|s| s.workflow).collect::<Vec<_>>(),
                Err(error) => {
                    tracing::warn!(event = "workflow_load_failed", %error, "读取 Workflow 失败，使用默认规则");
                    return fallback(plan(&request.input));
                }
            },
            Err(error) => {
                tracing::warn!(event = "workflow_load_failed", %error, "读取 Workflow 失败，使用默认规则");
                return fallback(plan(&request.input));
            }
        };
        let today = self.clock.today_local();
        let Some(run) = engine
            .resolve_and_run(
                &workflows,
                &request.input,
                request.source_application.as_deref(),
                today,
                RunMode::Instant,
            )
            .await
        else {
            return fallback(plan(&request.input));
        };
        let networked = workflows
            .iter()
            .find(|w| w.id == run.workflow_id)
            .is_some_and(starat_domain::workflow::Workflow::uses_network);
        match &run.result {
            Ok(items) if !items.is_empty() => {
                let plans = from_planned(&request.input, items);
                Planning {
                    plans,
                    enrich_with: networked.then(|| run.workflow_id.clone()),
                    run: Some((run, RunStatus::Succeeded)),
                }
            }
            // 没有产出（比如条件不满足而提前停止）：走默认规则，不让这次捕获凭空消失。
            Ok(_) => Planning {
                plans: plan(&request.input),
                run: Some((run, RunStatus::Skipped)),
                enrich_with: None,
            },
            Err(_) => {
                let metadata = failure_metadata(&run);
                let mut plans = plan(&request.input);
                for planned in &mut plans {
                    planned.source.metadata_json.clone_from(&metadata);
                }
                Planning {
                    plans,
                    run: Some((run, RunStatus::Failed)),
                    enrich_with: None,
                }
            }
        }
    }

    /// 记录一次 Workflow 运行（尽力而为：记录失败不影响已经成功的捕获）。
    async fn record_run(
        &self,
        request: &CaptureRequest,
        run: &WorkflowRunResult,
        status: RunStatus,
        started_at: chrono::DateTime<chrono::Utc>,
        items_created: usize,
    ) {
        let failure = run.result.as_ref().err();
        let record = RunRecord {
            id: new_run_id(self.clock.as_ref()),
            workflow_id: run.workflow_id.to_string(),
            workflow_name: run.workflow_name.clone(),
            input_kind: kind_name(&request.input).to_owned(),
            input_summary: summarize_input(&request.input),
            status,
            // 动作附在失败分类后面（`user_action_required#OPEN_INTEGRATION_SETTINGS:jira`），
            // 这样不需要为运行记录增加列；界面按 `#` 拆开。
            error_kind: failure
                .map(|f| match &f.action {
                    Some(action) => format!("{}#{}", f.kind.as_str(), action.code()),
                    None => f.kind.as_str().to_owned(),
                })
                // 成功但降级（如 Jira 凭据失效，已改用页面信息）：同样记下提示与动作，Run Inspector 会显示。
                .or_else(|| {
                    run.notice.as_ref().map(|n| match &n.action {
                        Some(action) => format!("degraded#{}", action.code()),
                        None => "degraded".to_owned(),
                    })
                }),
            error_message: failure
                .map(|f| f.message.clone())
                .or_else(|| run.notice.as_ref().map(|n| n.message.clone())),
            items_created: u32::try_from(items_created).unwrap_or(u32::MAX),
            duration_ms: run.duration_ms,
            started_at,
            steps: run.steps.clone(),
        };
        let outcome = async {
            let mut tx = self.uow.begin().await?;
            tx.workflows().insert_run(&record).await?;
            tx.commit().await
        }
        .await;
        if let Err(error) = outcome {
            tracing::warn!(event = "workflow_run_record_failed", %error, "写入 Workflow 运行记录失败");
        }
    }

    /// 捕获一次输入，创建 Item + Source + Attachment。
    ///
    /// 事务性：任何一步失败都不会在数据库里留下记录，已经写到磁盘的图片文件也会被清理。
    /// 提交成功后才发布 [`DomainEvent::ItemCreated`]。来路（`origin`）只写入日志，
    /// 不影响创建什么。
    ///
    /// # Errors
    ///
    /// * 领域规则错误（如标题不合法）映射为对应错误码。
    /// * 存储 / 文件错误（`STORAGE_UNAVAILABLE` 等），此时没有留下任何数据。
    pub async fn capture(&self, request: CaptureRequest) -> Result<CaptureResult, AppError> {
        let started = Instant::now();
        let now = self.clock.now_utc();
        let Planning {
            plans,
            run: workflow_run,
            enrich_with,
        } = self.plan_for(&request).await;
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

        if let Some((run, status)) = &workflow_run {
            self.record_run(&request, run, *status, now, items.len())
                .await;
        }
        for item in &items {
            self.events
                .publish(DomainEvent::ItemCreated { item_id: item.id() });
        }
        if let (Some(workflow_id), Some(queue)) = (enrich_with, &self.enrichment) {
            let job = EnrichmentJob {
                workflow_id,
                request: request.clone(),
                items: items
                    .iter()
                    .map(|item| (item.id(), item.title().as_str().to_owned()))
                    .collect(),
                // 只有 Workflow 成功产出时才会补全，此时 Item 与草稿按顺序一一对应。
                file_indexes: workflow_run
                    .as_ref()
                    .and_then(|(run, _)| run.result.as_ref().ok())
                    .map(|drafts| drafts.iter().map(|d| d.file_index).collect())
                    .unwrap_or_default(),
            };
            // 队列关闭（应用正在退出）时丢弃：补全只是锦上添花。
            let _ = queue.send(job);
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

    /// 在单个事务里写入全部记录；图片文件在事务开始之前写好并记录到 `stored`。
    async fn write_all(
        &self,
        request: &CaptureRequest,
        plans: Vec<Planned>,
        now: chrono::DateTime<chrono::Utc>,
        stored: &mut Vec<StoredAttachment>,
    ) -> Result<Vec<Item>, AppError> {
        // 先把要写的记录全部构造并校验好（纯内存），再写磁盘，最后一次性落库。
        let mut records: Vec<(Item, Source, Option<Attachment>, Vec<String>)> =
            Vec::with_capacity(plans.len());
        for planned in plans {
            let item_id = ItemId::from_uuid(new_uuid_v7(self.clock.as_ref()));
            let (item, _) = Item::create(item_id, planned.item, now)?;
            let source = Source {
                id: SourceId::from_uuid(new_uuid_v7(self.clock.as_ref())),
                item_id,
                source_type: SourceType::new(
                    if planned.source.source_type == SourceType::TEXT
                        && request.origin == CaptureOrigin::Paste
                    {
                        SourceType::CLIPBOARD
                    } else {
                        planned.source.source_type
                    },
                ),
                source_app: request.source_application.clone(),
                source_url: planned.source.url,
                source_path: planned.source.path,
                original_title: planned.source.original_title,
                metadata_json: planned.source.metadata_json,
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
            records.push((item, source, attachment, planned.tags));
        }

        let mut tx = self.uow.begin().await?;
        for (item, source, attachment, tags) in &records {
            tx.items().insert(item).await?;
            tx.sources().insert(source).await?;
            if let Some(attachment) = attachment {
                tx.attachments().insert(attachment).await?;
            }
            // Workflow 产出的标签：不存在的创建，名称不合法的（空、控制字符）跳过而不是让整次捕获失败。
            let mut tag_ids: Vec<TagId> = Vec::new();
            for raw in tags {
                let Ok(name) = TagName::new(raw) else {
                    tracing::warn!(event = "workflow_tag_skipped", "跳过不合法的标签名");
                    continue;
                };
                let tag = match tx.tags().find_by_name(&name).await? {
                    Some(existing) => existing,
                    None => {
                        let tag = Tag {
                            id: TagId::from_uuid(new_uuid_v7(self.clock.as_ref())),
                            name,
                        };
                        tx.tags().insert(&tag).await?;
                        tag
                    }
                };
                if !tag_ids.contains(&tag.id) {
                    tag_ids.push(tag.id);
                }
            }
            if !tag_ids.is_empty() {
                tx.tags().set_for_item(item.id(), &tag_ids).await?;
            }
        }
        tx.commit().await?;
        Ok(records.into_iter().map(|(item, _, _, _)| item).collect())
    }

    /// 撤销一次捕获：永久删除这些 Item 及其来源、附件记录，并清理 StarAt 自己保存的图片文件。
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

mod enrich;
pub use enrich::EnrichmentJob;

#[cfg(test)]
mod tests;
