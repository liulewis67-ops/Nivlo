// 更新实施计划中某子阶段的状态、验收勾选与完成记录。
// 用法：node scripts/plan-update.mjs <子阶段编号> <状态符号> <完成记录文件>
import fs from "node:fs";

const [, , phase, status, recordFile] = process.argv;
const planPath = "doc/Nivlo_Implementation_Plan.md";
let text = fs.readFileSync(planPath, "utf8");

const start = text.indexOf(`### ${phase} `);
if (start < 0) throw new Error(`找不到子阶段 ${phase}`);
const rest = text.slice(start + 5);
const end = start + 5 + rest.search(/\n(### |# )/) + 1;
let section = text.slice(start, end);
section = section.replace(/- \*\*状态\*\*：\S+/, `- **状态**：${status}`);
section = section.split("- [ ]").join("- [x]");
section = section.replace("- **完成记录**：—", "- **完成记录**：" + fs.readFileSync(recordFile, "utf8").trimEnd());
text = text.slice(0, start) + section + text.slice(end);

// 进度总览表中对应行的最后一列。
text = text
  .split("\n")
  .map((line) => {
    const cells = line.split("|");
    if (cells.length >= 5 && cells[2].trim() === phase && line.startsWith("|")) {
      cells[cells.length - 2] = ` ${status} `;
      return cells.join("|");
    }
    return line;
  })
  .join("\n");
fs.writeFileSync(planPath, text);
