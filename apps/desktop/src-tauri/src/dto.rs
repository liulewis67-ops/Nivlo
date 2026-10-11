//! IPC 数据传输对象（DTO）。
//!
//! Rust DTO 是前后端契约的单一来源：派生 `specta::Type` 后由 `tauri-specta` 生成 TypeScript
//! Binding（架构文档 §14）。DTO 与 Domain 类型分离——Domain 不依赖 specta，IPC 形状也可以
//! 独立于领域模型演进。所有字段使用 `camelCase`，日期时间一律使用字符串：
//!
//! * 本地日期 `YYYY-MM-DD`，本地时间 `HH:MM:SS`（输入也接受 `HH:MM`）；
//! * UTC 时间点为 RFC 3339。

use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveTime, SecondsFormat, Utc};
use nivlo_application::capture::CaptureResult;
use nivlo_application::error::{AppError, ErrorCode};
use nivlo_application::inbox::{
    InboxEntry, OrganizeAction, OrganizeOutcome, PreviousState, ScheduleTarget,
};
use nivlo_application::item::{Patch, RescheduleTarget, UpdateItemInput};
use nivlo_application::ports::{ItemFilter, ItemOrder};
use nivlo_application::today::{TodayEntry, TodayView};
use nivlo_domain::attachment::Attachment;
use nivlo_domain::capture::{CaptureInput, CaptureOrigin, CaptureRequest};
use nivlo_domain::id::{ItemId, ProjectId};
use nivlo_domain::item::{ContentFormat, DatePoint, Item, ItemStatus, ItemType, NewItem, Priority};
use nivlo_domain::source::Source;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::shortcut::ShortcutStatus;

/// IPC 统一的错误结构 `{ code, message, action }`（架构文档 §43）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    /// 稳定的大写错误码，前端据此分支并作为 i18n key。
    pub code: String,
    /// 面向开发者的说明，仅用于日志与调试。
    pub message: String,
    /// 可恢复错误附带的 UI 动作。
    pub action: Option<String>,
}

impl From<AppError> for IpcError {
    /// 把 Application 错误转换为 IPC 结构。
    fn from(error: AppError) -> Self {
        Self {
            code: error.code.as_str().to_owned(),
            message: error.message,
            action: error.action.map(|a| a.as_str().to_owned()),
        }
    }
}

/// Item 类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ItemTypeDto {
    /// 待办。
    Todo,
    /// 笔记。
    Note,
    /// 提示。
    Tip,
}

impl From<ItemType> for ItemTypeDto {
    /// Domain → DTO。
    fn from(value: ItemType) -> Self {
        match value {
            ItemType::Todo => Self::Todo,
            ItemType::Note => Self::Note,
            ItemType::Tip => Self::Tip,
        }
    }
}

impl From<ItemTypeDto> for ItemType {
    /// DTO → Domain。
    fn from(value: ItemTypeDto) -> Self {
        match value {
            ItemTypeDto::Todo => Self::Todo,
            ItemTypeDto::Note => Self::Note,
            ItemTypeDto::Tip => Self::Tip,
        }
    }
}

/// Item 状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatusDto {
    /// 未完成。
    Open,
    /// 已完成。
    Done,
}

impl From<ItemStatus> for ItemStatusDto {
    /// Domain → DTO。
    fn from(value: ItemStatus) -> Self {
        match value {
            ItemStatus::Open => Self::Open,
            ItemStatus::Done => Self::Done,
        }
    }
}

/// 优先级。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PriorityDto {
    /// 未设置。
    None,
    /// 低。
    Low,
    /// 中。
    Medium,
    /// 高。
    High,
}

impl From<Priority> for PriorityDto {
    /// Domain → DTO。
    fn from(value: Priority) -> Self {
        match value {
            Priority::None => Self::None,
            Priority::Low => Self::Low,
            Priority::Medium => Self::Medium,
            Priority::High => Self::High,
        }
    }
}

impl From<PriorityDto> for Priority {
    /// DTO → Domain。
    fn from(value: PriorityDto) -> Self {
        match value {
            PriorityDto::None => Self::None,
            PriorityDto::Low => Self::Low,
            PriorityDto::Medium => Self::Medium,
            PriorityDto::High => Self::High,
        }
    }
}

/// 内容格式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ContentFormatDto {
    /// 纯文本。
    Plain,
    /// Markdown。
    Markdown,
}

impl From<ContentFormat> for ContentFormatDto {
    /// Domain → DTO。
    fn from(value: ContentFormat) -> Self {
        match value {
            ContentFormat::Plain => Self::Plain,
            ContentFormat::Markdown => Self::Markdown,
        }
    }
}

impl From<ContentFormatDto> for ContentFormat {
    /// DTO → Domain。
    fn from(value: ContentFormatDto) -> Self {
        match value {
            ContentFormatDto::Plain => Self::Plain,
            ContentFormatDto::Markdown => Self::Markdown,
        }
    }
}

/// 本地日期，可选带本地时间。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatePointDto {
    /// 本地日期，`YYYY-MM-DD`。
    pub date: String,
    /// 本地时间，`HH:MM:SS`；`null` 表示全天。
    pub time: Option<String>,
}

impl From<DatePoint> for DatePointDto {
    /// Domain → DTO。
    fn from(value: DatePoint) -> Self {
        Self {
            date: value.date().format("%Y-%m-%d").to_string(),
            time: value.time().map(|t| t.format("%H:%M:%S").to_string()),
        }
    }
}

impl TryFrom<DatePointDto> for DatePoint {
    type Error = AppError;

    /// DTO → Domain；格式不对时返回 `INVALID_INPUT`。
    fn try_from(value: DatePointDto) -> Result<Self, Self::Error> {
        let date = NaiveDate::parse_from_str(&value.date, "%Y-%m-%d")
            .map_err(|_| invalid(format!("无效的日期：{}", value.date)))?;
        match value.time {
            None => Ok(Self::all_day(date)),
            Some(text) => {
                let time = NaiveTime::parse_from_str(&text, "%H:%M:%S")
                    .or_else(|_| NaiveTime::parse_from_str(&text, "%H:%M"))
                    .map_err(|_| invalid(format!("无效的时间：{text}")))?;
                Ok(Self::at(date, time))
            }
        }
    }
}

/// 构造 `INVALID_INPUT` 错误。
fn invalid(message: String) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

/// 解析 RFC 3339 时间点并转换为 UTC。
fn parse_utc(text: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(text)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| invalid(format!("无效的时间点：{text}")))
}

/// 把 UTC 时间点编码为 RFC 3339（毫秒精度）。
fn format_utc(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 解析 Item ID 文本。
///
/// # Errors
///
/// 不是合法 UUID 时返回 `INVALID_INPUT`。
pub fn parse_item_id(text: &str) -> Result<ItemId, AppError> {
    text.parse()
        .map_err(|_| invalid(format!("无效的 Item ID：{text}")))
}

/// Item 的 IPC 表示。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    /// Item ID（UUID 文本）。
    pub id: String,
    /// 类型。
    pub item_type: ItemTypeDto,
    /// 标题。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 内容格式。
    pub content_format: ContentFormatDto,
    /// 状态。
    pub status: ItemStatusDto,
    /// 优先级。
    pub priority: PriorityDto,
    /// 计划日期。
    pub scheduled: Option<DatePointDto>,
    /// 截止日期。
    pub due: Option<DatePointDto>,
    /// 提醒时间点（RFC 3339，UTC）。
    pub reminder_at: Option<String>,
    /// 所属项目 ID。
    pub project_id: Option<String>,
    /// 是否在 Inbox 里等待整理。
    pub in_inbox: bool,
    /// 创建时间（RFC 3339，UTC）。
    pub created_at: String,
    /// 最近更新时间。
    pub updated_at: String,
    /// 完成时间。
    pub completed_at: Option<String>,
    /// 归档时间。
    pub archived_at: Option<String>,
}

impl From<&Item> for ItemDto {
    /// Domain → DTO。
    fn from(item: &Item) -> Self {
        Self {
            id: item.id().to_string(),
            item_type: item.item_type().into(),
            title: item.title().to_string(),
            content: item.content().map(str::to_owned),
            content_format: item.content_format().into(),
            status: item.status().into(),
            priority: item.priority().into(),
            scheduled: item.scheduled().map(Into::into),
            due: item.due().map(Into::into),
            reminder_at: item.reminder_at().map(format_utc),
            project_id: item.project_id().map(|p| p.to_string()),
            in_inbox: item.in_inbox(),
            created_at: format_utc(item.created_at()),
            updated_at: format_utc(item.updated_at()),
            completed_at: item.completed_at().map(format_utc),
            archived_at: item.archived_at().map(format_utc),
        }
    }
}

/// 创建 Item 的请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemRequest {
    /// 类型。
    pub item_type: ItemTypeDto,
    /// 标题。
    pub title: String,
    /// 内容。
    pub content: Option<String>,
    /// 内容格式；缺省为纯文本。
    pub content_format: Option<ContentFormatDto>,
    /// 优先级；缺省为未设置。
    pub priority: Option<PriorityDto>,
    /// 计划日期。
    pub scheduled: Option<DatePointDto>,
    /// 截止日期。
    pub due: Option<DatePointDto>,
    /// 提醒时间点（RFC 3339）。
    pub reminder_at: Option<String>,
    /// 所属项目 ID。
    pub project_id: Option<String>,
}

impl TryFrom<CreateItemRequest> for NewItem {
    type Error = AppError;

    /// DTO → Application 输入；日期、时间点或 ID 格式不对时返回 `INVALID_INPUT`。
    fn try_from(request: CreateItemRequest) -> Result<Self, Self::Error> {
        let mut new = NewItem::new(request.item_type.into(), request.title);
        new.content = request.content;
        if let Some(format) = request.content_format {
            new.content_format = format.into();
        }
        if let Some(priority) = request.priority {
            new.priority = priority.into();
        }
        new.scheduled = request.scheduled.map(DatePoint::try_from).transpose()?;
        new.due = request.due.map(DatePoint::try_from).transpose()?;
        new.reminder_at = request.reminder_at.as_deref().map(parse_utc).transpose()?;
        new.project_id = request
            .project_id
            .map(|text| {
                text.parse::<ProjectId>()
                    .map_err(|_| invalid(format!("无效的项目 ID：{text}")))
            })
            .transpose()?;
        Ok(new)
    }
}

/// Today 中的一个条目（只含展示所需的字段，不含正文，保持载荷精简）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodayItemDto {
    /// Item ID。
    pub id: String,
    /// 类型。
    pub item_type: ItemTypeDto,
    /// 标题。
    pub title: String,
    /// 状态。
    pub status: ItemStatusDto,
    /// 优先级。
    pub priority: PriorityDto,
    /// 计划日期。
    pub scheduled: Option<DatePointDto>,
    /// 截止日期。
    pub due: Option<DatePointDto>,
    /// 是否逾期：计划日期早于今天。
    pub is_overdue: bool,
}

impl From<&TodayEntry> for TodayItemDto {
    /// Application → DTO。
    fn from(entry: &TodayEntry) -> Self {
        let item = &entry.item;
        Self {
            id: item.id().to_string(),
            item_type: item.item_type().into(),
            title: item.title().to_string(),
            status: item.status().into(),
            priority: item.priority().into(),
            scheduled: item.scheduled().map(Into::into),
            due: item.due().map(Into::into),
            is_overdue: entry.is_overdue,
        }
    }
}

/// Today 视图的 IPC 表示。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodayViewDto {
    /// 用户本地时区下的今天，`YYYY-MM-DD`。
    pub date: String,
    /// 今天还剩多少个待办——悬浮窗徽标上的数字。
    pub remaining_count: u32,
    /// 未完成的待办，已按 Today Order 排序。
    pub todos: Vec<TodayItemDto>,
    /// 今天的提示。
    pub tips: Vec<TodayItemDto>,
    /// 今天已完成的待办。
    pub completed: Vec<TodayItemDto>,
}

impl From<&TodayView> for TodayViewDto {
    /// Application → DTO。
    fn from(view: &TodayView) -> Self {
        Self {
            date: view.date.format("%Y-%m-%d").to_string(),
            // 待办数量不可能超过 u32；饱和转换只是为了不写 unwrap。
            remaining_count: u32::try_from(view.remaining_count()).unwrap_or(u32::MAX),
            todos: view.todos.iter().map(Into::into).collect(),
            tips: view.tips.iter().map(Into::into).collect(),
            completed: view.completed.iter().map(Into::into).collect(),
        }
    }
}

/// 展开悬浮窗的请求：面板期望的 logical 尺寸。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExpandFloatingRequest {
    /// 面板宽度（logical px）。
    pub width: f64,
    /// 面板高度（logical px）。
    pub height: f64,
}

/// 悬浮窗面板允许请求的最大边长（logical px），防止前端的错误输入把窗口撑到离谱的大小。
const MAX_PANEL_LOGICAL_PX: f64 = 2000.0;

/// 悬浮窗面板允许请求的最小边长（logical px）。
const MIN_PANEL_LOGICAL_PX: f64 = 40.0;

impl ExpandFloatingRequest {
    /// 校验尺寸并返回 `(宽, 高)`。
    ///
    /// # Errors
    ///
    /// 尺寸不是有限数，或超出允许范围时返回 `INVALID_INPUT`。
    pub fn validated(self) -> Result<(f64, f64), AppError> {
        let in_range = |value: f64| {
            value.is_finite() && (MIN_PANEL_LOGICAL_PX..=MAX_PANEL_LOGICAL_PX).contains(&value)
        };
        if in_range(self.width) && in_range(self.height) {
            Ok((self.width, self.height))
        } else {
            Err(invalid(format!(
                "无效的面板尺寸：{} x {}",
                self.width, self.height
            )))
        }
    }
}

/// 展开后面板相对徽标的水平方向。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum HorizontalAnchorDto {
    /// 徽标在面板左侧，面板向右展开。
    Left,
    /// 徽标在面板右侧，面板向左展开。
    Right,
}

/// 展开后面板相对徽标的垂直方向。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum VerticalAnchorDto {
    /// 徽标在面板上侧，面板向下展开。
    Top,
    /// 徽标在面板下侧，面板向上展开。
    Bottom,
}

/// 展开后的布局：前端据此设置动画的 transform-origin，让面板从徽标所在的角"长出来"。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedLayoutDto {
    /// 水平锚点。
    pub horizontal: HorizontalAnchorDto,
    /// 垂直锚点。
    pub vertical: VerticalAnchorDto,
}

impl From<nivlo_platform::placement::ExpandedLayout> for ExpandedLayoutDto {
    /// Platform → DTO。
    fn from(layout: nivlo_platform::placement::ExpandedLayout) -> Self {
        use nivlo_platform::placement::{HorizontalAnchor, VerticalAnchor};
        Self {
            horizontal: match layout.horizontal {
                HorizontalAnchor::Left => HorizontalAnchorDto::Left,
                HorizontalAnchor::Right => HorizontalAnchorDto::Right,
            },
            vertical: match layout.vertical {
                VerticalAnchor::Top => VerticalAnchorDto::Top,
                VerticalAnchor::Bottom => VerticalAnchorDto::Bottom,
            },
        }
    }
}

/// 快速创建的请求：只有类型与标题，日期等默认值由后端按产品规则决定。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuickCreateRequest {
    /// 类型。
    pub item_type: ItemTypeDto,
    /// 标题（去除首尾空白后不能为空）。
    pub title: String,
}

/// 列表的排序方式（IPC 表示）。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ItemOrderDto {
    /// 创建时间从新到旧（默认）。
    #[default]
    Created,
    /// 最近更新的在前。
    Updated,
}

/// 列出 Item 的请求。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListItemsRequest {
    /// 只返回该类型。
    pub item_type: Option<ItemTypeDto>,
    /// 是否包含已归档的 Item。
    pub include_archived: bool,
    /// 排序方式；缺省为创建时间从新到旧。
    #[serde(default)]
    pub order_by: ItemOrderDto,
    /// 最多返回的条数。
    pub limit: Option<u32>,
}

impl From<ListItemsRequest> for ItemFilter {
    /// DTO → Application 过滤条件。
    fn from(request: ListItemsRequest) -> Self {
        Self {
            item_type: request.item_type.map(Into::into),
            include_archived: request.include_archived,
            in_inbox_only: false,
            order: match request.order_by {
                ItemOrderDto::Created => ItemOrder::CreatedDesc,
                ItemOrderDto::Updated => ItemOrder::UpdatedDesc,
            },
            limit: request.limit,
        }
    }
}

/// 对可清除字段的三态修改（IPC 表示）：保持 / 清除 / 设置为新值。
///
/// 普通的可空字段无法区分「不修改」与「清除」，所以显式区分。缺省（字段没有出现）是保持原值。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PatchDto<T> {
    /// 保持原值。
    #[default]
    Keep,
    /// 清除字段。
    Clear,
    /// 设置为新值。
    Set {
        /// 新值。
        value: T,
    },
}

/// 更新 Item 的请求：所有字段默认「不修改」。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateItemRequest {
    /// 转换类型；会按领域规则清理新类型不再适用的字段。
    pub item_type: Option<ItemTypeDto>,
    /// 新标题。
    pub title: Option<String>,
    /// 内容的修改。
    pub content: PatchDto<String>,
    /// 内容格式。
    pub content_format: Option<ContentFormatDto>,
    /// 优先级。
    pub priority: Option<PriorityDto>,
    /// 计划日期的修改。
    pub scheduled: PatchDto<DatePointDto>,
    /// 截止日期的修改。
    pub due: PatchDto<DatePointDto>,
    /// 提醒时间点（RFC 3339）的修改。
    pub reminder_at: PatchDto<String>,
}

/// 把 IPC 三态修改转换成 Application 的 [`Patch`]。
fn patch<T, U>(
    value: PatchDto<T>,
    convert: impl FnOnce(T) -> Result<U, AppError>,
) -> Result<Patch<U>, AppError> {
    Ok(match value {
        PatchDto::Keep => Patch::Keep,
        PatchDto::Clear => Patch::Clear,
        PatchDto::Set { value } => Patch::Set(convert(value)?),
    })
}

impl TryFrom<UpdateItemRequest> for UpdateItemInput {
    type Error = AppError;

    /// DTO → Application；日期或时间点格式不对时返回 `INVALID_INPUT`。
    fn try_from(request: UpdateItemRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            item_type: request.item_type.map(Into::into),
            title: request.title,
            content: patch(request.content, Ok)?,
            content_format: request.content_format.map(Into::into),
            priority: request.priority.map(Into::into),
            scheduled: patch(request.scheduled, DatePoint::try_from)?,
            due: patch(request.due, DatePoint::try_from)?,
            reminder_at: patch(request.reminder_at, |text| parse_utc(&text))?,
            // 项目在 3.3 之后才有界面与管理；详情面板暂不修改。
            project_id: Patch::Keep,
        })
    }
}

/// 全局快捷键的状态（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatusDto {
    /// 用户的绑定，规范文本如 `Ctrl+Shift+Space`。
    pub accelerator: String,
    /// 当前是否已经注册到系统。
    pub registered: bool,
    /// 没注册成功是因为被其他程序占用：界面应提示并引导重新绑定。
    pub conflict: bool,
}

impl From<ShortcutStatus> for ShortcutStatusDto {
    /// Host → DTO。
    fn from(value: ShortcutStatus) -> Self {
        Self {
            accelerator: value.accelerator,
            registered: value.registered,
            conflict: value.conflict,
        }
    }
}

/// 来源（IPC 表示）：这条 Item 来自哪里。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceDto {
    /// 来源类型：`web` / `file` / `text` / `image` / `manual` 等。
    pub source_type: String,
    /// 来源应用；未知时为 `null`。
    pub source_app: Option<String>,
    /// 来源网址。
    pub source_url: Option<String>,
    /// 来源文件路径。
    pub source_path: Option<String>,
    /// 来源原始标题。
    pub original_title: Option<String>,
    /// 捕获时间（RFC 3339）。
    pub captured_at: String,
}

impl From<&Source> for SourceDto {
    /// Domain → DTO。
    fn from(value: &Source) -> Self {
        Self {
            source_type: value.source_type.as_str().to_owned(),
            source_app: value.source_app.clone(),
            source_url: value.source_url.clone(),
            source_path: value.source_path.clone(),
            original_title: value.original_title.clone(),
            captured_at: format_utc(value.captured_at),
        }
    }
}

/// 附件（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    /// `reference`（引用用户的文件）或 `stored`（Nivlo 保存的图片）。
    pub kind: String,
    /// 路径：引用时是原始路径；保存的图片是相对 `attachments/` 的文件名。
    pub path: String,
    /// 展示用文件名。
    pub name: String,
    /// MIME 类型。
    pub mime: Option<String>,
    /// 文件大小（字节）。
    pub size_bytes: Option<f64>,
    /// 被引用的文件现在是否还在；保存的图片恒为 `true`。展示「文件不存在」状态用，不会因此报错。
    pub exists: bool,
}

impl AttachmentDto {
    /// Domain → DTO，同时检查被引用的文件是否还在。
    #[must_use]
    pub fn from_attachment(value: &Attachment) -> Self {
        let exists = if value.owns_file() {
            true
        } else {
            nivlo_capture::reference_exists(&value.path)
        };
        #[allow(clippy::cast_precision_loss)]
        let size_bytes = value.size_bytes.map(|size| size as f64);
        Self {
            kind: value.kind.as_str().to_owned(),
            path: value.path.clone(),
            name: value.name.clone(),
            mime: value.mime.clone(),
            size_bytes,
            exists,
        }
    }
}

/// Inbox 中的一条（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntryDto {
    /// Item。
    pub item: ItemDto,
    /// 来源。
    pub sources: Vec<SourceDto>,
    /// 附件。
    pub attachments: Vec<AttachmentDto>,
}

impl From<&InboxEntry> for InboxEntryDto {
    /// Application → DTO。
    fn from(value: &InboxEntry) -> Self {
        Self {
            item: ItemDto::from(&value.item),
            sources: value.sources.iter().map(SourceDto::from).collect(),
            attachments: value
                .attachments
                .iter()
                .map(AttachmentDto::from_attachment)
                .collect(),
        }
    }
}

/// 安排日期的目标（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduleTargetDto {
    /// 今天。
    Today,
    /// 明天。
    Tomorrow,
    /// 稍后（下周一）。
    Later,
    /// 指定某一天。
    Date {
        /// 本地日期，`YYYY-MM-DD`。
        date: String,
    },
}

/// 对一批 Item 的整理动作（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OrganizeActionDto {
    /// 手动移出 Inbox。
    LeaveInbox,
    /// 安排日期。
    Schedule {
        /// 目标日期。
        target: ScheduleTargetDto,
    },
    /// 转换类型。
    ConvertTo {
        /// 新类型。
        item_type: ItemTypeDto,
    },
    /// 归档。
    Archive,
}

impl TryFrom<OrganizeActionDto> for OrganizeAction {
    type Error = AppError;

    /// DTO → Application；日期格式不对时返回 `INVALID_INPUT`。
    fn try_from(value: OrganizeActionDto) -> Result<Self, Self::Error> {
        Ok(match value {
            OrganizeActionDto::LeaveInbox => Self::LeaveInbox,
            OrganizeActionDto::Schedule { target } => Self::Schedule(match target {
                ScheduleTargetDto::Today => ScheduleTarget::Today,
                ScheduleTargetDto::Tomorrow => ScheduleTarget::Tomorrow,
                ScheduleTargetDto::Later => ScheduleTarget::Later,
                ScheduleTargetDto::Date { date } => ScheduleTarget::Date(
                    NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                        .map_err(|_| invalid(format!("无效的日期：{date}")))?,
                ),
            }),
            OrganizeActionDto::ConvertTo { item_type } => Self::ConvertTo(item_type.into()),
            OrganizeActionDto::Archive => Self::Archive,
        })
    }
}

/// 整理之前的状态（IPC 表示），原样交给 `restore_items` 撤销。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviousStateDto {
    /// Item ID。
    pub id: String,
    /// 原来的类型。
    pub item_type: ItemTypeDto,
    /// 原来的计划日期。
    pub scheduled: Option<DatePointDto>,
    /// 原来是否在 Inbox 里。
    pub in_inbox: bool,
    /// 原来是否已归档。
    pub archived: bool,
}

impl From<&PreviousState> for PreviousStateDto {
    /// Application → DTO。
    fn from(value: &PreviousState) -> Self {
        Self {
            id: value.id.to_string(),
            item_type: value.item_type.into(),
            scheduled: value.scheduled.map(DatePointDto::from),
            in_inbox: value.in_inbox,
            archived: value.archived,
        }
    }
}

impl TryFrom<PreviousStateDto> for PreviousState {
    type Error = AppError;

    /// DTO → Application；ID 或日期格式不对时返回 `INVALID_INPUT`。
    fn try_from(value: PreviousStateDto) -> Result<Self, Self::Error> {
        Ok(Self {
            id: parse_item_id(&value.id)?,
            item_type: value.item_type.into(),
            scheduled: value.scheduled.map(DatePoint::try_from).transpose()?,
            in_inbox: value.in_inbox,
            archived: value.archived,
        })
    }
}

/// 一次批量整理的结果（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeResultDto {
    /// 整理之后的 Item。
    pub items: Vec<ItemDto>,
    /// 整理之前的状态：传给 `restore_items` 撤销。
    pub previous: Vec<PreviousStateDto>,
}

impl From<&OrganizeOutcome> for OrganizeResultDto {
    /// Application → DTO。
    fn from(value: &OrganizeOutcome) -> Self {
        Self {
            items: value.items.iter().map(ItemDto::from).collect(),
            previous: value.previous.iter().map(PreviousStateDto::from).collect(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    /// 由序号生成 Item ID。
    fn item_id(n: u128) -> ItemId {
        ItemId::from_uuid(uuid::Uuid::from_u128(n))
    }

    #[test]
    fn date_point_round_trips_through_dto() {
        let dto = DatePointDto {
            date: "2026-10-09".into(),
            time: Some("14:30".into()),
        };
        let point = DatePoint::try_from(dto).unwrap();
        let back = DatePointDto::from(point);
        assert_eq!(back.date, "2026-10-09");
        assert_eq!(back.time.as_deref(), Some("14:30:00"));
    }

    #[test]
    fn invalid_dates_are_rejected_with_invalid_input() {
        let err = DatePoint::try_from(DatePointDto {
            date: "2026/10/09".into(),
            time: None,
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        let err = DatePoint::try_from(DatePointDto {
            date: "2026-10-09".into(),
            time: Some("25:99".into()),
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn create_request_converts_to_new_item() {
        let request = CreateItemRequest {
            item_type: ItemTypeDto::Todo,
            title: "写周报".into(),
            content: None,
            content_format: Some(ContentFormatDto::Markdown),
            priority: Some(PriorityDto::High),
            scheduled: Some(DatePointDto {
                date: "2026-10-12".into(),
                time: None,
            }),
            due: None,
            reminder_at: Some("2026-10-12T01:00:00+08:00".into()),
            project_id: None,
        };
        let new = NewItem::try_from(request).unwrap();
        assert_eq!(new.item_type, ItemType::Todo);
        assert_eq!(new.priority, Priority::High);
        assert_eq!(new.content_format, ContentFormat::Markdown);
        assert_eq!(
            new.reminder_at,
            Some(Utc.with_ymd_and_hms(2026, 10, 11, 17, 0, 0).unwrap())
        );
    }

    #[test]
    fn item_dto_serializes_with_camel_case_keys() {
        let (item, _) = Item::create(
            item_id(1),
            NewItem::new(ItemType::Tip, "服务器维护"),
            Utc.with_ymd_and_hms(2026, 10, 9, 8, 0, 0).unwrap(),
        )
        .unwrap();
        let json = serde_json::to_value(ItemDto::from(&item)).unwrap();
        assert_eq!(json["itemType"], "tip");
        assert_eq!(json["createdAt"], "2026-10-09T08:00:00.000Z");
        assert!(json["completedAt"].is_null());
    }

    #[test]
    fn ipc_error_carries_code_and_action() {
        let error: IpcError = AppError::from(nivlo_application::ports::StorageError::Unavailable(
            "x".into(),
        ))
        .into();
        assert_eq!(error.code, "STORAGE_UNAVAILABLE");
        assert_eq!(error.action.as_deref(), Some("OPEN_DIAGNOSTICS"));
    }

    #[test]
    fn bad_item_id_is_invalid_input() {
        assert_eq!(
            parse_item_id("nope").unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}

/// 改期的目标。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RescheduleTargetDto {
    /// 今天。
    Today,
    /// 明天。
    Tomorrow,
    /// 稍后（下周一）。
    Later,
    /// 收集箱（清除计划日期）。
    Inbox,
    /// 精确设置（或清除）计划，用于撤销。
    Exact {
        /// 要设置的计划；`null` 表示清除。
        scheduled: Option<DatePointDto>,
    },
}

impl TryFrom<RescheduleTargetDto> for RescheduleTarget {
    type Error = AppError;

    /// DTO → Application；`Exact` 里的日期格式不对时返回 `INVALID_INPUT`。
    fn try_from(value: RescheduleTargetDto) -> Result<Self, Self::Error> {
        Ok(match value {
            RescheduleTargetDto::Today => Self::Today,
            RescheduleTargetDto::Tomorrow => Self::Tomorrow,
            RescheduleTargetDto::Later => Self::Later,
            RescheduleTargetDto::Inbox => Self::Inbox,
            RescheduleTargetDto::Exact { scheduled } => {
                Self::Exact(scheduled.map(DatePoint::try_from).transpose()?)
            }
        })
    }
}

/// 捕获的内容（IPC 表示）：前端只传原始材料，规范化（识别 URL、探测文件）在后端完成。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureInputDto {
    /// 一段文本；整段恰好是一个网址时会被识别为网址。
    Text {
        /// 文本内容。
        text: String,
    },
    /// 一组文件 / 文件夹的路径（拖放、粘贴文件）。
    Files {
        /// 原始路径。
        paths: Vec<String>,
    },
    /// 一张图片（如粘贴的截图），Base64 编码的字节。
    Image {
        /// Base64（标准字母表）编码的图片字节。
        data_base64: String,
    },
}

/// 捕获从哪里来（IPC 表示）。只用于日志与统计。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CaptureOriginDto {
    /// 手动输入。
    Manual,
    /// 拖放。
    Drop,
    /// 粘贴。
    Paste,
    /// 快速添加。
    QuickAdd,
    /// 全局快捷键。
    Shortcut,
}

impl From<CaptureOriginDto> for CaptureOrigin {
    /// DTO → Domain。
    fn from(value: CaptureOriginDto) -> Self {
        match value {
            CaptureOriginDto::Manual => Self::Manual,
            CaptureOriginDto::Drop => Self::Drop,
            CaptureOriginDto::Paste => Self::Paste,
            CaptureOriginDto::QuickAdd => Self::QuickAdd,
            CaptureOriginDto::Shortcut => Self::Shortcut,
        }
    }
}

/// 捕获请求（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequestDto {
    /// 内容。
    pub input: CaptureInputDto,
    /// 来路。
    pub origin: CaptureOriginDto,
    /// 来源应用；识别不了时为 `null`。
    pub source_application: Option<String>,
}

impl TryFrom<CaptureRequestDto> for CaptureRequest {
    type Error = AppError;

    /// DTO → Domain，同时做规范化；没有可捕获的内容或图片无法识别时返回 `INVALID_INPUT`。
    fn try_from(value: CaptureRequestDto) -> Result<Self, Self::Error> {
        let empty = || invalid("没有可捕获的内容".to_owned());
        let input: CaptureInput = match value.input {
            CaptureInputDto::Text { text } => {
                nivlo_capture::normalize_text(&text).ok_or_else(empty)?
            }
            CaptureInputDto::Files { paths } => {
                nivlo_capture::normalize_files(&paths).ok_or_else(empty)?
            }
            CaptureInputDto::Image { data_base64 } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_base64.as_bytes())
                    .map_err(|_| invalid("图片数据不是有效的 Base64".to_owned()))?;
                nivlo_capture::image_input(bytes).map_err(|e| invalid(e.to_string()))?
            }
        };
        let mut request = Self::new(input, value.origin.into());
        request.source_application = value
            .source_application
            .map(|app| app.trim().to_owned())
            .filter(|app| !app.is_empty());
        Ok(request)
    }
}

/// 捕获的结果（IPC 表示）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResultDto {
    /// 创建的 Item。
    pub items: Vec<ItemDto>,
    /// 撤销这次捕获的句柄：传给 `undo_capture`。
    pub undo_ids: Vec<String>,
}

impl From<&CaptureResult> for CaptureResultDto {
    /// Application → DTO。
    fn from(result: &CaptureResult) -> Self {
        Self {
            items: result.items.iter().map(ItemDto::from).collect(),
            undo_ids: result.undo_ids().iter().map(ToString::to_string).collect(),
        }
    }
}
