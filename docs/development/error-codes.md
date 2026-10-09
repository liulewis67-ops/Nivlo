# 错误码登记

Application 层的 `AppError` 通过 IPC 返回 `{ code, message, action }`（架构文档 §43）。
`code` 是稳定的大写标识，前端只依赖 `code` 做分支；`message` 不保证稳定。

**新增错误码的步骤**：

1. 在 `crates/nivlo-application/src/error.rs` 的 `ErrorCode` 中添加变体，并加入 `ErrorCode::ALL` 与 `as_str`。
2. 在下表登记（测试 `every_error_code_is_registered_in_the_docs` 会检查）。
3. 错误码一旦发布不得改名；废弃时在"备注"中标注，不删除。

## 错误码

| 错误码 | 含义 | 来源 | 备注 |
|---|---|---|---|
| `INVALID_INPUT` | 输入不合法（通用） | Application | |
| `ITEM_NOT_FOUND` | Item 不存在 | Application / Storage | |
| `ITEM_TITLE_EMPTY` | 标题为空 | Domain | |
| `ITEM_TITLE_TOO_LONG` | 标题超过 500 个字符 | Domain | |
| `ITEM_CONTENT_TOO_LONG` | 内容超过 200000 个字符 | Domain | |
| `ITEM_NOT_COMPLETABLE` | Note / Tip 不能被完成 | Domain | |
| `ITEM_ALREADY_COMPLETED` | Item 已经完成 | Domain | |
| `ITEM_NOT_COMPLETED` | Item 尚未完成，无法重新打开 | Domain | |
| `ITEM_ALREADY_ARCHIVED` | Item 已经归档 | Domain | |
| `ITEM_NOT_ARCHIVED` | Item 尚未归档 | Domain | |
| `ITEM_ARCHIVED` | Item 已归档，需先取消归档 | Domain | |
| `ITEM_FIELD_NOT_APPLICABLE` | 字段不适用于该类型（如 Note 的截止日期） | Domain | |
| `NAME_EMPTY` | 项目 / 标签名称为空 | Domain | |
| `NAME_TOO_LONG` | 项目 / 标签名称过长 | Domain | |
| `DATA_INCONSISTENT` | 持久化数据自相矛盾 | Domain | 附带 `OPEN_DIAGNOSTICS` 动作的场景见 `STORAGE_CORRUPT` |
| `STORAGE_CONSTRAINT` | 违反数据库约束（外键、唯一等） | Storage | |
| `STORAGE_UNAVAILABLE` | 数据库不可用 | Storage | 动作：`OPEN_DIAGNOSTICS` |
| `STORAGE_CORRUPT` | 存储的数据无法还原为合法对象 | Storage | 动作：`OPEN_DIAGNOSTICS` |
| `STORAGE_MIGRATION_FAILED` | 数据库迁移失败，业务 Runtime 不会启动 | Storage | 动作：`OPEN_DIAGNOSTICS` |

## UI 动作

| 动作 | 含义 |
|---|---|
| `OPEN_DIAGNOSTICS` | 打开日志目录 / 导出诊断信息 |
