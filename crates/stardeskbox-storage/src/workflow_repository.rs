//! Workflow 定义与运行记录的 SQLite Repository（实施计划 5.1、5.6）。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use stardeskbox_application::ports::{StorageError, WorkflowRepository};
use stardeskbox_application::workflow::{
    RunRecord, RunStatus, StepOutcome, StepReport, StoredWorkflow,
};
use stardeskbox_domain::workflow::{Workflow, WorkflowId, WorkflowSource};

use crate::codec::{format_timestamp, parse_timestamp};
use crate::error::map_sqlx;
use crate::item_repository::SqliteTransaction;

/// `source` 列的稳定文本。
fn source_text(source: WorkflowSource) -> &'static str {
    match source {
        WorkflowSource::Builtin => "builtin",
        WorkflowSource::User => "user",
        WorkflowSource::Imported => "imported",
        WorkflowSource::Marketplace => "marketplace",
    }
}

/// 从 `source` 列还原。
fn parse_source(text: &str) -> Result<WorkflowSource, StorageError> {
    match text {
        "builtin" => Ok(WorkflowSource::Builtin),
        "user" => Ok(WorkflowSource::User),
        "imported" => Ok(WorkflowSource::Imported),
        "marketplace" => Ok(WorkflowSource::Marketplace),
        other => Err(StorageError::Corrupt(format!(
            "未知的 Workflow 来源 {other}"
        ))),
    }
}

/// 把一行还原为 [`StoredWorkflow`]：定义取自 JSON，状态字段（启用 / 优先级 / 来源 / 版本）以列为准。
#[allow(clippy::too_many_arguments)]
fn to_stored(
    definition: &str,
    source: &str,
    version: i64,
    enabled: i64,
    priority: i64,
    created_at: &str,
    updated_at: &str,
) -> Result<StoredWorkflow, StorageError> {
    let mut workflow: Workflow = serde_json::from_str(definition)
        .map_err(|e| StorageError::Corrupt(format!("Workflow 定义无法解析：{e}")))?;
    workflow.source = parse_source(source)?;
    workflow.version = u32::try_from(version).unwrap_or(1);
    workflow.enabled = enabled != 0;
    workflow.priority = i32::try_from(priority).unwrap_or(0);
    Ok(StoredWorkflow {
        workflow,
        created_at: parse_timestamp(created_at)?,
        updated_at: parse_timestamp(updated_at)?,
    })
}

#[async_trait]
impl WorkflowRepository for SqliteTransaction {
    /// 全部 Workflow。
    async fn list(&mut self) -> Result<Vec<StoredWorkflow>, StorageError> {
        let rows = sqlx::query!(
            "SELECT definition, source, version, enabled, priority, created_at, updated_at
             FROM workflows ORDER BY id ASC"
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        rows.iter()
            .map(|r| {
                to_stored(
                    &r.definition,
                    &r.source,
                    r.version,
                    r.enabled,
                    r.priority,
                    &r.created_at,
                    &r.updated_at,
                )
            })
            .collect()
    }

    /// 按 ID 读取。
    async fn get(&mut self, id: &WorkflowId) -> Result<Option<StoredWorkflow>, StorageError> {
        let id = id.as_str();
        let row = sqlx::query!(
            "SELECT definition, source, version, enabled, priority, created_at, updated_at
             FROM workflows WHERE id = ?",
            id
        )
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        row.map(|r| {
            to_stored(
                &r.definition,
                &r.source,
                r.version,
                r.enabled,
                r.priority,
                &r.created_at,
                &r.updated_at,
            )
        })
        .transpose()
    }

    /// 插入或整体覆盖；已存在时保留创建时间。
    async fn upsert(
        &mut self,
        workflow: &Workflow,
        now: DateTime<Utc>,
    ) -> Result<(), StorageError> {
        let id = workflow.id.as_str();
        let name = workflow.name.trim();
        let source = source_text(workflow.source);
        let version = i64::from(workflow.version);
        let enabled = i64::from(workflow.enabled);
        let priority = i64::from(workflow.priority);
        let definition = serde_json::to_string(workflow)
            .map_err(|e| StorageError::Corrupt(format!("Workflow 无法序列化：{e}")))?;
        let now = format_timestamp(now);
        sqlx::query!(
            "INSERT INTO workflows (id, name, source, version, enabled, priority, definition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT (id) DO UPDATE SET
                name = excluded.name, source = excluded.source, version = excluded.version,
                enabled = excluded.enabled, priority = excluded.priority,
                definition = excluded.definition, updated_at = excluded.updated_at",
            id,
            name,
            source,
            version,
            enabled,
            priority,
            definition,
            now
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(())
    }

    /// 删除。
    async fn delete(&mut self, id: &WorkflowId) -> Result<(), StorageError> {
        let id = id.as_str();
        sqlx::query!("DELETE FROM workflows WHERE id = ?", id)
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        Ok(())
    }

    /// 写入运行记录与它的 Step 记录。
    async fn insert_run(&mut self, run: &RunRecord) -> Result<(), StorageError> {
        let status = run.status.as_str();
        let items_created = i64::from(run.items_created);
        let duration_ms = i64::try_from(run.duration_ms).unwrap_or(i64::MAX);
        let started_at = format_timestamp(run.started_at);
        sqlx::query!(
            "INSERT INTO workflow_runs (
                id, workflow_id, workflow_name, input_kind, input_summary, status,
                error_kind, error_message, items_created, duration_ms, started_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            run.id,
            run.workflow_id,
            run.workflow_name,
            run.input_kind,
            run.input_summary,
            status,
            run.error_kind,
            run.error_message,
            items_created,
            duration_ms,
            started_at
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        for step in &run.steps {
            let index = i64::from(step.index);
            let outcome = step.outcome.as_str();
            let step_ms = i64::try_from(step.duration_ms).unwrap_or(i64::MAX);
            sqlx::query!(
                "INSERT INTO workflow_run_steps (run_id, step_index, kind, status, duration_ms, message)
                 VALUES (?, ?, ?, ?, ?, ?)",
                run.id,
                index,
                step.kind,
                outcome,
                step_ms,
                step.message
            )
            .execute(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
        }
        Ok(())
    }

    /// 最近的运行记录（新的在前），带 Step 记录。
    async fn list_runs(&mut self, limit: u32) -> Result<Vec<RunRecord>, StorageError> {
        let limit = i64::from(limit);
        let rows = sqlx::query!(
            "SELECT id, workflow_id, workflow_name, input_kind, input_summary, status,
                    error_kind, error_message, items_created, duration_ms, started_at
             FROM workflow_runs ORDER BY started_at DESC, id DESC LIMIT ?",
            limit
        )
        .fetch_all(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        let mut runs = Vec::with_capacity(rows.len());
        for row in rows {
            let step_rows = sqlx::query!(
                "SELECT step_index, kind, status, duration_ms, message
                 FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index ASC",
                row.id
            )
            .fetch_all(&mut *self.tx)
            .await
            .map_err(map_sqlx)?;
            let steps = step_rows
                .into_iter()
                .map(|s| {
                    Ok(StepReport {
                        index: u32::try_from(s.step_index).unwrap_or(0),
                        kind: s.kind,
                        outcome: StepOutcome::parse(&s.status).ok_or_else(|| {
                            StorageError::Corrupt(format!("未知的 Step 状态 {}", s.status))
                        })?,
                        duration_ms: u64::try_from(s.duration_ms).unwrap_or(0),
                        message: s.message,
                        logs: Vec::new(),
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?;
            runs.push(RunRecord {
                id: row.id,
                workflow_id: row.workflow_id,
                workflow_name: row.workflow_name,
                input_kind: row.input_kind,
                input_summary: row.input_summary,
                status: RunStatus::parse(&row.status).ok_or_else(|| {
                    StorageError::Corrupt(format!("未知的运行状态 {}", row.status))
                })?,
                error_kind: row.error_kind,
                error_message: row.error_message,
                items_created: u32::try_from(row.items_created).unwrap_or(0),
                duration_ms: u64::try_from(row.duration_ms).unwrap_or(0),
                started_at: parse_timestamp(&row.started_at)?,
                steps,
            });
        }
        Ok(runs)
    }

    /// 清理：只留最近 `keep` 条，并删除早于 `before` 的。
    async fn prune_runs(&mut self, keep: u32, before: DateTime<Utc>) -> Result<u64, StorageError> {
        let keep = i64::from(keep);
        let before = format_timestamp(before);
        let result = sqlx::query!(
            "DELETE FROM workflow_runs
             WHERE started_at < ?1
                OR id NOT IN (SELECT id FROM workflow_runs ORDER BY started_at DESC, id DESC LIMIT ?2)",
            before,
            keep
        )
        .execute(&mut *self.tx)
        .await
        .map_err(map_sqlx)?;
        Ok(result.rows_affected())
    }
}
