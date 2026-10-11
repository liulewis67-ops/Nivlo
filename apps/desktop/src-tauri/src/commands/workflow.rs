//! Workflow 管理相关的 Command（实施计划 5.7）。
//!
//! 定义本体以 JSON 文本（`definitionJson`）往返：表单编辑器在前端组装，后端用与导入相同的
//! 深度校验（JSON Schema + 正则 + 模板变量）把关，前后端不需要各维护一份 Step 的类型镜像。

use nivlo_application::error::{AppError, ErrorCode};
use nivlo_application::workflow::{
    PlannedItem, RunRecord, StepReport, StoredWorkflow, WorkflowRunResult,
};
use nivlo_domain::capture::CaptureInput;
use nivlo_domain::workflow::{Workflow, WorkflowId, WorkflowSource};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::app::AppState;
use crate::dto::{IpcError, ItemTypeDto, PriorityDto, format_utc};
use crate::script_grants::SettingsScriptGrants;

/// 一个 Workflow（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDto {
    /// ID（slug）。
    pub id: String,
    /// 名称。
    pub name: String,
    /// 说明。
    pub description: String,
    /// 来源：`builtin` / `user` / `imported` / `marketplace`。
    pub source: String,
    /// 是否启用。
    pub enabled: bool,
    /// 优先级。
    pub priority: i32,
    /// 定义版本。
    pub version: u32,
    /// 内置的只读，只能复制。
    pub read_only: bool,
    /// 完整定义（JSON 文本）。
    pub definition_json: String,
    /// 最近修改时间（RFC 3339，UTC）。
    pub updated_at: String,
    /// 脚本权限状态：`none`（没有脚本）/ `confirmed`（已确认）/ `needsConfirmation`（需要确认才会运行）。
    pub script_status: String,
    /// 脚本声明要访问的主机（去重、排序）。
    pub script_hosts: Vec<String>,
}

/// 存储的 Workflow → DTO。
fn to_dto(stored: &StoredWorkflow, script_status: &str) -> Result<WorkflowDto, AppError> {
    let workflow: &Workflow = &stored.workflow;
    let definition_json = serde_json::to_string_pretty(workflow).map_err(|e| {
        AppError::new(
            ErrorCode::DataInconsistent,
            format!("无法序列化 Workflow：{e}"),
        )
    })?;
    Ok(WorkflowDto {
        id: workflow.id.to_string(),
        name: workflow.name.clone(),
        description: workflow.description.clone(),
        source: source_name(workflow.source).to_owned(),
        enabled: workflow.enabled,
        priority: workflow.priority,
        version: workflow.version,
        read_only: workflow.source == WorkflowSource::Builtin,
        definition_json,
        updated_at: format_utc(stored.updated_at),
        script_status: script_status.to_owned(),
        script_hosts: script_hosts(workflow),
    })
}

/// 脚本声明的主机（去重、排序）。
fn script_hosts(workflow: &Workflow) -> Vec<String> {
    let mut hosts: Vec<String> = workflow
        .steps
        .iter()
        .filter_map(|step| match step {
            nivlo_domain::workflow::Step::Script { hosts, .. } => Some(hosts.clone()),
            _ => None,
        })
        .flatten()
        .map(|host| host.to_ascii_lowercase())
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// 脚本权限状态：没有脚本、已确认、需要确认。
async fn script_status(state: &AppState, workflow: &Workflow) -> &'static str {
    let grants = SettingsScriptGrants::new(state.services.settings.clone());
    if crate::script_grants::workflow_fingerprints(workflow).is_empty() {
        "none"
    } else if grants.is_workflow_granted(workflow).await {
        "confirmed"
    } else {
        "needsConfirmation"
    }
}

/// 存储的 Workflow → DTO（含脚本权限状态）。
async fn dto_of(state: &AppState, stored: &StoredWorkflow) -> Result<WorkflowDto, AppError> {
    let status = script_status(state, &stored.workflow).await;
    to_dto(stored, status)
}

/// 来源的稳定文本。
fn source_name(source: WorkflowSource) -> &'static str {
    match source {
        WorkflowSource::Builtin => "builtin",
        WorkflowSource::User => "user",
        WorkflowSource::Imported => "imported",
        WorkflowSource::Marketplace => "marketplace",
    }
}

/// 解析 Workflow ID。
fn parse_id(text: &str) -> Result<WorkflowId, AppError> {
    WorkflowId::new(text).map_err(|e| AppError::new(ErrorCode::InvalidInput, e.to_string()))
}

/// 试运行的样例输入。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DryRunInputDto {
    /// `text`（文字或网址，自动识别）或 `file`（一个文件路径）。
    pub kind: String,
    /// 样例内容。
    pub value: String,
}

/// 试运行产出的一条 Item（预览）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedItemDto {
    /// 类型。
    pub item_type: ItemTypeDto,
    /// 标题。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 是否进 Inbox。
    pub in_inbox: bool,
    /// 标签。
    pub tags: Vec<String>,
    /// 优先级。
    pub priority: Option<PriorityDto>,
    /// 计划日期（`YYYY-MM-DD`）。
    pub scheduled: Option<String>,
}

impl From<&PlannedItem> for PlannedItemDto {
    /// Application → DTO。
    fn from(value: &PlannedItem) -> Self {
        Self {
            item_type: value.item_type.into(),
            title: value.title.clone(),
            content: value.content.clone(),
            in_inbox: value.in_inbox,
            tags: value.tags.clone(),
            priority: value.priority.map(PriorityDto::from),
            scheduled: value.scheduled.map(|d| d.format("%Y-%m-%d").to_string()),
        }
    }
}

/// 一个 Step 的记录（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepReportDto {
    /// 第几个 Step（从 0 开始）。
    pub index: u32,
    /// 种类。
    pub kind: String,
    /// `ok` / `skipped` / `failed`。
    pub outcome: String,
    /// 耗时（毫秒）。
    pub duration_ms: u32,
    /// 失败原因。
    pub message: Option<String>,
    /// 脚本的 `console` 输出（只在试运行里有）。
    pub logs: Vec<String>,
}

impl From<&StepReport> for StepReportDto {
    /// Application → DTO。
    fn from(value: &StepReport) -> Self {
        Self {
            index: value.index,
            kind: value.kind.clone(),
            outcome: value.outcome.as_str().to_owned(),
            duration_ms: u32::try_from(value.duration_ms).unwrap_or(u32::MAX),
            message: value.message.clone(),
            logs: value.logs.clone(),
        }
    }
}

/// 试运行的结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DryRunResultDto {
    /// 会创建的 Item；失败时为空。
    pub items: Vec<PlannedItemDto>,
    /// 每个 Step 的记录。
    pub steps: Vec<StepReportDto>,
    /// 失败说明；成功为 `None`。
    pub error: Option<String>,
    /// 总耗时（毫秒）。
    pub duration_ms: u32,
}

impl From<&WorkflowRunResult> for DryRunResultDto {
    /// Application → DTO。
    fn from(value: &WorkflowRunResult) -> Self {
        let (items, error) = match &value.result {
            Ok(items) => (items.iter().map(PlannedItemDto::from).collect(), None),
            Err(failure) => (Vec::new(), Some(failure.message.clone())),
        };
        Self {
            items,
            steps: value.steps.iter().map(StepReportDto::from).collect(),
            error,
            duration_ms: u32::try_from(value.duration_ms).unwrap_or(u32::MAX),
        }
    }
}

/// 一条运行记录（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDto {
    /// 记录 ID。
    pub id: String,
    /// Workflow ID。
    pub workflow_id: String,
    /// 当时的 Workflow 名称。
    pub workflow_name: String,
    /// 输入种类。
    pub input_kind: String,
    /// 输入的脱敏摘要。
    pub input_summary: String,
    /// `succeeded` / `failed` / `skipped`。
    pub status: String,
    /// 失败说明。
    pub error_message: Option<String>,
    /// 创建的 Item 数。
    pub items_created: u32,
    /// 总耗时（毫秒）。
    pub duration_ms: u32,
    /// 开始时间（RFC 3339，UTC）。
    pub started_at: String,
    /// 每个 Step 的记录。
    pub steps: Vec<StepReportDto>,
}

impl From<&RunRecord> for WorkflowRunDto {
    /// Application → DTO。
    fn from(value: &RunRecord) -> Self {
        Self {
            id: value.id.clone(),
            workflow_id: value.workflow_id.clone(),
            workflow_name: value.workflow_name.clone(),
            input_kind: value.input_kind.clone(),
            input_summary: value.input_summary.clone(),
            status: value.status.as_str().to_owned(),
            error_message: value.error_message.clone(),
            items_created: value.items_created,
            duration_ms: u32::try_from(value.duration_ms).unwrap_or(u32::MAX),
            started_at: format_utc(value.started_at),
            steps: value.steps.iter().map(StepReportDto::from).collect(),
        }
    }
}

/// 全部 Workflow：内置在前，其次是用户的，各自按优先级从大到小。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_workflows(state: State<'_, AppState>) -> Result<Vec<WorkflowDto>, IpcError> {
    let all = state.services.workflows.list().await?;
    let mut dtos = Vec::with_capacity(all.len());
    for stored in &all {
        dtos.push(dto_of(&state, stored).await?);
    }
    Ok(dtos)
}

/// 启用或禁用一个 Workflow（内置的也可以禁用）。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `WORKFLOW_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn set_workflow_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), IpcError> {
    state
        .services
        .workflows
        .set_enabled(&parse_id(&id)?, enabled)
        .await?;
    Ok(())
}

/// 调整优先级：数字大的先匹配。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `WORKFLOW_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn set_workflow_priority(
    state: State<'_, AppState>,
    id: String,
    priority: i32,
) -> Result<(), IpcError> {
    state
        .services
        .workflows
        .set_priority(&parse_id(&id)?, priority)
        .await?;
    Ok(())
}

/// 复制一个 Workflow：得到一份可编辑的用户副本，优先级比原来高，所以它会先于原件生效。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `WORKFLOW_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn duplicate_workflow(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowDto, IpcError> {
    let copy = state.services.workflows.duplicate(&parse_id(&id)?).await?;
    let stored = state.services.workflows.get(&copy.id).await?;
    Ok(dto_of(&state, &stored).await?)
}

/// 保存（新建或覆盖）一个用户 Workflow。定义要通过完整校验。
///
/// # Errors
///
/// 定义不合法返回 `WORKFLOW_INVALID`（消息里带出错位置）；覆盖内置 Workflow 返回
/// `WORKFLOW_READ_ONLY`。
#[tauri::command]
#[specta::specta]
pub async fn save_workflow(
    state: State<'_, AppState>,
    definition_json: String,
) -> Result<WorkflowDto, IpcError> {
    let workflow = state.services.workflows.save_json(&definition_json).await?;
    let stored = state.services.workflows.get(&workflow.id).await?;
    Ok(dto_of(&state, &stored).await?)
}

/// 删除一个用户 Workflow；内置的不能删除。
///
/// # Errors
///
/// `WORKFLOW_NOT_FOUND` / `WORKFLOW_READ_ONLY`。
#[tauri::command]
#[specta::specta]
pub async fn delete_workflow(state: State<'_, AppState>, id: String) -> Result<(), IpcError> {
    state.services.workflows.delete(&parse_id(&id)?).await?;
    Ok(())
}

/// 样例输入 → 捕获输入（与真实捕获用同一套规范化）。
fn sample_input(input: &DryRunInputDto) -> Result<CaptureInput, AppError> {
    let parsed = match input.kind.as_str() {
        "file" => nivlo_capture::normalize_files(&[input.value.trim()]),
        _ => nivlo_capture::normalize_text(&input.value),
    };
    parsed.ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "请先输入一个样例"))
}

/// 试运行：用样例输入跑一份定义（可以是还没保存的草稿），预览会创建什么。**不写任何数据。**
///
/// # Errors
///
/// 定义不合法返回 `WORKFLOW_INVALID`；样例为空返回 `INVALID_INPUT`。
#[tauri::command]
#[specta::specta]
pub async fn dry_run_workflow(
    state: State<'_, AppState>,
    definition_json: String,
    input: DryRunInputDto,
) -> Result<DryRunResultDto, IpcError> {
    let sample = sample_input(&input)?;
    let result = state
        .services
        .workflows
        .dry_run_json(&definition_json, &sample)
        .await?;
    Ok(DryRunResultDto::from(&result))
}

/// 最近的运行记录，新的在前。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_workflow_runs(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<WorkflowRunDto>, IpcError> {
    let runs = state
        .services
        .workflows
        .recent_runs(limit.unwrap_or(50).min(200))
        .await?;
    Ok(runs.iter().map(WorkflowRunDto::from).collect())
}

/// 重新运行 Workflow：按这个条目的来源重新匹配并完整运行，更新标题与内容。返回是否有变化。
///
/// # Errors
///
/// 来源不支持、没有匹配的规则或规则出错返回 `WORKFLOW_RUN_FAILED`；条目不存在返回 `ITEM_NOT_FOUND`。
#[tauri::command]
#[specta::specta]
pub async fn rerun_workflow(state: State<'_, AppState>, id: String) -> Result<bool, IpcError> {
    let item_id = crate::dto::parse_item_id(&id)?;
    Ok(state.services.capture.rerun(item_id).await?)
}

/// 确认一个 Workflow 里脚本的权限（脚本源码、声明的主机和网络权限的当前组合）。
///
/// 之后修改脚本或权限会让指纹变化，需要再次确认才会运行。内置 Workflow 也可以确认。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `WORKFLOW_NOT_FOUND`；存储失败返回存储错误。
#[tauri::command]
#[specta::specta]
pub async fn confirm_script_permissions(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowDto, IpcError> {
    let stored = state.services.workflows.get(&parse_id(&id)?).await?;
    SettingsScriptGrants::new(state.services.settings.clone())
        .grant_workflow(&stored.workflow)
        .await?;
    Ok(dto_of(&state, &stored).await?)
}

/// 导入前的预览：让用户在确认之前看清这份定义是什么、会请求什么权限。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowImportPreviewDto {
    /// 导入后的 ID（与现有 Workflow 冲突时已改名）。
    pub id: String,
    /// 原来的 ID；没有改名时为 `None`。
    pub renamed_from: Option<String>,
    /// 名称。
    pub name: String,
    /// 说明。
    pub description: String,
    /// 发布者（定义里写的，不经验证）。
    pub publisher: Option<String>,
    /// 是否要求网络权限。
    pub network: bool,
    /// 声明可访问的主机。
    pub hosts: Vec<String>,
    /// 是否包含脚本。
    pub has_script: bool,
    /// 脚本要访问的主机。
    pub script_hosts: Vec<String>,
    /// 用到的 Step 种类（按出现顺序，去重）。
    pub step_kinds: Vec<String>,
    /// 校验并规范化后的定义（确认导入时原样传回 `import_workflow`）。
    pub definition_json: String,
}

/// 预览（不写数据）。
fn import_preview_dto(
    preview: &nivlo_application::workflow::ImportPreview,
) -> Result<WorkflowImportPreviewDto, AppError> {
    let workflow = &preview.workflow;
    let definition_json = serde_json::to_string_pretty(workflow).map_err(|e| {
        AppError::new(
            ErrorCode::DataInconsistent,
            format!("无法序列化 Workflow：{e}"),
        )
    })?;
    let mut step_kinds: Vec<String> = Vec::new();
    for step in &workflow.steps {
        let kind = nivlo_workflow::executor::step_kind(step).to_owned();
        if !step_kinds.contains(&kind) {
            step_kinds.push(kind);
        }
    }
    Ok(WorkflowImportPreviewDto {
        id: workflow.id.to_string(),
        renamed_from: preview.renamed_from.as_ref().map(ToString::to_string),
        name: workflow.name.clone(),
        description: workflow.description.clone(),
        publisher: workflow.publisher.clone(),
        network: workflow.permissions.network,
        hosts: workflow.permissions.hosts.clone(),
        has_script: workflow
            .steps
            .iter()
            .any(|step| matches!(step, nivlo_domain::workflow::Step::Script { .. })),
        script_hosts: script_hosts(workflow),
        step_kinds,
        definition_json,
    })
}

/// 导出 / 导入文件的失败：记日志，返回 `EXPORT_FAILED`。
fn file_failed(error: &dyn std::fmt::Display) -> IpcError {
    tracing::error!(event = "workflow_file_failed", %error, "Workflow 文件读写失败");
    IpcError::from(AppError::new(ErrorCode::ExportFailed, error.to_string()))
}

/// Workflow 文件允许的最大字节数（定义最多 64 KiB 脚本外加少量结构，1 MiB 绰绰有余）。
const MAX_WORKFLOW_FILE_BYTES: u64 = 1024 * 1024;

/// 把一个 Workflow 导出成 `<id>.workflow.json`，写在导出目录并在文件管理器中显示，返回路径。
///
/// 文件只含定义本身（含脚本源码）。Workflow 里不存在凭据，导出也不会带上授权记录或设置。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `WORKFLOW_NOT_FOUND`，写入失败返回 `EXPORT_FAILED`。
#[tauri::command]
#[specta::specta]
pub async fn export_workflow_file(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, IpcError> {
    let stored = state.services.workflows.get(&parse_id(&id)?).await?;
    let paths = state
        .runtime
        .paths()
        .cloned()
        .ok_or_else(|| file_failed(&"应用目录尚未就绪"))?;
    let json = serde_json::to_string_pretty(&stored.workflow).map_err(|e| file_failed(&e))?;
    let dir = paths.exports_dir();
    std::fs::create_dir_all(&dir).map_err(|e| file_failed(&e))?;
    let path = dir.join(format!("{}.workflow.json", stored.workflow.id));
    std::fs::write(&path, json).map_err(|e| file_failed(&e))?;
    if let Err(error) = tauri_plugin_opener::reveal_item_in_dir(&path) {
        tracing::warn!(event = "reveal_export_failed", %error, "无法在文件管理器中显示导出的文件");
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 弹出文件选择框选一个 `*.workflow.json`，校验后返回导入预览（不写任何数据）。用户取消时返回 `null`。
///
/// # Errors
///
/// 文件读不了或过大返回 `EXPORT_FAILED`；定义不合法 / 格式版本高于当前支持返回 `WORKFLOW_INVALID`。
#[tauri::command]
#[specta::specta]
pub async fn pick_workflow_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<WorkflowImportPreviewDto>, IpcError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("拾序 Workflow", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| file_failed(&e))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| file_failed(&e))?;
    let size = std::fs::metadata(&path).map_err(|e| file_failed(&e))?.len();
    if size > MAX_WORKFLOW_FILE_BYTES {
        return Err(file_failed(&"文件太大，不像是一份 Workflow 定义"));
    }
    let json = std::fs::read_to_string(&path).map_err(|e| file_failed(&e))?;
    let preview = state.services.workflows.preview_import(&json).await?;
    Ok(Some(import_preview_dto(&preview)?))
}

/// 确认导入：保存预览里的定义（来源 Imported、默认禁用，不覆盖已有的 Workflow）。
///
/// # Errors
///
/// 定义不合法返回 `WORKFLOW_INVALID`；存储失败返回存储错误。
#[tauri::command]
#[specta::specta]
pub async fn import_workflow(
    state: State<'_, AppState>,
    definition_json: String,
) -> Result<WorkflowDto, IpcError> {
    let workflow = state.services.workflows.import(&definition_json).await?;
    let stored = state.services.workflows.get(&workflow.id).await?;
    Ok(dto_of(&state, &stored).await?)
}
