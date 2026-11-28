//! `ProjectService` 与 `TagService`：项目与标签的组织能力（实施计划 3.3）。
//!
//! 与 [`crate::item::ItemService`] 一样遵循「事务 → 领域规则 → 提交 → 发布事件」的模式。
//! 项目的 Item 排序见 D-05：未完成 → 优先级 → 计划日期 → 创建时间（[`ItemOrder::ProjectView`](crate::ports::ItemOrder::ProjectView)）。

use std::collections::HashMap;
use std::sync::Arc;

use asterjot_common::clock::Clock;
use asterjot_common::id::new_uuid_v7;
use asterjot_domain::event::DomainEvent;
use asterjot_domain::id::{ItemId, ProjectId, TagId};
use asterjot_domain::project::Project;
use asterjot_domain::tag::{Tag, TagName};

use crate::error::{AppError, ErrorCode};
use crate::event::EventPublisher;
use crate::ports::{ItemFilter, UnitOfWork};

/// [`TagService::for_items`] 一次最多读取多少个 Item 的标签。
pub const TAGS_FOR_ITEMS_LIMIT: usize = 100;

/// 侧栏里的一个项目：项目本身与未完成的 Item 数量。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSummary {
    /// 项目。
    pub project: Project,
    /// 未归档且未完成的 Item 数量。
    pub open_count: u32,
}

/// 标签列表里的一项：标签本身与带有它的未归档 Item 数量。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagSummary {
    /// 标签。
    pub tag: Tag,
    /// 带有该标签的未归档 Item 数量。
    pub item_count: u32,
}

/// 项目的 Use Case 集合。
#[derive(Clone)]
pub struct ProjectService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟。
    clock: Arc<dyn Clock>,
}

impl ProjectService {
    /// 创建服务。
    pub fn new(uow: Arc<dyn UnitOfWork>, clock: Arc<dyn Clock>) -> Self {
        Self { uow, clock }
    }

    /// 列出项目（创建时间从早到晚）与各自未完成的 Item 数量。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn list(&self, include_archived: bool) -> Result<Vec<ProjectSummary>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let projects = tx.projects().list(include_archived).await?;
        let counts: HashMap<ProjectId, u32> = tx
            .projects()
            .open_item_counts()
            .await?
            .into_iter()
            .collect();
        Ok(projects
            .into_iter()
            .map(|project| ProjectSummary {
                open_count: counts.get(&project.id).copied().unwrap_or(0),
                project,
            })
            .collect())
    }

    /// 创建项目。
    ///
    /// # Errors
    ///
    /// 名称为空 / 过长（`NAME_EMPTY` / `NAME_TOO_LONG`）；存储错误。
    pub async fn create(&self, name: &str) -> Result<Project, AppError> {
        let now = self.clock.now_utc();
        let id = ProjectId::from_uuid(new_uuid_v7(self.clock.as_ref()));
        let project = Project::create(id, name, now)?;
        let mut tx = self.uow.begin().await?;
        tx.projects().insert(&project).await?;
        tx.commit().await?;
        Ok(project)
    }

    /// 重命名项目。
    ///
    /// # Errors
    ///
    /// 项目不存在（`PROJECT_NOT_FOUND`）；名称不合法；存储错误。
    pub async fn rename(&self, id: ProjectId, name: &str) -> Result<Project, AppError> {
        self.modify(id, |project| Ok(project.rename(name)?)).await
    }

    /// 归档项目：它从侧栏消失，里面的 Item 不受影响。
    ///
    /// # Errors
    ///
    /// 项目不存在；已经归档（`ITEM_ALREADY_ARCHIVED`）；存储错误。
    pub async fn archive(&self, id: ProjectId) -> Result<Project, AppError> {
        let now = self.clock.now_utc();
        self.modify(id, |project| Ok(project.archive(now)?)).await
    }

    /// 取消归档（归档的撤销）。
    ///
    /// # Errors
    ///
    /// 项目不存在；尚未归档（`ITEM_NOT_ARCHIVED`）；存储错误。
    pub async fn unarchive(&self, id: ProjectId) -> Result<Project, AppError> {
        self.modify(id, |project| Ok(project.unarchive()?)).await
    }

    /// 读取项目、应用修改、写回并提交。
    async fn modify(
        &self,
        id: ProjectId,
        change: impl FnOnce(&mut Project) -> Result<(), AppError>,
    ) -> Result<Project, AppError> {
        let mut tx = self.uow.begin().await?;
        let mut project = tx
            .projects()
            .get(id)
            .await?
            .ok_or_else(|| project_not_found(id))?;
        change(&mut project)?;
        tx.projects().update(&project).await?;
        tx.commit().await?;
        Ok(project)
    }
}

/// 「项目不存在」错误。
pub(crate) fn project_not_found(id: ProjectId) -> AppError {
    AppError::new(ErrorCode::ProjectNotFound, format!("项目 {id} 不存在"))
}

/// 「标签不存在」错误。
fn tag_not_found(id: TagId) -> AppError {
    AppError::new(ErrorCode::TagNotFound, format!("标签 {id} 不存在"))
}

/// 标签的 Use Case 集合。
#[derive(Clone)]
pub struct TagService {
    /// 事务工厂。
    uow: Arc<dyn UnitOfWork>,
    /// 时钟：用于生成 UUIDv7。
    clock: Arc<dyn Clock>,
    /// 提交成功后发布领域事件。
    events: Arc<dyn EventPublisher>,
}

impl TagService {
    /// 创建服务。
    pub fn new(
        uow: Arc<dyn UnitOfWork>,
        clock: Arc<dyn Clock>,
        events: Arc<dyn EventPublisher>,
    ) -> Self {
        Self { uow, clock, events }
    }

    /// 全部标签与各自的 Item 数量（按名称排序），标签管理与自动补全共用。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn list(&self) -> Result<Vec<TagSummary>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        Ok(tx
            .tags()
            .list_with_counts()
            .await?
            .into_iter()
            .map(|(tag, item_count)| TagSummary { tag, item_count })
            .collect())
    }

    /// 重命名标签；所有关联的 Item 随之显示新名称（关联按 ID，不按名称）。
    /// 只改大小写（`jira` → `Jira`）是允许的。
    ///
    /// # Errors
    ///
    /// * `TAG_NOT_FOUND` - 标签不存在。
    /// * `TAG_NAME_TAKEN` - 新名称与另一个标签重名（想合并请用 [`TagService::merge`]）。
    /// * `NAME_EMPTY` / `NAME_TOO_LONG` - 名称不合法。
    pub async fn rename(&self, id: TagId, name: &str) -> Result<Tag, AppError> {
        let name = TagName::new(name)?;
        let mut tx = self.uow.begin().await?;
        let mut tag = tx.tags().get(id).await?.ok_or_else(|| tag_not_found(id))?;
        if let Some(other) = tx.tags().find_by_name(&name).await?
            && other.id != id
        {
            return Err(name_taken(&name));
        }
        tx.tags().rename(id, &name).await?;
        tx.commit().await?;
        tag.name = name;
        Ok(tag)
    }

    /// 把 `from` 合并进 `into`：带有 `from` 的 Item 改为带有 `into`，然后 `from` 被删除。
    ///
    /// 提交后为每个受影响的 Item 发布 `ItemUpdated`，让界面刷新它们的标签。
    ///
    /// # Errors
    ///
    /// `TAG_NOT_FOUND`；两者相同时为 `INVALID_INPUT`；存储错误。
    pub async fn merge(&self, from: TagId, into: TagId) -> Result<Tag, AppError> {
        if from == into {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "不能把标签合并到它自己",
            ));
        }
        let mut tx = self.uow.begin().await?;
        let target = tx
            .tags()
            .get(into)
            .await?
            .ok_or_else(|| tag_not_found(into))?;
        if tx.tags().get(from).await?.is_none() {
            return Err(tag_not_found(from));
        }
        let affected = tx
            .items()
            .list(&ItemFilter {
                tag_id: Some(from),
                include_archived: true,
                ..ItemFilter::default()
            })
            .await?;
        tx.tags().merge(from, into).await?;
        tx.commit().await?;
        for item in affected {
            self.events
                .publish(DomainEvent::ItemUpdated { item_id: item.id() });
        }
        Ok(target)
    }

    /// 某个 Item 的标签。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn for_item(&self, item_id: ItemId) -> Result<Vec<Tag>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        Ok(tx.tags().for_item(item_id).await?)
    }

    /// 一批 Item 各自的标签（搜索结果旁显示用），一个事务里读完，顺序与 `item_ids` 一致。
    ///
    /// 最多读 [`TAGS_FOR_ITEMS_LIMIT`] 个，多出来的忽略（搜索结果本身也有上限）。
    ///
    /// # Errors
    ///
    /// 存储错误。
    pub async fn for_items(
        &self,
        item_ids: &[ItemId],
    ) -> Result<Vec<(ItemId, Vec<Tag>)>, AppError> {
        let mut tx = self.uow.begin_read().await?;
        let mut result = Vec::with_capacity(item_ids.len().min(TAGS_FOR_ITEMS_LIMIT));
        for &item_id in item_ids.iter().take(TAGS_FOR_ITEMS_LIMIT) {
            result.push((item_id, tx.tags().for_item(item_id).await?));
        }
        Ok(result)
    }

    /// 用 `names` 整体替换某个 Item 的标签：不存在的标签自动创建，忽略大小写重复的名称只留一个
    /// （保留先出现的写法），已有同名标签时沿用它的写法。
    ///
    /// # Errors
    ///
    /// * `ITEM_NOT_FOUND` - Item 不存在。
    /// * `NAME_EMPTY` / `NAME_TOO_LONG` - 某个名称不合法，整批不变。
    /// * 存储错误，事务已回滚。
    pub async fn set_item_tags(
        &self,
        item_id: ItemId,
        names: &[String],
    ) -> Result<Vec<Tag>, AppError> {
        let names: Vec<TagName> = names
            .iter()
            .map(|n| TagName::new(n))
            .collect::<Result<_, _>>()?;
        let mut tx = self.uow.begin().await?;
        if tx.items().get(item_id).await?.is_none() {
            return Err(AppError::item_not_found(item_id));
        }
        let mut ids: Vec<TagId> = Vec::with_capacity(names.len());
        for name in names {
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
            if !ids.contains(&tag.id) {
                ids.push(tag.id);
            }
        }
        tx.tags().set_for_item(item_id, &ids).await?;
        let tags = tx.tags().for_item(item_id).await?;
        tx.commit().await?;
        self.events.publish(DomainEvent::ItemUpdated { item_id });
        Ok(tags)
    }
}

/// 「标签名已被占用」错误。
fn name_taken(name: &TagName) -> AppError {
    AppError::new(
        ErrorCode::TagNameTaken,
        format!("已经有一个叫「{}」的标签", name.as_str()),
    )
}

#[cfg(test)]
mod tests;
