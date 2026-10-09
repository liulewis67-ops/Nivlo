//! `nivlo-scheduler`：Scheduler Actor：提醒、Tip、Due 触发、日期切换与唤醒后的 Reconcile。
//!
//! 禁止依赖：`tauri`、其他 Adapter 的内部实现（参见后端规范 §3.1）。
