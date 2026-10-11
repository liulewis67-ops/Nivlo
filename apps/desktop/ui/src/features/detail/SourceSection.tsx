import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import type { InboxEntryDto } from "@/lib/ipc";

/** [`SourceSection`] 的 Props。 */
export type SourceSectionProps = {
  /** Item 详情（带来源与附件）。 */
  detail: InboxEntryDto;
  /** 点击「打开」。 */
  onOpen: () => void;
  /** 点击「重新运行规则」。 */
  onRerun: () => void;
};

/**
 * 详情面板里的「来源」：这条内容来自哪里，以及一键回到来源。
 *
 * * 网址：显示完整链接，「在浏览器中打开」；
 * * 文件：显示路径，「在文件夹中显示」；被引用的文件已不在原处时显示「文件不存在」并禁用按钮，
 *   而不是点了才报错；
 * * 没有来源（手动创建）时不显示这一块。
 *
 * 要打开什么由后端根据已保存的来源决定，前端只发出「打开这个条目的来源」。
 *
 * @param props 详情与回调。
 * @returns 来源区块；没有来源时返回 `null`。
 */
export function SourceSection({ detail, onOpen, onRerun }: SourceSectionProps) {
  const { t } = useTranslation();
  const source = detail.sources[0];
  if (source === undefined) return null;
  const reference = detail.attachments.find((attachment) => attachment.kind === "reference");
  const isFile = source.sourceType === "file";
  const missing = isFile && reference !== undefined && !reference.exists;
  const location = source.sourceUrl ?? source.sourcePath ?? reference?.path ?? null;
  return (
    <section
      aria-label={t("detail.source.label")}
      className="flex flex-col gap-2 rounded-md border border-border bg-bg p-3"
    >
      <h3 className="text-xs font-medium text-muted">{t("detail.source.label")}</h3>
      <p className="text-sm text-text">
        {t(`detail.source.type.${source.sourceType}`, { defaultValue: source.sourceType })}
        {source.sourceApp !== null && (
          <span className="text-muted">{` · ${source.sourceApp}`}</span>
        )}
      </p>
      {location !== null && (
        <p className="text-xs break-all text-muted" title={location}>
          {location}
        </p>
      )}
      {missing && (
        <p role="alert" className="text-xs text-danger">
          {t("inbox.missingFile")}
        </p>
      )}
      {(source.sourceUrl !== null || isFile) && (
        <div className="flex gap-2">
          <Button size="sm" disabled={missing} onClick={onOpen}>
            {isFile ? t("detail.source.reveal") : t("detail.source.open")}
          </Button>
          <Button size="sm" variant="secondary" disabled={missing} onClick={onRerun}>
            {t("detail.source.rerun")}
          </Button>
        </div>
      )}
    </section>
  );
}
