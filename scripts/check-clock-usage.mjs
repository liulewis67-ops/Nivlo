// 断言业务代码不直接读取系统时间（实施计划 0.4）：只有 Clock 实现允许调用。
import { execFileSync } from "node:child_process";

const out = execFileSync(
  "git",
  ["grep", "-nE", "Local::now|Utc::now|SystemTime::now", "--", "crates/**/*.rs", "apps/**/*.rs"],
  { encoding: "utf8" },
).split("\n").filter(Boolean);
const offenders = out.filter((line) => !line.startsWith("crates/asterjot-common/src/clock.rs"));
if (offenders.length > 0) {
  console.error("✗ 以下位置直接读取了系统时间，请改用 Clock：\n" + offenders.join("\n"));
  process.exit(1);
}
console.log("✓ 未发现直接读取系统时间的业务代码");
