# 发布与自动更新（Windows）

## 构成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 安装包 | `pnpm tauri build` → `target/release/bundle/nsis/Nivlo_<版本>_x64-setup.exe` | NSIS，**当前用户安装**（不需要管理员权限），中 / 英文安装界面 |
| 更新包签名 | 同目录 `*.exe.sig` | minisign 签名；公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey` |
| 更新清单 | `latest.json`（`scripts/release/make-latest-json.mjs` 生成） | 版本、说明、各平台的下载地址与签名 |
| 更新端点 | `tauri.conf.json` → `plugins.updater.endpoints` | `https://github.com/liulewis67-ops/Nivlo/releases/latest/download/latest.json` |
| 自动发布 | `.github/workflows/release.yml` | 打 `v*` Tag 触发，也可手动从 `main` 指定版本发布并创建 Tag；没有更新签名密钥时仅发布安装包 |

## 密钥

GitHub Actions 未配置更新签名密钥时，构建会关闭更新产物生成，但保留客户端的签名验证，发布安装包与 SHA256 校验文件，不生成 `latest.json`。如需应用内自动更新，发布前配置与客户端公钥对应的私钥及可选密码。流水线先上传到草稿 Release，全部成功后再公开，已公开的同版本产物不会被重跑覆盖。

## GitHub Pages

宣传页位于 `apps/landing`，无需 npm 构建。仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。之后推送 `main` 上的宣传页改动会触发 `.github/workflows/pages.yml`，也可以手动运行。

部署目标：<https://liulewis67-ops.github.io/Nivlo/>。下载按钮直接指向 0.1.1 的 GitHub Release 安装包文件，发布后检查中英文页面、深浅主题、交互演示与安装包下载。

* **更新签名私钥**：`pnpm tauri signer generate -w <路径>` 生成，**丢失后无法再给已安装的用户推送更新**。
  不要提交到仓库；CI 里放进 Secret `TAURI_SIGNING_PRIVATE_KEY`（密码放 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，没有则留空）。
  本机开发用的密钥在 `%USERPROFILE%\.nivlo-keys\`——**正式发布请重新生成一对**，把新公钥写进 `tauri.conf.json`。
* **代码签名证书（Authenticode）**：用来让 Windows SmartScreen 信任安装包，与更新签名是两回事。
  需要购买证书（OV / EV 或 Azure Trusted Signing），在 `bundle.windows.signCommand` 或 CI 里配置；**当前没有配置，安装包是未签名的**。

## 本地发布流程

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.nivlo-keys\updater.key"  # 当前 CLI 不认 *_PATH
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
node scripts/release/make-latest-json.mjs --version 0.1.1 --base-url https://<host>/nivlo
# 把 *-setup.exe 与 latest.json 上传到 <host>/nivlo/
```

版本号在 `apps/desktop/src-tauri/tauri.conf.json` 的 `version` 修改（更新器比较的是它），并更新 `CHANGELOG.md`。

## 更新过程

1. 启动 8 秒后静默检查一次（离线或端点不可用时不打扰用户）；设置页「关于 → 检查更新」可手动检查。
2. 点「立即更新」（启动提示或设置页）：先为当前数据做一份备份（`nivlo-before-update-*.zip`，在导出目录），备份失败则**不升级**；
   然后在后台下载、校验签名（不对则拒绝，当前版本不变），以 **quiet** 模式（`/S /UPDATE /R`，`plugins.updater.windows.installMode`）
   运行安装包：**没有任何安装界面或确认框**，原地覆盖，完成后 Nivlo 自动重启。
3. 用户数据在 `%APPDATA%Nivlo` 里，与安装目录分离：安装、升级、卸载都**不会删除**它（`windows/nsis-hooks.nsh`）。
   卸载界面的「删除应用程序数据」只清理 WebView 目录（`%LOCALAPPDATA%app.nivlo.desktop`）。
   要清空数据，用应用内「设置 → 数据 → 删除所有数据」：先自动备份，重启后当前数据挪到 `replaced-<时间>/`，以空库启动。

## 已安装过 Nivlo 时再运行安装包

| 场景 | 行为 |
| --- | --- |
| 应用内更新（`/S /UPDATE /R`） | 无界面；不卸载，覆盖到原安装目录；不动快捷方式与开机自启；完成后重启应用 |
| 手动运行安装包（任何版本，含同版本与降级） | 不出现「是否先卸载」的选择：安装包以 `/P /UPDATE /R` 重新启动自己（`NivloUpgradeInPlace`），只显示进度条，原地覆盖，装完自动启动 Nivlo |
| 全新安装 | 正常的安装向导 |

正在运行的 Nivlo 会通过 Restart Manager 检测到并直接关闭（passive / quiet 模式不提示）。

## 安装包体积

reqwest 只启用 `rustls-no-provider`，加密后端统一用 ring（与更新插件共用），不再链接 aws-lc：
主程序 33.4 MB → 31.9 MB，安装包 7.78 MiB（2026-11-05，NSIS solid LZMA）。

## 本地端到端测试

`tauri.test-update.conf.json` 把端点指到 `http://127.0.0.1:8765/latest.json` 并允许 http，仅用于本机测试：

```powershell
pnpm tauri build --config apps/desktop/src-tauri/tauri.test-update.conf.json
```
