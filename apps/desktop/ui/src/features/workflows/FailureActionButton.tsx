import { useTranslation } from "react-i18next";
import { Button } from "@/components";
import { useNavStore } from "@/features/shell";

/** [`FailureActionButton`] 的 Props。 */
type FailureActionButtonProps = {
  /** 后端给出的动作编码，如 `OPEN_INTEGRATION_SETTINGS:jira`；没有动作时为 `null`。 */
  action: string | null;
};

/** 动作前缀：打开集成设置。 */
const OPEN_INTEGRATION_SETTINGS = "OPEN_INTEGRATION_SETTINGS:";

/**
 * 运行失败后的「下一步」按钮：缺少集成连接 / 连接失效时，提供跳到设置页的入口，
 * 用户看到的是「需要连接 X」加一个按钮，而不是 HTTP 错误堆栈。
 *
 * @param props 动作编码。
 * @returns 按钮；动作不认识或没有动作时返回 `null`。
 */
export function FailureActionButton({ action }: FailureActionButtonProps) {
  const { t } = useTranslation();
  const setView = useNavStore((state) => state.setView);
  if (action === null || !action.startsWith(OPEN_INTEGRATION_SETTINGS)) return null;
  const integration = action.slice(OPEN_INTEGRATION_SETTINGS.length);
  return (
    <Button size="sm" variant="secondary" onClick={() => setView("settings")}>
      {t("workflows.action.openIntegrationSettings", { name: integration })}
    </Button>
  );
}
