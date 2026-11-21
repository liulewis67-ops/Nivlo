//! 项目与标签相关的 Command（实施计划 3.3）。

use tauri::State;

use crate::app::AppState;
use crate::dto::{
    IpcError, ItemTagsDto, ProjectDto, TagDto, TagSummaryDto, parse_item_id, parse_project_id,
    parse_tag_id,
};

/// 列出项目（创建时间从早到晚）与各自未完成的 Item 数量。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_projects(
    state: State<'_, AppState>,
    include_archived: bool,
) -> Result<Vec<ProjectDto>, IpcError> {
    let projects = state.services.projects.list(include_archived).await?;
    Ok(projects.iter().map(ProjectDto::from).collect())
}

/// 创建项目。
///
/// # Errors
///
/// 名称为空返回 `NAME_EMPTY`，过长返回 `NAME_TOO_LONG`。
#[tauri::command]
#[specta::specta]
pub async fn create_project(
    state: State<'_, AppState>,
    name: String,
) -> Result<ProjectDto, IpcError> {
    let project = state.services.projects.create(&name).await?;
    Ok(ProjectDto::from_project(&project, 0))
}

/// 重命名项目。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `PROJECT_NOT_FOUND`，名称不合法返回对应错误码。
#[tauri::command]
#[specta::specta]
pub async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<ProjectDto, IpcError> {
    let project = state
        .services
        .projects
        .rename(parse_project_id(&id)?, &name)
        .await?;
    Ok(ProjectDto::from_project(&project, 0))
}

/// 归档项目。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `PROJECT_NOT_FOUND`，已归档返回 `ITEM_ALREADY_ARCHIVED`。
#[tauri::command]
#[specta::specta]
pub async fn archive_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectDto, IpcError> {
    let project = state
        .services
        .projects
        .archive(parse_project_id(&id)?)
        .await?;
    Ok(ProjectDto::from_project(&project, 0))
}

/// 取消归档项目（归档的撤销）。
///
/// # Errors
///
/// ID 不合法返回 `INVALID_INPUT`，不存在返回 `PROJECT_NOT_FOUND`，尚未归档返回 `ITEM_NOT_ARCHIVED`。
#[tauri::command]
#[specta::specta]
pub async fn unarchive_project(
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectDto, IpcError> {
    let project = state
        .services
        .projects
        .unarchive(parse_project_id(&id)?)
        .await?;
    Ok(ProjectDto::from_project(&project, 0))
}

/// 全部标签与各自的 Item 数量（按名称排序）。
///
/// # Errors
///
/// 存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagSummaryDto>, IpcError> {
    let tags = state.services.tags.list().await?;
    Ok(tags.iter().map(TagSummaryDto::from).collect())
}

/// 一批 Item 各自的标签（只读；搜索结果旁显示），顺序与 `ids` 一致，最多 100 个。
///
/// # Errors
///
/// 某个 ID 格式不合法返回 `INVALID_INPUT`；存储失败时返回 [`IpcError`]。
#[tauri::command]
#[specta::specta]
pub async fn tags_for_items(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<ItemTagsDto>, IpcError> {
    let ids = ids
        .iter()
        .map(|id| parse_item_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let found = state.services.tags.for_items(&ids).await?;
    Ok(found
        .iter()
        .map(|(item_id, tags)| ItemTagsDto {
            item_id: item_id.to_string(),
            tags: tags.iter().map(TagDto::from).collect(),
        })
        .collect())
}

/// 重命名标签；所有关联的 Item 同步显示新名称。
///
/// # Errors
///
/// `TAG_NOT_FOUND`；与另一个标签重名返回 `TAG_NAME_TAKEN`；名称不合法返回对应错误码。
#[tauri::command]
#[specta::specta]
pub async fn rename_tag(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<TagDto, IpcError> {
    let tag = state
        .services
        .tags
        .rename(parse_tag_id(&id)?, &name)
        .await?;
    Ok(TagDto::from(&tag))
}

/// 把标签 `from` 合并进 `into`，返回合并后留下的标签。
///
/// # Errors
///
/// `TAG_NOT_FOUND`；两者相同返回 `INVALID_INPUT`。
#[tauri::command]
#[specta::specta]
pub async fn merge_tags(
    state: State<'_, AppState>,
    from: String,
    into: String,
) -> Result<TagDto, IpcError> {
    let tag = state
        .services
        .tags
        .merge(parse_tag_id(&from)?, parse_tag_id(&into)?)
        .await?;
    Ok(TagDto::from(&tag))
}

/// 用 `names` 整体替换某个 Item 的标签（不存在的标签自动创建），返回替换后的标签。
///
/// # Errors
///
/// `ITEM_NOT_FOUND`；名称不合法返回 `NAME_EMPTY` / `NAME_TOO_LONG`，此时没有任何改动。
#[tauri::command]
#[specta::specta]
pub async fn set_item_tags(
    state: State<'_, AppState>,
    id: String,
    names: Vec<String>,
) -> Result<Vec<TagDto>, IpcError> {
    let tags = state
        .services
        .tags
        .set_item_tags(parse_item_id(&id)?, &names)
        .await?;
    Ok(tags.iter().map(TagDto::from).collect())
}
