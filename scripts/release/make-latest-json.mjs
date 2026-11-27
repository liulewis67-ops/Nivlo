#!/usr/bin/env node
// 生成 Tauri Updater 的清单 latest.json（实施计划 7.6）。
//
// 用法：
//   node scripts/release/make-latest-json.mjs --version 0.1.1 --base-url https://host/starat \
//        [--notes "说明" | --notes-file docs/development/releases/v0.1.1.md]
//        [--bundle-dir target/release/bundle/nsis] [--out latest.json]
//
// 读取 bundle 目录里的 `<name>_<version>_x64-setup.exe` 与它的 `.sig`（由 `pnpm tauri build` 在设置了
// TAURI_SIGNING_PRIVATE_KEY 时生成），输出 windows-x86_64 平台的清单。签名内容原样写入。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 读取 `--name value` 形式的参数。 */
function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const version = arg("version");
const baseUrl = arg("base-url");
if (!version || !baseUrl) {
  console.error("需要 --version 与 --base-url");
  process.exit(2);
}
const dir = arg("bundle-dir", "target/release/bundle/nsis");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("版本号必须为 x.y.z");
const url = new URL(baseUrl);
if (url.protocol !== "https:" || url.search || url.hash) throw new Error("下载地址必须为无查询参数的 HTTPS 地址");
const installers = readdirSync(dir).filter((f) => f.endsWith(`_${version}_x64-setup.exe`));
if (installers.length !== 1) throw new Error(`在 ${dir} 里需要恰好一个版本 ${version} 的 x64 安装包`);
const [installer] = installers;
const signature = readFileSync(join(dir, `${installer}.sig`), "utf8").trim();
const decoded = Buffer.from(signature, "base64").toString("utf8");
if (!decoded.startsWith("untrusted comment:") || !decoded.includes("\ntrusted comment:")) {
  throw new Error("更新签名为空或格式不正确");
}
const manifest = {
  version,
  notes: arg("notes-file") ? readFileSync(arg("notes-file"), "utf8").trim() : arg("notes", `StarAt ${version}`),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(installer)}`,
    },
  },
};
writeFileSync(arg("out", "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`已生成 ${arg("out", "latest.json")}：${version} → ${installer}`);
