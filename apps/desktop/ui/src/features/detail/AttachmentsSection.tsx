import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { ipc } from "@/lib/ipc";
import type { AttachmentDto, InboxEntryDto } from "@/lib/ipc";
import { errorMessage } from "@/lib/error-message";
import { toAppError } from "@/lib/errors";
import { reportError } from "@/lib/report-error";

/** 仅在用户选择附件后读取，切换附件时独立挂载，避免旧内容覆盖当前预览。 */
function AttachmentPreview({
  id,
  index,
  attachment,
}: {
  id: string;
  index: number;
  attachment: AttachmentDto;
}) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  const query = useQuery({
    queryKey: ["attachment-preview", id, index, attachment.path],
    queryFn: () => ipc.previewItemAttachment(id, index),
    meta: { errorPresentation: "inline" },
    retry: false,
    gcTime: 0,
  });
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted">
        {t("attachments.loading")}
      </p>
    );
  if (query.isError)
    return (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-sm text-danger">
          {errorMessage(toAppError(query.error))}
        </p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("attachments.retry")}
        </Button>
      </div>
    );
  if (query.data.kind === "image")
    return imageFailed ? (
      <p role="alert" className="text-sm text-danger">
        {t("attachments.imageFailed")}
      </p>
    ) : (
      <img
        src={query.data.url}
        alt={attachment.name}
        className="mx-auto max-h-96 max-w-full object-contain"
        onError={() => setImageFailed(true)}
      />
    );
  if (query.data.kind === "text")
    return (
      <pre className="max-h-96 overflow-auto font-mono text-sm whitespace-pre-wrap break-words select-text">
        {query.data.content}
      </pre>
    );
  return <p className="text-sm text-muted">{t("attachments.unavailable")}</p>;
}

/** 已关联文件的只读列表与预览；不提供更改、覆盖或删除原文件的操作。 */
export function AttachmentsSection({ detail }: { detail: InboxEntryDto }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null>(null);
  if (detail.attachments.length === 0) return null;
  const attachment = selected === null ? undefined : detail.attachments[selected];
  return (
    <section aria-label={t("attachments.label")} className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium">{t("attachments.label")}</h3>
      <ul className="flex min-w-0 flex-col gap-2">
        {detail.attachments.map((file, index) => (
          <li
            key={`${index}:${file.path}`}
            className="min-w-0 rounded-md border border-border bg-bg p-3"
          >
            <p className="text-sm break-all">{file.name}</p>
            <p className="mt-1 text-xs break-all text-muted">{file.path}</p>
            {!file.exists && <p className="mt-1 text-xs text-danger">{t("inbox.missingFile")}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!file.exists}
                aria-label={t("attachments.viewNamed", { name: file.name })}
                aria-expanded={selected === index}
                onClick={() => setSelected(selected === index ? null : index)}
              >
                {t("attachments.view")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!file.exists}
                aria-label={t("attachments.revealNamed", { name: file.name })}
                onClick={() =>
                  void ipc.revealItemAttachment(detail.item.id, index).catch(reportError)
                }
              >
                {t("detail.source.reveal")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {attachment !== undefined && selected !== null && (
        <section
          aria-label={t("attachments.previewNamed", { name: attachment.name })}
          className="min-w-0 rounded-md border border-border bg-bg p-3"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="text-sm font-medium break-all">{attachment.name}</h4>
              <p className="text-xs text-muted">{t("attachments.readOnly")}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              {t("attachments.close")}
            </Button>
          </div>
          <AttachmentPreview
            key={`${selected}:${attachment.path}`}
            id={detail.item.id}
            index={selected}
            attachment={attachment}
          />
        </section>
      )}
    </section>
  );
}
