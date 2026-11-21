import { useTranslation } from "react-i18next";
import { cx } from "@/lib/cx";
import { useProjectsQuery } from "./api";

/** [`ProjectSelect`] 的 Props。 */
export type ProjectSelectProps = {
  /** 当前所属项目的 ID；空串表示没有项目。 */
  value: string;
  /** 选择了另一个项目（空串表示「无项目」）。 */
  onChange: (projectId: string) => void;
};

/**
 * 选择条目所属的项目。
 *
 * 只列出未归档的项目；如果条目当前所属的项目已被归档（或已不存在），仍然把它作为当前值显示出来，
 * 这样用户看得到它在哪，也不会因为打开面板而被悄悄改掉。
 *
 * @param props 当前值与回调。
 * @returns 下拉选择。
 */
export function ProjectSelect({ value, onChange }: ProjectSelectProps) {
  const { t } = useTranslation();
  const projects = useProjectsQuery().data ?? [];
  const known = value === "" || projects.some((project) => project.id === value);
  return (
    <select
      aria-label={t("detail.field.project")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cx(
        "h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-text",
        "transition-colors duration-(--nv-duration-fast) ease-(--nv-ease-standard)",
        "focus-visible:border-primary focus-visible:outline-none",
      )}
    >
      <option value="">{t("detail.project.none")}</option>
      {!known && <option value={value}>{t("detail.project.missing")}</option>}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
