//! 后台补全（实施计划 6.3）：捕获先用不联网的即时版本创建 Item，联网的 Workflow（网页标题与摘要等）
//! 稍后在后台跑完再更新它们——拖放永远不会等网络。
//!
//! 补全是**尽力而为**且**不覆盖用户的修改**：只有 Item 的标题仍是即时创建时的样子、
//! 并且创建之后没有被动过（`updated_at` 没变）才会更新；失败只记日志与运行记录，Item 保持原样。

use stardeskbox_domain::attachment::{Attachment, AttachmentKind};
use stardeskbox_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest, FileRef};
use stardeskbox_domain::event::DomainEvent;
use stardeskbox_domain::id::ItemId;
use stardeskbox_domain::item::ContentFormat;
use stardeskbox_domain::workflow::WorkflowId;

use super::CaptureService;
use crate::error::{AppError, ErrorCode};
use crate::workflow::{RunMode, RunStatus};

/// 一件待补全的工作：哪个 Workflow、原始输入，以及即时创建出来的 Item 和它们当时的标题。
#[derive(Debug, Clone)]
pub struct EnrichmentJob {
    /// 即时运行时选中的 Workflow。
    pub workflow_id: WorkflowId,
    /// 原始捕获请求。
    pub request: CaptureRequest,
    /// 创建出来的 Item 及其即时标题（与 Workflow 产出的草稿按顺序一一对应）。
    pub items: Vec<(ItemId, String)>,
    /// 即时草稿各自对应输入里的第几个文件（与 `items` 一一对应；不是逐文件产出的为 `None`）。
    /// 完整运行的草稿必须和它逐项一致才写回，避免把 A 文件的标题写到 B 文件的 Item 上。
    pub file_indexes: Vec<Option<usize>>,
}

/// 完整运行的草稿能不能和即时创建的 Item 逐项对应：数量相同，每一项的文件序号与类型都一致。
///
/// 条件、脚本等可能让两次运行产出的草稿数量或顺序不同；对应不上时宁可不补全，也不能张冠李戴。
fn drafts_line_up(
    job: &EnrichmentJob,
    items: &[Option<stardeskbox_domain::item::Item>],
    drafts: &[crate::workflow::PlannedItem],
) -> bool {
    drafts.len() == job.items.len()
        && job.file_indexes.len() == job.items.len()
        && items.len() == job.items.len()
        && drafts
            .iter()
            .zip(&job.file_indexes)
            .zip(items)
            .all(|((draft, index), item)| {
                // 已经被删除的 Item 不参与类型比较（反正也不会写它）。
                draft.file_index == *index
                    && item
                        .as_ref()
                        .is_none_or(|item| draft.item_type == item.item_type())
            })
}

impl CaptureService {
    /// 执行一件补全工作。返回实际更新了几个 Item。
    ///
    /// 任何失败都不会向上传播：补全是锦上添花，失败时 Item 保持即时创建的样子。
    pub async fn enrich(&self, job: EnrichmentJob) -> usize {
        let Some(engine) = &self.workflows else {
            return 0;
        };
        let started = self.clock.now_utc();
        let workflow = match self.load_workflow(&job.workflow_id).await {
            Some(workflow) => workflow,
            None => return 0,
        };
        let run = engine
            .run(
                &workflow,
                &job.request.input,
                job.request.source_application.as_deref(),
                self.clock.today_local(),
                RunMode::Full,
            )
            .await;
        let (status, drafts) = match &run.result {
            Ok(drafts) if !drafts.is_empty() => (RunStatus::Succeeded, drafts.clone()),
            Ok(_) => (RunStatus::Skipped, Vec::new()),
            Err(_) => (RunStatus::Failed, Vec::new()),
        };
        let updated = if drafts.is_empty() {
            0
        } else {
            self.apply_drafts(&job, &drafts).await
        };
        self.record_run(&job.request, &run, status, started, updated)
            .await;
        updated
    }

    /// 读取一个 Workflow 的当前定义。
    async fn load_workflow(
        &self,
        id: &WorkflowId,
    ) -> Option<stardeskbox_domain::workflow::Workflow> {
        let mut tx = self.uow.begin_read().await.ok()?;
        tx.workflows()
            .get(id)
            .await
            .ok()?
            .map(|stored| stored.workflow)
    }

    /// 把联网后的草稿写回对应的 Item（只更新没被用户动过的）。
    async fn apply_drafts(
        &self,
        job: &EnrichmentJob,
        drafts: &[crate::workflow::PlannedItem],
    ) -> usize {
        let now = self.clock.now_utc();
        let mut changed: Vec<ItemId> = Vec::new();
        let outcome = async {
            let mut tx = self.uow.begin().await?;
            let mut current = Vec::with_capacity(job.items.len());
            for (item_id, _) in &job.items {
                current.push(tx.items().get(*item_id).await?);
            }
            if !drafts_line_up(job, &current, drafts) {
                tracing::warn!(
                    event = "capture_enrich_mismatch",
                    instant = job.items.len(),
                    full = drafts.len(),
                    "完整运行的产出与即时创建的条目对应不上，跳过补全"
                );
                return Ok(());
            }
            for (((item_id, initial_title), draft), item) in
                job.items.iter().zip(drafts).zip(current)
            {
                let Some(mut item) = item else {
                    continue;
                };
                // 用户已经改过（或删除 / 归档了）就不动它。
                if item.title().as_str() != initial_title
                    || item.updated_at() != item.created_at()
                    || item.is_archived()
                {
                    continue;
                }
                // 联网后的结果和即时版本一样（比如离线）就不必写。
                if item.title().as_str() == draft.title
                    && item.content() == draft.content.as_deref()
                {
                    continue;
                }
                let better = item.rename(&draft.title, now).is_ok();
                let content = item
                    .set_content(draft.content.clone(), ContentFormat::Plain, now)
                    .is_ok();
                if better || content {
                    tx.items().update(&item).await?;
                    changed.push(*item_id);
                }
            }
            tx.commit().await
        }
        .await;
        if let Err(error) = outcome {
            tracing::warn!(event = "capture_enrich_failed", %error, "后台补全写入失败");
            return 0;
        }
        for item_id in &changed {
            self.events
                .publish(DomainEvent::ItemUpdated { item_id: *item_id });
        }
        changed.len()
    }
}

/// 由已保存的来源还原当初的捕获输入；文字 / 图片等无法还原的返回 `None`。
///
/// 文件的 MIME 与大小取自捕获时记下的引用附件（同一路径），这样按 `file.mime` 匹配的规则
/// 重新运行时和当初一样能匹配上。
fn input_from_source(
    source: &stardeskbox_domain::source::Source,
    attachments: &[Attachment],
) -> Option<CaptureInput> {
    if let Some(url) = &source.source_url {
        return Some(CaptureInput::Url { url: url.clone() });
    }
    let path = source.source_path.as_ref()?;
    let file_path = std::path::Path::new(path);
    let name = file_path.file_name()?.to_string_lossy().into_owned();
    let extension = file_path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    let reference = attachments
        .iter()
        .find(|a| a.kind == AttachmentKind::Reference && a.path == *path);
    Some(CaptureInput::File {
        file: FileRef {
            path: path.clone(),
            name,
            extension,
            size_bytes: reference.and_then(|a| a.size_bytes),
            mime: reference.and_then(|a| a.mime.clone()),
            is_dir: false,
        },
    })
}

impl CaptureService {
    /// 用户主动「重新运行规则」：按这个 Item 的来源重新匹配并完整运行（可联网），
    /// 把新的标题与内容写回。返回是否有变化。
    ///
    /// 和后台补全不同，这是用户明确要求的，所以**会覆盖**当前标题和内容。
    ///
    /// # Errors
    ///
    /// 来源不支持重新运行（文字 / 图片 / 手动创建）、没有匹配的规则或规则运行失败时返回
    /// `WORKFLOW_RUN_FAILED`；Item 不存在返回 `ITEM_NOT_FOUND`。
    pub async fn rerun(&self, item_id: ItemId) -> Result<bool, AppError> {
        let failed =
            |message: &str| AppError::new(ErrorCode::WorkflowRunFailed, message.to_owned());
        let Some(engine) = &self.workflows else {
            return Err(failed("Workflow 引擎不可用"));
        };
        let (input, source_application, workflows) = {
            let mut tx = self.uow.begin_read().await?;
            if tx.items().get(item_id).await?.is_none() {
                return Err(AppError::new(ErrorCode::ItemNotFound, "条目不存在"));
            }
            let sources = tx.sources().list_for_item(item_id).await?;
            let attachments = tx.attachments().list_for_item(item_id).await?;
            // 用第一个能还原输入的来源（而不是只看第一个来源）。
            let (input, source_application) = sources
                .iter()
                .find_map(|source| {
                    input_from_source(source, &attachments)
                        .map(|input| (input, source.source_app.clone()))
                })
                .ok_or_else(|| failed("这个来源不支持重新运行"))?;
            let workflows: Vec<_> = tx
                .workflows()
                .list()
                .await?
                .into_iter()
                .map(|s| s.workflow)
                .collect();
            (input, source_application, workflows)
        };
        let started = self.clock.now_utc();
        let mut request = CaptureRequest::new(input, CaptureOrigin::Manual);
        // 当初的来源应用照样参与匹配：按来源应用写的规则重新运行时也要能匹配上。
        request.source_application = source_application;
        let run = engine
            .resolve_and_run(
                &workflows,
                &request.input,
                request.source_application.as_deref(),
                self.clock.today_local(),
                RunMode::Full,
            )
            .await
            .ok_or_else(|| failed("没有匹配的规则"))?;
        let (status, drafts) = match &run.result {
            Ok(drafts) if !drafts.is_empty() => (RunStatus::Succeeded, drafts.clone()),
            Ok(_) => (RunStatus::Skipped, Vec::new()),
            Err(_) => (RunStatus::Failed, Vec::new()),
        };
        self.record_run(&request, &run, status, started, drafts.len().min(1))
            .await;
        let Some(draft) = drafts.first() else {
            return Err(failed("规则没有产出内容"));
        };
        let now = self.clock.now_utc();
        let mut tx = self.uow.begin().await?;
        let Some(mut item) = tx.items().get(item_id).await? else {
            return Err(AppError::new(ErrorCode::ItemNotFound, "条目不存在"));
        };
        if item.title().as_str() == draft.title && item.content() == draft.content.as_deref() {
            return Ok(false);
        }
        item.rename(&draft.title, now)?;
        item.set_content(draft.content.clone(), ContentFormat::Plain, now)?;
        tx.items().update(&item).await?;
        tx.commit().await?;
        self.events.publish(DomainEvent::ItemUpdated { item_id });
        Ok(true)
    }
}
