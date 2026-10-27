# Nivlo · 拾序

> 拾取散落的信息，让事情各归其序。

## 1. 产品概述

**Nivlo · 拾序** 是一款以桌面悬浮窗口为核心入口的个人信息捕获与行动管理工具。

它不是传统意义上的便签软件，也不是单纯的 Todo 应用，而是一个围绕“捕获 → 处理 → 安排 → 执行”构建的桌面个人工作台。

用户可以通过手动创建、拖拽、粘贴、快捷键、自动规则等方式，将网页、文件、文字、图片、想法等内容快速转化为 Todo、Note 或 Tip，并通过 Today 与 Calendar 进行后续安排和执行。

核心理念：

```text
Anything
  ↓
Capture
  ↓
Workflow
  ↓
Item
  ↓
Schedule
  ↓
Today / Calendar
```

一句话描述：

> **Nivlo 是一个可编程的桌面信息入口，用最短路径把散落的信息转化为可执行事项。**

---

## 2. 品牌定位

### 2.1 名称

- 英文名：**Nivlo**
- 中文名：**拾序**

“拾序”包含两个核心含义：

- **拾**：拾取、捕获、记录、拖入
- **序**：整理、排序、日程、Workflow、执行顺序

品牌表达：

> **拾取万物，各归其序。**

### 2.2 产品关键词

- Desktop First
- Capture First
- Local First
- Source-aware
- Programmable
- Fast
- Lightweight
- Actionable

---

## 3. 产品定位

传统 Todo 产品通常强调：

```text
创建任务
→ 填写属性
→ 分类
→ 安排时间
```

Nivlo 更强调：

```text
看到一个东西
→ 直接捕获
→ 自动理解
→ 自动转化
→ 稍后处理
```

核心差异不在 Todo 或 Note 本身，而在：

1. 桌面常驻的悬浮入口
2. 极低成本的信息捕获
3. 拖拽创建
4. 可编程 Capture Workflow
5. 来源信息保留
6. Today Stack
7. Calendar 规划
8. Todo / Note / Tip 的统一管理

因此，Nivlo 更接近：

> **Programmable Desktop Capture Hub**

而不是传统意义上的 Todo App。

---

# 4. 核心产品模型

## 4.1 四个核心概念

Nivlo 的核心模型可以收敛为：

```text
Capture
   ↓
Workflow
   ↓
Item
   ↓
Schedule
```

### Capture

负责回答：

> 信息从哪里进入 Nivlo？

支持：

- 手动输入
- Drag & Drop
- Paste
- Clipboard
- 全局快捷键
- 文件
- 网页
- Browser Extension
- Integration
- Script
- API

### Workflow

负责回答：

> 捕获到这个内容之后应该怎么处理？

例如：

```text
Jira URL
↓
解析 Jira
↓
读取标题 / 描述 / 状态 / 时间
↓
生成 Todo
↓
归入 Work 项目
```

### Item

所有进入系统的内容最终统一为 Item。

主要类型：

```text
Item
├── Todo
├── Note
└── Tip
```

### Schedule

负责回答：

> 什么时候需要看到、处理或知道这个 Item？

包含：

- Scheduled Date
- Due Date
- Reminder
- Calendar
- Today

---

# 5. 桌面悬浮窗

悬浮窗是 Nivlo 最重要的产品入口。

## 5.1 默认状态

默认保持极简：

```text
● 4
```

数字表示今天还剩 4 个 Todo。

悬浮窗要求：

- 永远可达
- 支持拖动
- 支持屏幕边缘吸附
- 支持置顶
- 尽量低视觉干扰
- 空闲状态保持轻量

---

## 5.2 Hover 展开 Today

鼠标移入悬浮窗后自动展示当天事项：

```text
┌────────────────────────────┐
│ Today · Sep 27         +   │
│────────────────────────────│
│ ⠿  □ 修复登录超时          │
│ ⠿  □ Review PR #182       │
│ ⠿  □ 完成 Jira AI-128     │
│ ⠿  □ 整理 Agent 设计      │
│                            │
│ 💡 15:00 提交周报           │
│                            │
│ + Todo   + Note   + Tip    │
└────────────────────────────┘
```

Hover 用于：

- 查看 Today
- 完成 Todo
- 调整 Todo 顺序
- 快速新增
- 查看 Tip
- 推迟任务

点击悬浮窗则进入完整 Workspace。

即：

```text
Hover
→ Today Panel

Click
→ Main Workspace
```

---

## 5.3 Today Stack

Today 不只是一个任务列表，而是一组用户主动安排好的执行顺序。

例如：

```text
Today

≡ Review PR
≡ Fix API
≡ Jira-218
≡ 写周报
```

用户可以任意拖动排序。

需要独立维护：

```text
today_order
```

而不是直接依赖：

- priority
- created_at
- due_date

因为：

> Priority 不等于今天的执行顺序。

---

## 5.4 Hover 体验细节

建议：

- Hover 200~300ms 后展开
- Mouse Leave 500ms 左右再收起
- 设置 Hover Safe Area
- 避免鼠标移动到面板时面板消失

---

## 5.5 外观与自定义皮肤

悬浮窗常年停在桌面上，用户应能让它和自己的桌面协调，甚至带点个性。

可调整：

- 强调色：蓝 / 紫 / 青 / 玫红 / 琥珀
- 徽标形态：胶囊（圆点 + 数字）、圆形（只有数字）、迷你圆点
- 面板质感：纯色 / 通透
- 圆角：柔和 / 圆润
- 整体不透明度：40%–100%

自定义皮肤：用户可以上传一组 PNG 帧图替换默认徽标，例如一只像素风小宠物：

- 最多 16 帧，可调播放速度
- 播放方式：循环、往返、仅悬停时播放、静止
- 附加动效：无、漂浮、呼吸、弹跳
- 像素风缩放（保持像素边缘锐利）
- 可选择是否仍在皮肤旁显示待办数

约束（与 §5.1「尽量低视觉干扰、空闲状态保持轻量」一致）：

- 默认外观不带任何持续动画；循环播放与附加动效只在用户主动选择后启用，并提示会增加耗电。
- 系统开启「减少动态效果」时只显示静态首帧。
- 无论外观如何，徽标始终能读出「今天还剩 N 项待办」（含读屏）。
- 外观与皮肤属于用户数据，随备份导出与恢复。

---

# 6. 手动创建

拖拽并不是唯一入口。

Nivlo 必须同时支持：

```text
Manual
Drop
Automatic
```

## 6.1 悬浮窗快速创建

Hover 面板底部：

```text
+ Todo
+ Note
+ Tip
```

点击 Todo 后原地创建：

```text
┌────────────────────────────┐
│ New Todo                   │
│                            │
│ Fix login timeout_         │
│                            │
│ Today · No deadline        │
│                    Enter ↵ │
└────────────────────────────┘
```

原则：

> **先创建，再整理。**

而不是创建前要求填写大量字段。

---

## 6.2 Quick Create

建议支持全局快捷键，例如：

```text
Ctrl + Shift + Space
```

呼出：

```text
┌──────────────────────────────┐
│ +                            │
│                              │
│ 明天下午修复登录超时_         │
│                              │
│ Todo · Tomorrow              │
└──────────────────────────────┘
```

后续可以支持自然语言时间解析。

例如：

```text
明天 Review PR
```

自动转换为：

```text
type = todo
title = Review PR
scheduled_date = tomorrow
```

---

## 6.3 主应用完整创建

Workspace 内提供完整编辑：

```text
Todo

Title
完成 Jira 登录改造

Description
...

Scheduled
Sep 29

Due
Oct 2

Priority
High

Project
Agent Infra

Tags
backend / jira

Source
Optional
```

因此创建分为：

```text
Quick Create
→ 快速捕获

Full Create
→ 完整编辑
```

---

# 7. Drag & Drop Capture

Drag & Drop 是 Nivlo 的核心交互之一。

支持拖入：

- URL
- 文件
- 文件夹
- 文本
- 图片
- 浏览器页面
- Jira
- GitHub Issue / PR
- PDF
- Word
- Markdown
- 代码文件

例如：

```text
Browser
   │
   │ drag
   ▼
Floating Window
   │
   ▼
Workflow
   │
   ▼
Todo / Note / Tip
```

Windows 实现说明：从资源管理器拖入文件 / 文件夹需要磁盘路径，HTML5 拖放拿不到（见技术架构 §16、ADR-011）。现在由 WebView2 把拖入的文件交给宿主取路径（实施计划 10.1）：文件、多个文件、文件夹都可以直接拖入，已用真实的系统拖放自动验证（`drop-matrix.md`）；只有在取不到路径时（例如不在 WebView2 里运行）界面才提示改用「复制 → 在悬浮窗粘贴」。Outlook 附件这类没有磁盘文件的拖放还不支持。

---

# 8. Quick Shelf / Inbox

不是所有拖入内容都应该立即变成 Todo。

部分内容需要先暂存。

因此建议引入一个轻量 Quick Shelf / Inbox：

```text
┌──────────────────────────┐
│ Inbox                    │
│                          │
│ 🔗 JIRA-183              │
│ 📄 requirement.pdf       │
│ 📝 修改重试机制           │
│                          │
│ [Create Todo] [Note]     │
└──────────────────────────┘
```

核心理念：

> **Capture first, organize later.**

Inbox 是整个产品的重要中间层。

---

# 9. Capture Workflow

这是 Nivlo 最重要的差异化能力之一。

Workflow 用于定义：

> 某类输入应该如何被识别、解析、转换以及处理。

基本 Pipeline：

```text
Dropped Object
      ↓
   Matcher
      ↓
  Extractor
      ↓
 Transformer
      ↓
   Action
```

更完整可以发展为：

```text
Input
↓
Matcher
↓
Extractor
↓
Processor
↓
Script
↓
AI
↓
Action
```

---

# 10. Workflow Matcher

Matcher 决定：

> 什么输入应该执行这个 Workflow？

支持匹配：

### URL

```text
url.host
url.path
url.query
```

例如：

```text
*.atlassian.net/browse/*
```

### File

```text
file.name
file.extension
file.path
file.mime
```

例如：

```text
REQ-*.docx
PRD-*.pdf
meeting-*.md
```

### Source

```text
source.application
```

例如：

```text
source.application == Chrome
AND
url.host == jira.company.com
```

### Text

支持：

```text
contains
regex
prefix
suffix
```

---

# 11. Jira 默认 Workflow

Jira 可以作为 Nivlo 最有代表性的官方 Workflow。

拖入：

```text
https://company.atlassian.net/browse/AI-128
```

自动提取：

- Issue Key
- Title
- Description
- Status
- Priority
- Assignee
- Start Date
- Due Date
- Labels
- Project
- URL

最终生成：

```text
☐ [AI-128] Add model retry mechanism

Description
--------------------------------
模型请求失败以后需要……

Source
--------------------------------
Jira · AI-128

Status
In Progress

Priority
High

Start
2026-09-25

Due
2026-10-10
```

建议 Jira 数据获取按以下方式降级：

```text
Jira API
↓
Page Metadata
↓
URL + Page Title
```

即使用户未配置 Jira API，也能完成基本捕获。

---

# 12. Custom JavaScript

Workflow 支持 JavaScript 动态脚本。

但 JS 不应该成为 Workflow 的唯一方式。

推荐结构：

```text
声明式 Workflow
+
可选 Custom JavaScript
```

例如：

```js
export default function transform(input) {
  return {
    title: `[${input.key}] ${input.title}`,
    content: input.description,
    dueDate: input.dueDate,
    tags: ["jira", input.project.toLowerCase()]
  };
}
```

---

## 12.1 Script Context

建议提供稳定 Script API：

```js
export default async function(ctx) {
  // ...
}
```

例如：

```js
ctx.input
ctx.source
ctx.metadata
ctx.http
ctx.item
ctx.utils
```

URL：

```js
ctx.input = {
  type: "url",
  value: "https://jira.xxx.com/browse/APP-1024"
}
```

File：

```js
ctx.input = {
  type: "file",
  name: "REQ-1024-login.pdf",
  path: "D:/Downloads/REQ-1024-login.pdf",
  extension: ".pdf",
  mime: "application/pdf"
}
```

最终返回标准 Item。

---

## 12.2 Script Sandbox

Custom JS 必须运行在 Sandbox 中。

默认禁止：

```text
Filesystem
Process
Shell
Arbitrary Network
```

按权限开放：

```text
Permissions

[x] Network
    *.atlassian.net

[ ] File Read
[ ] File Write
[ ] Clipboard
[ ] Shell
```

避免 Workflow 变成任意代码执行入口。

---

# 13. Workflow Node

未来 Workflow 可以发展为节点组合：

```text
Match
↓
Fetch
↓
Extract
↓
Regex
↓
JSON Parse
↓
JavaScript
↓
AI
↓
Condition
↓
Create Todo
↓
Notify
```

可提供节点：

- HTTP Request
- Regex
- JSON Parse
- JavaScript
- AI
- Condition
- Create Todo
- Create Note
- Create Tip
- Add Tag
- Copy File
- File Reference
- Webhook
- Open URL
- Notify

这样 Nivlo 会逐渐拥有一个：

> **围绕 Desktop Capture 的轻量自动化引擎**

---

# 14. 默认 Workflow Pack

首次安装应默认提供官方 Workflow，而不是空白编辑器。

建议：

### Jira Issue

```text
Jira URL
→ Todo
```

### GitHub Issue / PR

```text
GitHub URL
→ Todo
```

### 普通网页

```text
URL
→ Note
```

### PDF / Word

```text
File
→ Note
```

### Screenshot

```text
Image
→ Note
```

可选：

```text
OCR
```

### Downloads

```text
Downloads/*
→ 创建“处理 xxx” Todo
```

### Meeting

```text
meeting-*.md
→ Note
```

### Requirements

```text
REQ-*
PRD-*
→ Todo / Note
```

用户可以：

```text
Duplicate
↓
Customize
```

---

# 15. Workflow Marketplace

Workflow 应支持导出。

例如：

```text
jira.workflow.json
```

未来可以形成 Workflow Gallery：

- Jira Capture
- GitHub Capture
- Linear Capture
- Notion Capture
- Figma Capture
- YouTube Capture
- arXiv Capture

社区可共享 Workflow。

---

# 16. Item 模型

Todo / Note / Tip 建议基于统一 Item 模型。

```text
Item
├── id
├── type
├── title
├── content
├── status
├── scheduled_date
├── due_date
├── reminder
├── priority
├── project
├── tags
├── source
├── attachments
├── created_at
├── updated_at
└── metadata
```

---

# 17. Todo / Note / Tip

## Todo

代表：

> 我要做。

拥有：

- status
- scheduled_date
- due_date
- priority
- reminder

---

## Note

代表：

> 我要记住。

主要用于：

- 信息
- 想法
- 文档
- 网页
- 文件引用

---

## Tip

Tip 是一个值得保留的独立概念。

代表：

> 我在某个时间需要知道。

例如：

```text
💡 今天服务器维护
💡 Jira Sprint ends
💡 Alice on leave
```

Tip 不需要完成。

其本质是：

> **具有时间属性的轻量信息。**

---

# 18. Source

每个 Item 应天然支持 Source。

例如：

```text
Source Type
Jira

Source App
Chrome

Source URL
https://...

Captured At
...

Original Title
...
```

Source 是 Nivlo 相比传统 Todo 产品的重要区别。

任务不是凭空产生，而是保留它来自哪里。

---

# 19. 文件处理

拖入文件不应该默认复制。

建议优先使用：

```text
Reference
```

例如：

```text
D:\projects\xxx\design.md
```

保存为文件引用。

可配置行为：

```text
保存文件引用
创建 Todo
创建 Note
复制文件
创建提醒
执行自定义 Workflow
```

避免 Nivlo 演变为文件管理器。

---

# 20. Calendar

Calendar 是 Nivlo 规划未来事项的核心视图。

主导航建议：

```text
Inbox
Today
Calendar
Notes
Projects
```

Calendar 支持查看：

- Todo
- Tip
- Scheduled Item
- Due Item

---

## 20.1 Scheduled Date 与 Due Date

必须明确区分：

### Scheduled Date

> 我计划什么时候做。

### Due Date

> 最晚什么时候必须完成。

例如：

```text
Fix payment bug

Scheduled
Sep 29

Due
Oct 2
```

Calendar 主要基于 Scheduled Date 进行日程管理。

---

## 20.2 Calendar Drag

可以直接：

```text
Inbox Todo
↓ drag
Sep 30
```

即：

```text
scheduled_date = Sep 30
```

日期之间拖动则修改计划日期。

---

# 21. Todo 排序与执行

Today Todo 支持自由排序。

例如：

```text
≡ Todo A
≡ Todo B
≡ Todo C
```

拖动后立即持久化顺序。

需要区分：

```text
Today Order
Project Order
```

---

# 22. 延期操作

悬浮面板可以支持：

```text
Inbox
Today
Tomorrow
Later
```

例如：

```text
Today Todo
↓ drag
Tomorrow
```

自动修改：

```text
scheduled_date = tomorrow
```

用户无需进入完整编辑器。

---

# 23. 主应用结构

主应用建议保持克制：

```text
┌─────────────────────────────────────────────┐
│ Inbox   Today   Calendar   Notes   Projects │
├──────────────┬──────────────────────────────┤
│ Today        │ □ Fix login timeout          │
│ Inbox    4   │ □ Review PR                  │
│              │                              │
│ Projects     │ Notes                        │
│ Work         │ API design idea              │
│ Personal     │                              │
│              │                              │
│ Tags         │                              │
│ #jira        │                              │
│ #github      │                              │
└──────────────┴──────────────────────────────┘
```

MVP 不建议加入：

- Gantt
- Habit
- Pomodoro
- Team Chat
- Full Project Management
- Heavy Kanban

避免产品失焦。

---

# 24. AI 定位

AI 不应作为产品第一主卖点。

AI 应作为 Workflow Processor。

例如：

```text
Capture
↓
Extract
↓
AI Interpret
↓
Workflow
↓
Item
```

使用场景：

### PDF

```text
20 页 Requirement
↓
AI
↓
提取 Action Items
```

### Jira

```text
Jira Description
↓
AI Summary
↓
生成简化 Todo
```

### Screenshot

```text
Image
↓
OCR
↓
AI
↓
Note / Todo
```

AI 的核心职责：

> **Information → Action**

---

# 25. 竞品分析

Nivlo 不是单一品类产品，因此竞品需要分多个方向。

| 产品 | 核心优势 | Nivlo 可借鉴 | Nivlo 差异 |
|---|---|---|---|
| Todoist | Todo / Quick Add | 快速任务创建 | 缺少桌面 Drag Capture |
| TickTick | Todo / Calendar / Reminder | 日程体系 | Capture 不够强 |
| Microsoft Sticky Notes | 桌面便签 | 极低记录成本 | Todo / Workflow 弱 |
| Superlist | Task + Content | 内容统一 | 桌面悬浮入口弱 |
| Dropover | Drag & Drop Shelf | 拖拽体验 | 不理解任务语义 |
| Raycast | Action / Plugin | Extension 与 Action | 非持续悬浮工作台 |
| Notion | Information | 数据组织 | Capture 成本高 |

Nivlo 更接近：

```text
Dropover
+
Todoist
+
Sticky Notes
+
Raycast
+
Calendar
```

但核心必须保持自己的差异：

```text
Desktop Capture
+
Programmable Workflow
+
Today Stack
+
Calendar
```

---

# 26. 核心用户场景

## 场景一：Jira

```text
浏览 Jira
↓
拖入 Nivlo
↓
Workflow 自动解析
↓
生成 Todo
↓
Today / Calendar
```

---

## 场景二：临时想法

```text
想到一件事
↓
Hover
↓
+ Todo
↓
Enter
```

整个过程控制在数秒内。

---

## 场景三：文件

```text
收到 requirement.pdf
↓
拖入悬浮窗
↓
Workflow
↓
创建 Note
↓
保存文件引用
```

---

## 场景四：当天执行

```text
Hover
↓
查看 Today
↓
调整 Todo 顺序
↓
直接完成
```

---

## 场景五：未来计划

```text
进入 Calendar
↓
把 Inbox Todo 拖到具体日期
↓
安排未来工作
```

---

# 27. 产品体验原则

## 27.1 Capture < 1 Second

最重要的目标之一：

> Capture 尽量控制在 1 秒级体验。

避免：

```text
Drop
↓
弹窗
↓
选类型
↓
选项目
↓
选标签
↓
确认
```

推荐：

```text
Drop
↓
Created ✓
```

然后提供：

```text
Undo
Edit
```

即：

> **先做，再 Undo。**

---

## 27.2 Capture First

用户不应该先考虑：

- 应该放哪个项目
- 应该是什么类型
- 应该加什么 Tag

先捕获，再整理。

---

## 27.3 Local First

核心数据优先本地保存。

后期再提供：

- Sync
- Integration
- Cloud Backup

---

## 27.4 Lightweight

桌面常驻软件必须做到：

- 内存占用可控
- 启动快
- 动画稳定
- 不干扰用户
- 长时间运行可靠

---

# 28. MVP

第一版严格控制范围。

## 必须有

### Floating Window

- 桌面悬浮
- Hover Today
- Click Workspace
- 拖动
- 吸附
- 置顶

### Todo

- Create
- Complete
- Schedule
- Reorder
- Due Date

### Note

- 快速记录
- 基本编辑

### Tip

- 创建
- 日期
- Calendar 展示

### Inbox

- Capture
- Organize Later

### Drag & Drop

- URL
- File
- Text

### Workflow

- URL Matcher
- File Matcher
- Create Todo
- Create Note
- Create Tip
- 简单字段映射

### Built-in Workflow

- Jira
- GitHub
- Web Page
- PDF
- File

### Calendar

- Month / Week 基础视图
- Todo
- Tip
- Drag Schedule

---

# 29. 版本规划

## MVP — Desktop Capture

```text
Floating Window
Drag
Manual Create
Inbox
Todo
Note
Tip
Today
Calendar
Basic Workflow
```

目标：

> 完成 Capture → Schedule → Execute 的基础闭环。

---

## V1 — Smart Capture

加入：

- Page Metadata
- Jira
- GitHub
- File Recognition
- Natural Language Date
- Shortcut
- Better Workflow

---

## V2 — Programmable Capture

加入：

- Custom JavaScript
- Workflow Nodes
- Permission System
- Workflow Import / Export
- Workflow Gallery

---

## V3 — Integration

加入：

- Jira API
- GitHub
- Calendar
- Email
- Slack
- Browser Extension
- Webhook

---

## V4 — Intelligent Workflow

加入：

- AI Processor
- AI Extraction
- AI Summary
- AI Classification
- Action Extraction

---

## V5 — Personal Workflow Runtime

最终发展为：

```text
Capture
+
Workflow
+
Integration
+
Script
+
AI
+
Plugin
```

形成：

> **个人桌面工作流运行环境。**

---

# 30. 产品能力地图

```text
                       Nivlo · 拾序

                           │
        ┌──────────────────┼───────────────────┐
        │                  │                   │
     Capture            Workflow             Plan
        │                  │                   │
 ┌──────┼──────┐     ┌─────┼──────┐      ┌─────┼─────┐
 │      │      │     │     │      │      │     │     │
Manual Drag   Paste Match Extract Script Today Calendar
 │      │      │                    │
 └──────┴──────┴───────────┬────────┘
                           │
                          Item
                           │
                 ┌─────────┼─────────┐
                 │         │         │
                Todo      Note      Tip
                 │
                 ▼
              Schedule
                 │
          ┌──────┴──────┐
          ▼             ▼
        Today         Future
          │             │
          ▼             ▼
     Floating       Calendar
      Window
```

---

# 31. 产品核心表达

Nivlo 最终应围绕以下四个核心能力建立认知：

## Capture

> 随时把事情收进来。

## Workflow

> 自动决定如何处理。

## Today

> 今天真正要做什么，一眼就知道。

## Calendar

> 未来的事情，提前安排。

可以进一步形成三条产品语言：

> **Drop anything.**

> **Hover to work.**

> **Plan visually.**

中文可以表达为：

> **随手拾取，自动归序。**

---

# 32. 最终产品定义

**Nivlo · 拾序** 是一款以桌面悬浮窗口为核心入口，通过手动创建、拖拽、粘贴和自动规则捕获网页、文件、文字与想法，并利用可编程 Workflow 将其转化为 Todo、Note 或 Tip，再通过 Today Stack 与 Calendar 完成每日执行和未来规划的本地优先个人工作台。

它不只是一个 Todo 软件。

也不只是一个便签软件。

更准确地说：

> **Nivlo 是一个可编程的桌面信息捕获与个人行动管理系统。**
