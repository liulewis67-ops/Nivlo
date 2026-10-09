// 检查 docs/ 与根目录 Markdown 中的相对链接是否指向存在的文件。
import fs from "node:fs";
import path from "node:path";

/** 递归收集目录下的 .md 文件。 */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "target", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

let broken = 0;
for (const file of collect("docs")) {
  // 去掉围栏代码块，避免把示例当作链接。
  const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (target === "" || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      console.error(`✗ ${file}: 链接失效 -> ${match[1]}`);
      broken++;
    }
  }
}
if (broken > 0) process.exit(1);
console.log("✓ 文档内部链接有效");
