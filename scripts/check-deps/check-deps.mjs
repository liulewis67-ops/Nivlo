// 依赖方向检查（后端规范 §3.1、架构文档 §63）。
// 基于 `cargo metadata` 计算每个 crate 的传递依赖（仅 normal 依赖），
// 断言其中不出现被禁止的 crate。违规时以非零码退出并列出依赖路径。
import { execFileSync } from "node:child_process";

/** 外部技术依赖：只有 Adapter / 宿主可以依赖。 */
const TECH = ["tauri", "sqlx", "reqwest", "rquickjs", "windows"];
const ADAPTERS = [
  "starat-storage",
  "starat-capture",
  "starat-workflow",
  "starat-script",
  "starat-scheduler",
  "starat-integrations",
  "starat-platform-windows",
  "starat-platform-macos",
  "starat-platform-linux",
];

/** 规则表：crate -> 禁止（直接或间接）依赖的 crate 名。 */
const RULES = {
  "starat-common": [...TECH, "starat-domain", "starat-application", "starat-platform", ...ADAPTERS],
  "starat-domain": [...TECH, "tokio", "starat-application", "starat-platform", ...ADAPTERS],
  "starat-application": [...TECH, "starat-platform", ...ADAPTERS],
  "starat-platform": [...TECH, "starat-application", ...ADAPTERS],
};

const metadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
);

/** package id -> name */
const nameOf = new Map(metadata.packages.map((p) => [p.id, p.name]));
/** package id -> 直接 normal 依赖的 package id 列表 */
const edges = new Map(
  metadata.resolve.nodes.map((node) => [
    node.id,
    node.deps
      .filter((d) => d.dep_kinds.some((k) => k.kind === null))
      .map((d) => d.pkg),
  ]),
);

let failed = false;
for (const [crate, forbidden] of Object.entries(RULES)) {
  const root = metadata.packages.find((p) => p.name === crate);
  if (!root) continue;
  // BFS 记录前驱，便于输出完整依赖路径。
  const parent = new Map([[root.id, null]]);
  const queue = [root.id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of edges.get(current) ?? []) {
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  for (const [id] of parent) {
    const name = nameOf.get(id);
    if (forbidden.includes(name)) {
      const path = [];
      for (let cur = id; cur !== null; cur = parent.get(cur)) path.unshift(nameOf.get(cur));
      console.error(`✗ ${crate} 禁止依赖 ${name}：${path.join(" -> ")}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\n依赖方向检查失败，请参见后端规范 §3.1 / 架构文档 §63。");
  process.exit(1);
}
console.log("✓ 依赖方向检查通过");
