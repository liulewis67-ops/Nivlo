//! 把 `sqlx` 错误转换为 Application 层的 [`StorageError`]。
//!
//! 底层错误不得向上泄漏（后端规范 §4.4），因此所有 `sqlx::Error` 都在此处折叠。

use sqlx::error::ErrorKind;
use starat_application::ports::StorageError;

/// 转换 `sqlx` 运行期错误。
///
/// 约束类错误（外键、唯一、非空、CHECK）映射为 [`StorageError::Constraint`]，
/// 其余视为数据库不可用。
pub(crate) fn map_sqlx(error: sqlx::Error) -> StorageError {
    if let sqlx::Error::Database(db) = &error
        && matches!(
            db.kind(),
            ErrorKind::UniqueViolation
                | ErrorKind::ForeignKeyViolation
                | ErrorKind::NotNullViolation
                | ErrorKind::CheckViolation
        )
    {
        return StorageError::Constraint(db.message().to_owned());
    }
    StorageError::Unavailable(error.to_string())
}
