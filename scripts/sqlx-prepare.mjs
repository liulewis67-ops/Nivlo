// 生成或校验 SQLx 离线查询元数据（`.sqlx/`，实施计划 0.6）。
// 用法：
//   node scripts/sqlx-prepare.mjs          # 重新生成并写入 .sqlx/
//   node scripts/sqlx-prepare.mjs --check  # 校验 .sqlx/ 与当前查询一致（CI 使用）
// 做法：在 target/ 下创建一个临时数据库，应用 migrations/，再调用 `cargo sqlx prepare`。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const check = process.argv.includes("--check");
const dbDir = path.resolve("target", "sqlx-dev");
const dbFile = path.join(dbDir, "starat-dev.db");
fs.mkdirSync(dbDir, { recursive: true });
for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(dbFile + suffix, { force: true });

// 编译期校验需要在线数据库，因此必须关闭离线模式。
const env = { ...process.env, DATABASE_URL: `sqlite:${dbFile.replaceAll("\\", "/")}`, SQLX_OFFLINE: "false" };
const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: "inherit" });

run("cargo", ["sqlx", "database", "create"]);
run("cargo", ["sqlx", "migrate", "run", "--source", "migrations"]);
run("cargo", ["sqlx", "prepare", ...(check ? ["--check"] : []), "--workspace", "--", "--all-targets"]);
