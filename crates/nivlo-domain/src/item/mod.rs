//! Item 聚合：Todo / Note / Tip 的统一模型（架构文档 §8.1，ADR-008）。

mod kinds;
mod model;
mod values;

pub use kinds::{ContentFormat, ItemStatus, ItemType, Priority};
pub use model::{Item, ItemSnapshot, MAX_BRIEF_CHARS, MAX_CONTENT_CHARS, NewItem};
pub use values::{DatePoint, MAX_TITLE_CHARS, Title};
