//! 项目与标签的 SQLite Repository（实施计划 3.3）。

use async_trait::async_trait;
use starat_application::ports::{ProjectRepository, StorageError, TagRepository};
use starat_domain::id::{ItemId, ProjectId, TagId};
use starat_domain::project::{Project, ProjectName};
use starat_domain::tag::{Tag, TagName};

use crate::codec::{format_timestamp, parse_timestamp};
use crate::error::map_sqlx;
use crate::item_repository::SqliteTransaction;

/// 把 `projects` 表的一行还原为 Domain 的 `Project`。
fn project_from_row(
    id: &str,
    name: &str,
    created_at: &str,
    archived_at: Option<&str>,
) -> Result<Project, StorageError> {
    let corrupt = |e: String| StorageError::Corrupt(e);
    Ok(Project {
        id: id
            .parse::<ProjectId>()
            .map_err(|e| corrupt(e.to_string()))?,
        name: ProjectName::new(name).map_err(|e| corrupt(e.to_string()))?,
        created_at: parse_timestamp(created_at)?,
        archived_at: archived_at.map(parse_timestamp).transpose()?,
    })
}

/// 把 `tags` 表的一行还原为 Domain 的 `Tag`。
fn tag_from_row(id: &str, name: &str) -> Result<Tag, StorageError> {
    let corrupt = |e: String| StorageError::Corrupt(e);
    Ok(Tag {
        id: id.parse::<TagId>().map_err(|e| corrupt(e.to_string()))?,
        name: TagName::new(name).map_err(|e| corrupt(e.to_string()))?,
    })
}

/// 受影响行数为 0 时转换为「不存在」。
fn expect_affected(
    affected: u64,
    entity: &'static str,
    id: impl std::fmt::Display,
) -> Result<(), StorageError> {
    if affected == 0 {
        return Err(StorageError::NotFound {
            entity,
            id: id.to_string(),
        });
    }
    Ok(())
}

#[async_trait]
impl ProjectRepository for SqliteTransaction {
    /// 插入新项目。
    async fn insert(&mut self, project: &Project) -> Result<(), StorageError> {
        let id = project.id.to_string();
        let name = project.name.as_str();
        let created_at = format_timestamp(project.created_at);
        let archived_at = project.archived_at.map(format_timestamp);
        sqlx::query!(
            "INSERT INTO projects (id, name, created_at, archived_at) VALUES (?, ?, ?, ?)",
            id,
            name,
            created_at,
            archived_at
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 覆盖已存在的项目。
    async fn update(&mut self, project: &Project) -> Result<(), StorageError> {
        let id = project.id.to_string();
        let name = project.name.as_str();
        let archived_at = project.archived_at.map(format_timestamp);
        let result = sqlx::query!(
            "UPDATE projects SET name = ?, archived_at = ? WHERE id = ?",
            name,
            archived_at,
            id
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        expect_affected(result.rows_affected(), "project", project.id)
    }

    /// 按 ID 读取。
    async fn get(&mut self, id: ProjectId) -> Result<Option<Project>, StorageError> {
        let id = id.to_string();
        let row = sqlx::query!(
            "SELECT id, name, created_at, archived_at FROM projects WHERE id = ?",
            id
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        row.map(|r| project_from_row(&r.id, &r.name, &r.created_at, r.archived_at.as_deref()))
            .transpose()
    }

    /// 列表：创建时间从早到晚。
    async fn list(&mut self, include_archived: bool) -> Result<Vec<Project>, StorageError> {
        let include_archived = i64::from(include_archived);
        let rows = sqlx::query!(
            "SELECT id, name, created_at, archived_at FROM projects
             WHERE (?1 = 1 OR archived_at IS NULL)
             ORDER BY created_at ASC, id ASC",
            include_archived
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.iter()
            .map(|r| project_from_row(&r.id, &r.name, &r.created_at, r.archived_at.as_deref()))
            .collect()
    }

    /// 每个项目里未归档且未完成的 Item 数量。
    async fn open_item_counts(&mut self) -> Result<Vec<(ProjectId, u32)>, StorageError> {
        let rows = sqlx::query!(
            "SELECT project_id AS \"project_id!\", COUNT(*) AS \"count!: i64\"
             FROM items
             WHERE project_id IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL
               AND status != 'done'
             GROUP BY project_id"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.into_iter()
            .map(|r| {
                let id = r
                    .project_id
                    .parse::<ProjectId>()
                    .map_err(|e| StorageError::Corrupt(e.to_string()))?;
                Ok((id, u32::try_from(r.count).unwrap_or(u32::MAX)))
            })
            .collect()
    }
}

#[async_trait]
impl TagRepository for SqliteTransaction {
    /// 插入新标签；小写键重复时违反唯一约束。
    async fn insert(&mut self, tag: &Tag) -> Result<(), StorageError> {
        let id = tag.id.to_string();
        let name = tag.name.as_str();
        let key = tag.name.key();
        sqlx::query!(
            "INSERT INTO tags (id, name, name_key) VALUES (?, ?, ?)",
            id,
            name,
            key
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 按 ID 读取。
    async fn get(&mut self, id: TagId) -> Result<Option<Tag>, StorageError> {
        let id = id.to_string();
        let row = sqlx::query!("SELECT id, name FROM tags WHERE id = ?", id)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        row.map(|r| tag_from_row(&r.id, &r.name)).transpose()
    }

    /// 按名称（忽略大小写）查找。
    async fn find_by_name(&mut self, name: &TagName) -> Result<Option<Tag>, StorageError> {
        let key = name.key();
        let row = sqlx::query!("SELECT id, name FROM tags WHERE name_key = ?", key)
            .fetch_optional(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        row.map(|r| tag_from_row(&r.id, &r.name)).transpose()
    }

    /// 全部标签与各自未归档 Item 的数量，按名称排序。
    async fn list_with_counts(&mut self) -> Result<Vec<(Tag, u32)>, StorageError> {
        let rows = sqlx::query!(
            "SELECT tags.id AS \"id!\", tags.name AS \"name!\",
                    COUNT(items.id) AS \"count!: i64\"
             FROM tags
             LEFT JOIN item_tags ON item_tags.tag_id = tags.id
             LEFT JOIN items ON items.id = item_tags.item_id
                 AND items.archived_at IS NULL AND items.deleted_at IS NULL
             GROUP BY tags.id
             ORDER BY tags.name_key ASC, tags.id ASC"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.iter()
            .map(|r| {
                Ok((
                    tag_from_row(&r.id, &r.name)?,
                    u32::try_from(r.count).unwrap_or(u32::MAX),
                ))
            })
            .collect()
    }

    /// 重命名；新名称与另一个标签重名时违反唯一约束。
    async fn rename(&mut self, id: TagId, name: &TagName) -> Result<(), StorageError> {
        let id_text = id.to_string();
        let new_name = name.as_str();
        let key = name.key();
        let result = sqlx::query!(
            "UPDATE tags SET name = ?, name_key = ? WHERE id = ?",
            new_name,
            key,
            id_text
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        expect_affected(result.rows_affected(), "tag", id)
    }

    /// 把 `from` 的关联并入 `into`，然后删除 `from`。
    async fn merge(&mut self, from: TagId, into: TagId) -> Result<(), StorageError> {
        let from_text = from.to_string();
        let into_text = into.to_string();
        for (id, text) in [(from, &from_text), (into, &into_text)] {
            let exists = sqlx::query!("SELECT id FROM tags WHERE id = ?", text)
                .fetch_optional(&mut *self.tx)
                .await
                .map_err(map_sqlx)?;
            if exists.is_none() {
                return Err(StorageError::NotFound {
                    entity: "tag",
                    id: id.to_string(),
                });
            }
        }
        // 已同时带有两者的 Item 由主键冲突忽略；随后删除 from，其余关联随外键级联删除。
        sqlx::query!(
            "INSERT OR IGNORE INTO item_tags (item_id, tag_id)
             SELECT item_id, ? FROM item_tags WHERE tag_id = ?",
            into_text,
            from_text
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        sqlx::query!("DELETE FROM tags WHERE id = ?", from_text)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }

    /// 某个 Item 的标签，按名称排序。
    async fn for_item(&mut self, item_id: ItemId) -> Result<Vec<Tag>, StorageError> {
        let item_id = item_id.to_string();
        let rows = sqlx::query!(
            "SELECT tags.id AS id, tags.name AS name
             FROM item_tags JOIN tags ON tags.id = item_tags.tag_id
             WHERE item_tags.item_id = ?
             ORDER BY tags.name_key ASC, tags.id ASC",
            item_id
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.iter().map(|r| tag_from_row(&r.id, &r.name)).collect()
    }

    /// 整体替换某个 Item 的标签。
    async fn set_for_item(&mut self, item_id: ItemId, tags: &[TagId]) -> Result<(), StorageError> {
        let item_text = item_id.to_string();
        sqlx::query!("DELETE FROM item_tags WHERE item_id = ?", item_text)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        for tag in tags {
            let tag_text = tag.to_string();
            sqlx::query!(
                "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)",
                item_text,
                tag_text
            )
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        }
        Ok(())
    }
}
