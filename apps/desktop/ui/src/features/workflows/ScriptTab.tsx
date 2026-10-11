import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Input } from "@/components";
import { parseDefinition, stringify } from "./model/definition";
import { SCRIPT_TEMPLATE, findScript, parseHosts, withScript, withoutScript } from "./model/script";
import { ScriptEditor } from "./ScriptEditor";
import { CTX_DTS } from "./script-api";

/** [`ScriptTab`] 的 Props。 */
type ScriptTabProps = {
  /** 当前（未保存的）定义 JSON。 */
  text: string;
  /** 写回定义 JSON。 */
  onTextChange: (text: string) => void;
};

/**
 * 「脚本」页签：编辑 Workflow 里的 Script Step——源码（CodeMirror）、脚本要访问的主机、`ctx` API 参考。
 *
 * 脚本的主机会自动并入 Workflow 的 `permissions`（脚本权限必须是它的子集）；
 * 含主机的脚本保存后需要在上方的提示条里确认权限才会运行。
 *
 * @param props 定义 JSON 与回写回调。
 * @returns 页签内容。
 */
export function ScriptTab({ text, onTextChange }: ScriptTabProps) {
  const { t } = useTranslation();
  const definition = parseDefinition(text);
  const script = definition === null ? null : findScript(definition);
  const [hostsText, setHostsText] = useState(() => (script?.hosts ?? []).join(", "));

  if (definition === null) {
    return <p className="text-sm text-muted">{t("workflows.script.invalidJson")}</p>;
  }
  if (script === null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted">{t("workflows.script.none")}</p>
        <Button
          size="sm"
          onClick={() =>
            onTextChange(stringify(withScript(definition, { source: SCRIPT_TEMPLATE, hosts: [] })))
          }
        >
          {t("workflows.script.add")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs font-medium text-muted">{t("workflows.script.hosts")}</span>
        <Input
          value={hostsText}
          placeholder={t("workflows.script.hostsPlaceholder")}
          onChange={(event) => {
            setHostsText(event.target.value);
            onTextChange(
              stringify(
                withScript(definition, {
                  source: script.source,
                  hosts: parseHosts(event.target.value),
                }),
              ),
            );
          }}
        />
      </label>
      <p className="-mt-2 text-xs text-muted">{t("workflows.script.hostsHint")}</p>
      <ScriptEditor
        label={t("workflows.script.editorLabel")}
        value={script.source}
        onChange={(source) =>
          onTextChange(stringify(withScript(definition, { source, hosts: script.hosts })))
        }
      />
      <details className="text-xs text-muted">
        <summary className="cursor-pointer">{t("workflows.script.reference")}</summary>
        <pre className="mt-2 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-text">
          {CTX_DTS}
        </pre>
      </details>
      <div>
        <ConfirmButton
          label={t("workflows.script.remove")}
          confirmLabel={t("workflows.script.removeConfirm")}
          onConfirm={() => onTextChange(stringify(withoutScript(definition)))}
        />
      </div>
    </div>
  );
}
