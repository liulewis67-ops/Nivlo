//! `stardeskbox-application`：应用层 Use Case、Port 定义、事务边界与事件发布。
//!
//! * [`ports`]：Application 需要外部世界提供的能力（存储、时钟等）的 trait。
//!   Port 在本层定义，由 Adapter crate 实现（后端规范 §4.2）。
//! * [`item::ItemService`]：Item 的创建 / 更新 / 读取 / 列表 Use Case。
//! * [`calendar::CalendarService`]：Calendar 的查询（计划、截止与待安排）。
//! * [`inbox::InboxService`]：Inbox 的列表（带来源与附件）与批量整理 / 撤销。
//! * [`organize::ProjectService`] / [`organize::TagService`]：项目与标签。
//! * [`trigger`]：由 Item 推导 Scheduler 的触发点（提醒 / Tip / 截止）。
//! * [`workflow`]：Workflow 引擎 Port、管理 Use Case（列表 / 复制 / 保存 / 试运行）与运行记录。
//! * [`trash::TrashService`]：删除、回收站、恢复与永久清除。
//! * [`today::TodayService`]：Today 视图（待办 / 提示 / 今日已完成）的查询。
//! * [`day_change`]：本地日期切换监视器。
//! * [`settings::SettingsService`]：业务设置（键值）的读写。
//! * [`error::AppError`]：统一错误模型，错误码登记在 `docs/development/error-codes.md`。
//! * [`event`]：进程内事件总线与 UI 事件映射接口。
//! * 事务边界由本层通过 [`ports::UnitOfWork`] 控制：一个 Use Case 内的多次写入在同一事务中提交，
//!   Repository 自己不提交，提交成功后才发布事件（架构文档 §56）。
//! * `testing` feature：内存版 Fake，供 Use Case 测试使用。
//!
//! 禁止依赖：`tauri`、`sqlx`、`reqwest`、`rquickjs`、`windows`、任何 Adapter crate
//! （参见后端规范 §3.1）。

pub mod calendar;
pub mod capture;
pub mod day_change;
pub mod error;
pub mod event;
pub mod export;
pub mod inbox;
pub mod item;
pub mod organize;
pub mod ports;
pub mod settings;
pub mod today;
pub mod trash;
pub mod trigger;
pub mod workflow;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

#[cfg(test)]
mod later_tests;
