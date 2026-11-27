//! `starat-scheduler`：Scheduler：提醒、Tip、截止的触发与唤醒后的 Reconcile（实施计划 4.4、4.5）。
//!
//! * [`plan`]：纯函数——哪些触发点现在该触发、下一个是什么、怎么整理成通知；
//! * [`service::Scheduler`]：驱动循环——Reconcile（触发该触发的、记录已触发的）→ 睡到最近的触发点
//!   （不是逐秒轮询）→ 被 Schedule 变化 / 恢复通知唤醒，或到点自己醒来。
//!
//! 可靠性来自「触发记录」而不是「内存里的计时器」：每次醒来（启动、唤醒、时钟变化、计时到点）
//! 都用墙上时钟重新计算一遍，已经通知过的不会重复，错过的会补发。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。

pub mod plan;
pub mod service;

pub use plan::Locale;
pub use service::{Control, Scheduler};
