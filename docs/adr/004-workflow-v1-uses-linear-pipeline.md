# ADR-004 Workflow V1 Uses Linear Pipeline

- 状态：Accepted
- 日期：2026-10-09
- 相关文档：架构文档 §18–21；产品文档 Workflow 章节；实施计划 Phase 5

## 背景

过早平台化 Workflow（分支、循环、并行）会拖慢 MVP 并扩大测试面（架构文档 §61 风险 4）。

## 决策

Workflow V1 是线性步骤管线：Trigger/Matcher → 有序 Step 列表 → 结果；Step 之间通过 Workflow Context 传递数据；错误按 Step 配置的策略处理（失败 / 跳过 / 降级）。不引入分支、循环与并行。

## 后果

- 好处：执行模型简单、可调试、易于记录 Run；内置 Workflow 足以覆盖 MVP 场景。
- 代价 / 风险：复杂场景需要多个 Workflow 或 Script Step 解决；未来引入分支需要格式升级（定义文件带版本号）。
- 替代方案：DAG / 可视化编排（MVP 范围外）。
