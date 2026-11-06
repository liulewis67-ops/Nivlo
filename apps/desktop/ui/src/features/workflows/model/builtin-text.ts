import i18next from "i18next";

/** 内置 Workflow 的英文名称与说明，按 ID（去掉 `builtin.` 前缀）索引。 */
const BUILTIN_EN: Readonly<Record<string, { name: string; description: string }>> = {
  "file-document": {
    name: "Documents (Markdown / PDF / Office and more)",
    description:
      "Dropped documents (several at once is fine) each become a note. The title comes from the document itself: the first Markdown heading; the title property of PDF, Word, PowerPoint, Excel, OpenDocument and EPUB files; the page title of HTML files. It falls back to the file name, and other files dropped alongside are named after the file. Only a reference to the file is kept; reading the title touches only a small part of the file, so big files stay fast.",
  },
  "file-meeting": {
    name: "Meeting notes (meeting-*.md)",
    description:
      "Markdown files named like meeting-2026-10-11.md become notes tagged meeting, titled with the document's first heading.",
  },
  "file-requirements": {
    name: "Requirement docs (REQ-* / PRD-*)",
    description:
      "Files whose names start with REQ- or PRD- become a to-do “Handle <file name>”, keeping a reference to the file.",
  },
  "generic-file": {
    name: "Files",
    description:
      "Each captured file (several at once is fine) becomes a note. Only a reference is kept; the file is not copied.",
  },
  "generic-image": {
    name: "Images",
    description:
      "Captured images (such as pasted screenshots) become notes with the image saved as an attachment.",
  },
  "generic-text": {
    name: "Text",
    description:
      "Captured text becomes a to-do: the first line is the title, multi-line text goes into the description, and it waits in the Inbox to be sorted.",
  },
  "generic-url": {
    name: "Web links",
    description:
      "Captured URLs become notes titled “domain/path”, with the URL in the content, waiting in the Inbox to be sorted.",
  },
  "github-issue": {
    name: "GitHub Issue",
    description:
      "github.com issue links become a to-do “[repo#123] Title”. It is created right away with the number, then the title is read in the background from GitHub's public API, falling back to the page title (or just the number) when rate-limited or unavailable. With GitHub connected under Integrations, the authenticated API also reads state, labels, assignees and milestone, including private repositories.",
  },
  "github-pr": {
    name: "GitHub Pull Request",
    description:
      "github.com pull request links become a to-do “Review PR #182: Title”. It is created right away with the number, then the title is read in the background from GitHub's public API, falling back to the page title (or just the number) when rate-limited or unavailable. With GitHub connected under Integrations, the authenticated API also reads state, labels, assignees and milestone, including private repositories.",
  },
  "jira-issue": {
    name: "Jira issue",
    description:
      "Jira /browse/KEY-123 links become a to-do “[KEY-123] Title”. With Jira connected under Integrations, the API reads title, status, assignee and due date; without a connection, with expired credentials or on errors it falls back to the page title, then the issue key alone, and the to-do is always created. Self-hosted / intranet Jira is recognized too (intranet hosts must be connected first).",
  },
  "web-page": {
    name: "Web pages (fill in title and summary)",
    description:
      "A URL becomes a note right away; the page title and summary are read in the background and filled in. If that fails or you're offline, the note keeps its “domain/path” title.",
  },
};

/**
 * 在当前界面语言下显示的 Workflow 名称与说明。
 *
 * 内置 Workflow 只读、ID 稳定：英文界面用上面的译文；中文界面与其他来源（用户自建、导入、复制）
 * 原样显示定义里写的文字——它们是用户的内容，中文原文也只维护在 `workflows/builtin/*.json` 一处。
 *
 * @param workflow ID、来源、名称与说明。
 * @returns 要显示的名称与说明。
 */
export function workflowText(workflow: {
  id: string;
  source: string;
  name: string;
  description: string;
}): { name: string; description: string } {
  const prefix = "builtin.";
  const original = { name: workflow.name, description: workflow.description };
  if (workflow.source !== "builtin" || !workflow.id.startsWith(prefix)) return original;
  if (!i18next.language.startsWith("en")) return original;
  return BUILTIN_EN[workflow.id.slice(prefix.length)] ?? original;
}
