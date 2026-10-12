# 发布与自动更新（Windows）

## 构成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 安装包 | `pnpm tauri build` → `target/release/bundle/nsis/Nivlo_<版本>_x64-setup.exe` | NSIS，**当前用户安装**（不需要管理员权限），中 / 英文安装界面 |
| 更新包签名 | 同目录 `*.exe.sig` | minisign 签名；公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey` |
| 更新清单 | `latest.json`（`scripts/release/make-latest-json.mjs` 生成） | 版本、说明、各平台的下载地址与签名 |
| 更新端点 | `tauri.conf.json` → `plugins.updater.endpoints` | **目前是占位地址 `REPLACE-WITH-YOUR-UPDATE-HOST`，发布前必须改成真实地址** |
| 自动发布 | `.github/workflows/release.yml` | 打 `v*` Tag 触发；尚未在真实仓库上运行过 |

## 密钥

* **更新签名私钥**：`pnpm tauri signer generate -w <路径>` 生成，**丢失后无法再给已安装的用户推送更新**。
  不要提交到仓库；CI 里放进 Secret `TAURI_SIGNING_PRIVATE_KEY`（密码放 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，没有则留空）。
  本机开发用的密钥在 `%USERPROFILE%\.nivlo-keys\`——**正式发布请重新生成一对**，把新公钥写进 `tauri.conf.json`。
* **代码签名证书（Authenticode）**：用来让 Windows SmartScreen 信任安装包，与更新签名是两回事。
  需要购买证书（OV / EV 或 Azure Trusted Signing），在 `bundle.windows.signCommand` 或 CI 里配置；**当前没有配置，安装包是未签名的**。

## 本地发布流程

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.nivlo-keys\updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
node scripts/release/make-latest-json.mjs --version 0.1.1 --base-url https://<host>/nivlo
# 把 *-setup.exe 与 latest.json 上传到 <host>/nivlo/
```

版本号在 `apps/desktop/src-tauri/tauri.conf.json` 的 `version` 修改（更新器比较的是它），并更新 `CHANGELOG.md`。

## 更新过程

1. 启动 8 秒后静默检查一次（离线或端点不可用时不打扰用户）；设置页「关于 → 检查更新」可手动检查。
2. 点「安装并重启」：先为当前数据做一份备份（`nivlo-before-update-*.zip`，在导出目录），备份失败则**不升级**；
   然后下载、校验签名（不对则拒绝，当前版本不变）、以 passive 模式运行安装包，完成后重启。
3. 用户数据在 `%APPDATA%` 下的数据目录里，与安装目录分离：安装 / 升级 / 卸载都不会删除它。

## 本地端到端测试

`tauri.test-update.conf.json` 把端点指到 `http://127.0.0.1:8765/latest.json` 并允许 http，仅用于本机测试：

```powershell
pnpm tauri build --config apps/desktop/src-tauri/tauri.test-update.conf.json
```
