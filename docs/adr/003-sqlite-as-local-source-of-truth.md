# ADR-003 SQLite as Local Source of Truth

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §2.3、§29–31、§56

## 背景

AsterJot 是 Local First 应用，需要可靠持久化、事务与全文搜索，且不依赖网络。

## 决策

SQLite（WAL、`foreign_keys=ON`）是 Domain State 的唯一 Source of Truth；通过 SQLx 手写 SQL 访问，Schema 只通过新增 Migration 演进；事务边界由 Application 层的 `UnitOfWork` 控制；全文搜索使用 FTS5。前端状态不作为业务数据存储。

## 后果

- 好处：单文件、零运维、事务保证；便于备份与导出。
- 代价 / 风险：单写者模型需要注意长事务；不使用 ORM，需要自行维护行类型与转换。
- 替代方案：嵌入式 KV（缺少关系与 FTS）；ORM（隐藏 SQL、增加编译成本）。
