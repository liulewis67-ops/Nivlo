# StarAt

**Everything starts here.**

Turn scattered information into action.

把零散信息变成下一步。为 Windows 打造的个人收集与行动工作台，使用 Tauri 2、Rust 与 React。

[产品介绍](https://liulewis67-ops.github.io/StarAt/) · [下载](https://github.com/liulewis67-ops/StarAt/releases/download/v0.1.5/StarAt_0.1.5_x64-setup.exe) · [发布说明](docs/development/releases/v0.1.5.md)

拖入链接、文字或文件，在收件箱整理为待办、笔记和提示，再用今日与日历安排处理。数据默认保存于本机；可配置捕获工作流和外部集成。

## 开发

需要 Node.js 22+、pnpm 11.1.3、Rust 1.95.0 和 Windows Tauri 构建环境。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

[开发文档](docs/development/README.md) · [发布与自动更新](docs/development/release.md) · [变更记录](CHANGELOG.md)

## 发布

首次发布可在有 GitHub 推送权限的 PowerShell 中运行：

```powershell
./scripts/release/publish.ps1
```

脚本只提交本次发布所需的文件，保留本地提交历史，推送 `main` 与 `v0.1.0`，不覆盖已有的不同版本标签。

推送新的版本标签（如 `v0.1.1`）触发 Windows x64 安装包构建和 GitHub Release 发布。配置 `TAURI_SIGNING_PRIVATE_KEY` 后额外发布签名与更新清单；没有该密钥仍可发布安装包，但不提供应用内更新清单。

宣传页在 `apps/landing`，推送到 `main` 自动部署到 GitHub Pages。首次需要在仓库 Settings → Pages → Build and deployment 中选择 **GitHub Actions**。

本版本尚无 Windows Authenticode 签名证书，安装时可能显示发布者未知。

## 开源协议

StarAt采用 [Apache License 2.0](LICENSE) 开源，许可声明同时适用于已发布的 **v0.1.0** 源码与 StarAt 自身的二进制程序。可在遵守许可证条款的前提下使用、修改和分发。

Copyright 2026 liulewis67-ops and StarAt contributors. 版权与归属声明见 [NOTICE](NOTICE)。第三方依赖遵循各自的许可证。
