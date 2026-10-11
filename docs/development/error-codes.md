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
| `PROJECT_NOT_FOUND` | 项目不存在 | Application | |
| `TAG_NOT_FOUND` | 标签不存在 | Application | |
| `TAG_NAME_TAKEN` | 标签名与另一个标签重名（忽略大小写），想合并请用合并 | Application | |
| `NAME_EMPTY` | 项目 / 标签名称为空 | Domain | |
| `NAME_TOO_LONG` | 项目 / 标签名称过长 | Domain | |
| `DATA_INCONSISTENT` | 持久化数据自相矛盾 | Domain | 附带 `OPEN_DIAGNOSTICS` 动作的场景见 `STORAGE_CORRUPT` |
| `STORAGE_CONSTRAINT` | 违反数据库约束（外键、唯一等） | Storage | |
| `STORAGE_UNAVAILABLE` | 数据库不可用 | Storage | 动作：`OPEN_DIAGNOSTICS` |
| `STORAGE_CORRUPT` | 存储的数据无法还原为合法对象 | Storage | 动作：`OPEN_DIAGNOSTICS` |
| `STORAGE_MIGRATION_FAILED` | 数据库迁移失败，业务 Runtime 不会启动 | Storage | 动作：`OPEN_DIAGNOSTICS` |
| `WINDOW_UNAVAILABLE` | 宿主窗口无法创建或显示（如 WebView2 异常） | Host | 动作：`OPEN_DIAGNOSTICS` |
| `SHORTCUT_INVALID` | 不是合法的快捷键（没有修饰键、不认识的按键、没有主键等） | Host | 用户重新输入 |
| `WORKFLOW_NOT_FOUND` | Workflow 不存在 | Application | |
| `WORKFLOW_INVALID` | Workflow 定义没有通过校验（消息里带出错位置） | Application | |
| `WORKFLOW_READ_ONLY` | 试图修改或删除只读的内置 Workflow | Application | 先「复制」再修改 |
| `EXPORT_FAILED` | 导出诊断包 / 备份 / 数据失败（磁盘已满、没有写权限等） | Host | 提示换个位置或检查磁盘空间 |
| `SYSTEM_SETTING_FAILED` | 无法修改系统设置（如开机启动项） | Host | |
| `SOURCE_FILE_MISSING` | 来源指向的文件已经不在原处（被移动或删除） | Host | UI 提示「文件不存在」 |
| `SOURCE_OPEN_FAILED` | 无法打开来源：没有可打开的来源、网址不是 http(s)、或系统打开失败 | Host | |
| `CLIPBOARD_UNAVAILABLE` | 无法读取剪贴板（被其他程序占用且重试后仍失败，或当前平台不支持） | Host | 用户稍后重试 |
| `CLIPBOARD_EMPTY` | 用户粘贴时，剪贴板里没有可以收集的内容（空的、只有不认识的格式） | Host | 用户先复制点什么 |
| `SHORTCUT_CONFLICT` | 快捷键已被其他程序占用 | Host | 用户换一个组合；原来的绑定保持不变 |

## UI 动作

| 动作 | 含义 |
|---|---|
| `OPEN_DIAGNOSTICS` | 打开日志目录 / 导出诊断信息 |
