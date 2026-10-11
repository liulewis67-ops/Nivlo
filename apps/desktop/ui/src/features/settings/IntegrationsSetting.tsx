import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ConfirmButton, Input } from "@/components";
import { ipc } from "@/lib/ipc";
import type { IntegrationConnectionDto, IntegrationTestDto } from "@/lib/ipc";
import { queryKeys } from "@/lib/query-keys";
import { reportError } from "@/lib/report-error";
import { useToastStore } from "@/stores/toast-store";

/** 支持的集成。 */
const INTEGRATIONS = ["github", "jira"] as const;
/** 集成标识。 */
type IntegrationId = (typeof INTEGRATIONS)[number];

/** Jira Cloud 的主机后缀：Cloud 用「邮箱 + API Token」，其他用个人访问令牌。 */
const JIRA_CLOUD_SUFFIX = ".atlassian.net";

/**
 * 填写的 Jira 地址是不是 Cloud。
 *
 * @param address 用户输入的地址。
 * @returns 是 Cloud 时为 `true`。
 */
function isJiraCloud(address: string): boolean {
  return (
    address
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/:?#]/)[0]
      ?.endsWith(JIRA_CLOUD_SUFFIX) === true
  );
}

/** [`ConnectionRow`] 的 Props。 */
type ConnectionRowProps = {
  connection: IntegrationConnectionDto;
  /** 连接状态变化后刷新列表。 */
  onChanged: () => void;
};

/**
 * 一个已连接的账号：显示最近一次测试的结果，提供「测试连接」与「断开」。
 *
 * @param props 连接与刷新回调。
 * @returns 一行。
 */
function ConnectionRow({ connection, onChanged }: ConnectionRowProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntegrationTestDto | null>(null);

  /** 测试连接：区分认证失败、权限不足和网络问题。 */
  function test(): void {
    setBusy(true);
    ipc
      .testIntegration(connection.integration, connection.account)
      .then((outcome) => {
        setResult(outcome);
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  /** 断开：凭据从系统凭据库删除。 */
  function disconnect(): void {
    setBusy(true);
    ipc
      .disconnectIntegration(connection.integration, connection.account)
      .then(() => {
        useToastStore.getState().push("success", t("settings.integrations.disconnected"));
        onChanged();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  }

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium text-text">
          {connection.integration === "github"
            ? t("settings.integrations.githubAccount")
            : connection.account}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={test}>
            {t("settings.integrations.test")}
          </Button>
          <ConfirmButton
            label={t("settings.integrations.disconnect")}
            confirmLabel={t("settings.integrations.disconnectConfirm")}
            onConfirm={disconnect}
          />
        </div>
      </div>
      {result !== null && (
        <p
          role="status"
          className={result.status === "ok" ? "text-xs text-success" : "text-xs text-danger"}
        >
          {t(`settings.integrations.result.${result.status}`, { message: result.message })}
        </p>
      )}
      {result === null && connection.lastError !== null && (
        <p className="text-xs text-danger">
          {t("settings.integrations.lastError", { message: connection.lastError })}
        </p>
      )}
    </li>
  );
}

/** [`ConnectForm`] 的 Props。 */
type ConnectFormProps = {
  integration: IntegrationId;
  onConnected: () => void;
};

/**
 * 连接表单：GitHub 只要令牌；Jira 要地址，Cloud 再要邮箱，其余用个人访问令牌。
 *
 * 令牌只会被写入系统凭据库，提交后输入框立即清空，界面之后也读不回它。
 *
 * @param props 集成与成功回调。
 * @returns 表单。
 */
function ConnectForm({ integration, onConnected }: ConnectFormProps) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const cloud = integration === "jira" && isJiraCloud(address);
  const ready =
    token.trim() !== "" &&
    (integration === "github" || address.trim() !== "") &&
    (!cloud || email.trim() !== "");

  /** 提交：Jira Cloud 把邮箱与令牌拼成后端约定的「邮箱:API Token」。 */
  function submit(): void {
    setBusy(true);
    const secret = cloud ? `${email.trim()}:${token.trim()}` : token.trim();
    ipc
      .connectIntegration(integration, address, secret)
      .then(() => {
        setAddress("");
        setEmail("");
        setToken("");
        useToastStore.getState().push("success", t("settings.integrations.connected"));
        onConnected();
      })
      .catch((error: unknown) => {
        reportError(error);
        // 失败也不保留令牌在输入框里。
        setToken("");
      })
      .finally(() => setBusy(false));
  }

  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) submit();
      }}
    >
      {integration === "jira" && (
        <Input
          aria-label={t("settings.integrations.jiraAddress")}
          placeholder={t("settings.integrations.jiraAddressPlaceholder")}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
      )}
      {cloud && (
        <Input
          aria-label={t("settings.integrations.email")}
          placeholder={t("settings.integrations.emailPlaceholder")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      )}
      <Input
        type="password"
        autoComplete="off"
        aria-label={t(`settings.integrations.token.${cloud ? "apiToken" : integration}`)}
        placeholder={t(`settings.integrations.token.${cloud ? "apiToken" : integration}`)}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <p className="text-xs text-muted">{t(`settings.integrations.help.${integration}`)}</p>
      <div>
        <Button size="sm" type="submit" disabled={!ready || busy}>
          {t("settings.integrations.connect")}
        </Button>
      </div>
    </form>
  );
}

/**
 * 设置页的「集成」区块：连接 / 测试连接 / 断开 GitHub 与 Jira，并显示连接状态与最近一次错误。
 *
 * @returns 区块内容（由设置页放进分组容器）。
 */
export function IntegrationsSetting() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: queryKeys.integrations(),
    queryFn: () => ipc.listIntegrations(),
    staleTime: Infinity,
  });
  /** 重新读取连接列表。 */
  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.integrations() });
  }

  return (
    <>
      {INTEGRATIONS.map((integration) => {
        const mine = (connections.data ?? []).filter((c) => c.integration === integration);
        // GitHub 只有一个账号：已连接就不再显示连接表单（要换令牌先断开）。
        const showForm = integration === "jira" || mine.length === 0;
        return (
          <div
            key={integration}
            aria-label={t(`settings.integrations.name.${integration}`)}
            role="group"
          >
            <div className="px-4 pt-3.5">
              <p className="text-sm font-semibold text-text">
                {t(`settings.integrations.name.${integration}`)}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {mine.length === 0
                  ? t("settings.integrations.notConnected")
                  : t("settings.integrations.connectedCount", { count: mine.length })}
              </p>
            </div>
            {mine.length > 0 && (
              <ul aria-label={t(`settings.integrations.name.${integration}`)} className="mt-1">
                {mine.map((connection) => (
                  <ConnectionRow
                    key={`${connection.integration}:${connection.account}`}
                    connection={connection}
                    onChanged={refresh}
                  />
                ))}
              </ul>
            )}
            {showForm && <ConnectForm integration={integration} onConnected={refresh} />}
          </div>
        );
      })}
    </>
  );
}
